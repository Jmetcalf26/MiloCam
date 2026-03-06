import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { RTSPClient } from 'yellowstone';
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  MediaStreamTrack,
} from 'werift';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sdpTransform from 'sdp-transform';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseRTPPacket, parseRTCPPacket } = require('yellowstone/dist/util');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const RTSP_URL = process.env.RTSP_URL || 'rtsp://192.168.1.205:554/stream1';
console.log(`${RTSP_URL}`)

const videoTrack = new MediaStreamTrack({ kind: 'video' });
const audioTrack = new MediaStreamTrack({ kind: 'audio' });

const client = new RTSPClient("Jackmetcalf", "Badabing!!1234", {});

// Monkey patch _onData to support multiple channels
// This is cleaner than inheriting and reimplementing the whole parser
(client as any)._onData = function(data: Buffer) {
  const self = this as any;
  let index = 0;
  const PACKET_START = 0x24;
  const RTSP_HEADER_START = 0x52;

  while (index < data.length) {
    if (self.readState == 0 && data[index] == PACKET_START) { // SEARCHING
      self.messageBytes = [data[index]];
      index++;
      self.readState = 3; // READING_RAW_PACKET_SIZE
    }
    else if (self.readState == 3) {
      self.messageBytes.push(data[index]);
      index++;
      if (self.messageBytes.length == 4) {
        self.rtspPacketLength = (self.messageBytes[2] << 8) + self.messageBytes[3];
        if (self.rtspPacketLength > 0) {
          self.rtspPacket = Buffer.alloc(self.rtspPacketLength);
          self.rtspPacketPointer = 0;
          self.readState = 4; // READING_RAW_PACKET
        }
        else {
          self.readState = 0;
        }
      }
    }
    else if (self.readState == 4) {
      self.rtspPacket[self.rtspPacketPointer++] = data[index];
      index++;
      if (self.rtspPacketPointer == self.rtspPacketLength) {
        const packetChannel = self.messageBytes[1];
        if (packetChannel % 2 === 0) {
          const packet = parseRTPPacket(self.rtspPacket);
          self.emit("data", packetChannel, packet.payload, packet);
        }
        else {
          const packet = parseRTCPPacket(self.rtspPacket);
          self.emit("controlData", packetChannel, packet);
          const receiver_report = self._emptyReceiverReport();
          self._sendInterleavedData(packetChannel, receiver_report);
        }
        self.readState = 0;
      }
    }
    else {
      if (self.readState == 0 && data[index] == RTSP_HEADER_START) {
        self.messageBytes = [data[index]];
        index++;
        self.readState = 1; // READING_RTSP_HEADER
      }
      else if (self.readState == 1) {
        if (data[index] != 13) self.messageBytes.push(data[index]);
        index++;
        const len = self.messageBytes.length;
        if (len > 1 && self.messageBytes[len - 1] == 10 && self.messageBytes[len - 2] == 10) {
          const msg = Buffer.from(self.messageBytes).toString('utf8');
          const lines = msg.split("\n");
          if (lines.length > 0) {
            self.rtspStatusLine = lines[0];
            self.rtspHeaders = {};
            lines.forEach((line: string) => {
              const indexOf = line.indexOf(":");
              if (indexOf != -1) {
                const key = line.substring(0, indexOf).trim();
                const dataStr = line.substring(indexOf + 1).trim();
                self.rtspHeaders[key] = (isNaN(Number(dataStr))) ? dataStr : Number(dataStr);
              }
            });
            if (self.rtspHeaders["Content-Length"]) {
              self.rtspContentLength = self.rtspHeaders["Content-Length"];
              self.readState = 2; // READING_RTSP_PAYLOAD
              self.messageBytes = [];
            }
            else {
              self.emit("response", self.rtspStatusLine, self.rtspHeaders, []);
              self.readState = 0;
            }
          }
        }
      }
      else if (self.readState == 2) {
        self.messageBytes.push(data[index]);
        index++;
        if (self.messageBytes.length == self.rtspContentLength) {
          const body = Buffer.from(self.messageBytes).toString('utf8');
          const mediaHeaders = body.split(/\r?\n/).filter(line => line.length > 0);
          self.emit("response", self.rtspStatusLine, self.rtspHeaders, mediaHeaders);
          self.readState = 0;
        }
      } else {
        index++;
      }
    }
  }
};

let h264Parameters = 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1';
let audioChannel = -1;
let videoChannel = 0;
let audioPayloadType = 8; // Default to PCMA

async function startRtsp() {
  try {
    console.log(`[RTSP] Attempting to connect to: ${RTSP_URL}`);
    
    const connectionTimeout = setTimeout(() => {
      console.error('[RTSP] Connection attempt timed out');
    }, 10000);

    const details = await client.connect(RTSP_URL, { keepAlive: true, connection: 'tcp' });
    clearTimeout(connectionTimeout);
    
    console.log('[RTSP] Connected. Media details:', JSON.stringify(details, null, 2));

    // Use original RTSP_URL to avoid 400 error on already-set-up tracks
    const describeRes = await client.request("DESCRIBE", { Accept: "application/sdp" }, RTSP_URL);
    if (describeRes && describeRes.mediaHeaders) {
        const sdp = describeRes.mediaHeaders.join("\r\n");
        const parsedSdp = sdpTransform.parse(sdp);
        console.log('[RTSP] Parsed SDP Media tracks:', parsedSdp.media.length);
        
        let interleavedCount = 2; 
        for (const media of parsedSdp.media) {
            if (media.type === 'audio') {
                const codec = media.rtp && media.rtp[0] && media.rtp[0].codec;
                console.log(`[RTSP] Found audio track with codec: ${codec}`);
                
                if (codec === 'PCMU') audioPayloadType = 0;
                else if (codec === 'PCMA') audioPayloadType = 8;
                
                if (media.protocol === 'RTP/AVP/TCP' || media.protocol === 'RTP/AVP') {
                    const control = media.control || 'track2';
                    let setupUrl;
                    if (control.startsWith('rtsp://') || control.startsWith('rtsps://')) {
                        setupUrl = control;
                    } else {
                        const baseUrl = RTSP_URL.endsWith('/') ? RTSP_URL : `${RTSP_URL}/`;
                        setupUrl = control.startsWith('/') ? `${baseUrl}${control.substring(1)}` : `${baseUrl}${control}`;
                    }

                    console.log(`[RTSP] Setting up audio track: ${setupUrl} on interleaved ${interleavedCount}-${interleavedCount+1}`);
                    
                    await client.request("SETUP", { 
                        Transport: `RTP/AVP/TCP;interleaved=${interleavedCount}-${interleavedCount+1}`,
                        Session: (client as any)._session
                    }, setupUrl);
                    
                    audioChannel = interleavedCount;
                    interleavedCount += 2;
                }
            } else if (media.type === 'video') {
                videoChannel = 0;
            }
        }
    }
    
    if (details.mediaSource && details.mediaSource.fmtp && details.mediaSource.fmtp[0]) {
      const fmtp = details.mediaSource.fmtp[0];
      if (fmtp.config) {
        h264Parameters = fmtp.config;
        console.log(`[WebRTC] Using H264 parameters from RTSP: ${h264Parameters}`);
      }
    }

    client.play();
    console.log('[RTSP] Play command sent');
  } catch (err: any) {
    console.error('[RTSP] Connection Error:', err.message || err);
    console.log('[RTSP] Retrying in 5 seconds...');
    setTimeout(startRtsp, 5000);
  }
}

let packetCount = 0;
client.on('data', (channel: number, payload: Buffer, packet: any) => {
  packetCount++;
  if (packetCount % 500 === 0) {
    console.log(`[RTSP] Received 500 packets (Total: ${packetCount}) - Channel: ${channel}, Timestamp: ${packet.timestamp}`);
  }

  if (channel === videoChannel) {
      const rtpHeader = Buffer.alloc(12);
      rtpHeader[0] = (2 << 6); 
      rtpHeader[1] = (96 & 0x7f) | (packet.marker ? 0x80 : 0);
      rtpHeader.writeUInt16BE(packet.id || 0, 2);
      rtpHeader.writeUInt32BE(packet.timestamp || 0, 4);
      const ssrc = packet.ssrc || 0x12345678;
      rtpHeader.writeUInt32BE(ssrc, 8);
      const fullPacket = Buffer.concat([rtpHeader, payload]);
      try {
        videoTrack.writeRtp(fullPacket);
      } catch (err) {
        console.error('[WebRTC] Error writing video RTP to track:', err);
      }
  } else if (channel === audioChannel) {
      const rtpHeader = Buffer.alloc(12);
      rtpHeader[0] = (2 << 6); 
      rtpHeader[1] = (audioPayloadType & 0x7f) | (packet.marker ? 0x80 : 0);
      rtpHeader.writeUInt16BE(packet.id || 0, 2);
      rtpHeader.writeUInt32BE(packet.timestamp || 0, 4);
      const ssrc = packet.ssrc || 0x12345679;
      rtpHeader.writeUInt32BE(ssrc, 8);
      const fullPacket = Buffer.concat([rtpHeader, payload]);
      try {
        audioTrack.writeRtp(fullPacket);
      } catch (err) {
        console.error('[WebRTC] Error writing audio RTP to track:', err);
      }
  }
});

client.on('error', (err) => {
  console.error('[RTSP] Client Error:', err);
});

client.on('close', () => {
  console.log('[RTSP] Connection closed');
  setTimeout(startRtsp, 5000);
});

wss.on('connection', async (ws: WebSocket) => {
  console.log('[WS] New client connected');

  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: 'video/H264',
          clockRate: 90000,
          payloadType: 96,
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'goog-remb' },
          ],
          parameters: h264Parameters,
        }),
      ],
      audio: [
        new RTCRtpCodecParameters({
          mimeType: 'audio/PCMA',
          clockRate: 8000,
          payloadType: 8,
        }),
        new RTCRtpCodecParameters({
          mimeType: 'audio/PCMU',
          clockRate: 8000,
          payloadType: 0,
        }),
      ],
    },
  });

  pc.addTrack(videoTrack);
  pc.addTrack(audioTrack);

  pc.connectionStateChange.subscribe((state) => {
    console.log(`[WebRTC] Connection state: ${state}`);
  });

  pc.iceConnectionStateChange.subscribe((state) => {
    console.log(`[WebRTC] ICE connection state: ${state}`);
  });

  pc.onIceCandidate.subscribe((candidate) => {
    if (candidate) {
      ws.send(JSON.stringify({ type: 'candidate', candidate }));
    }
  });

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'offer') {
        console.log('[WebRTC] Received offer');
        await pc.setRemoteDescription(message.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', answer }));
        console.log('[WebRTC] Sent answer');
      } else if (message.type === 'candidate') {
        await pc.addIceCandidate(message.candidate);
      }
    } catch (e) {
      console.error('[WS] Error handling message:', e);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    pc.close();
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startRtsp();
});
