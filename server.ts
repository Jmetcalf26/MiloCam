/**
 * MiloCam Server
 * Handles RTSP streaming from Tapo cameras and broadcasts via WebRTC.
 * Supports multiple concurrent viewers and robust error handling.
 */
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
import { logger } from './logger.js';

/**
 * Global Error Handlers
 * Prevents the Node.js process from exiting due to unhandled promises or errors.
 */
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const require = createRequire(import.meta.url);
const { parseRTPPacket, parseRTCPPacket } = require('yellowstone/dist/util');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const RTSP_URL = process.env.RTSP_URL || 'rtsp://192.168.1.205:554/stream1';
logger.info(`Starting MiloCam with URL: ${RTSP_URL}`);

/**
 * Session tracking for multiple concurrent WebRTC clients.
 * Each client receives their own set of MediaStreamTracks.
 */
interface Session {
  pc: RTCPeerConnection;
  videoTrack: MediaStreamTrack;
  audioTrack: MediaStreamTrack;
  ws: WebSocket;
}

const sessions = new Set<Session>();

/**
 * Broadcasts an RTP packet to all active WebRTC sessions.
 * Note: Each packet is written to a unique track instance per client.
 * @param packet The raw RTP packet buffer.
 * @param kind The track type ('video' or 'audio').
 */
function broadcastRtp(packet: Buffer, kind: 'video' | 'audio') {
  for (const session of sessions) {
    try {
      if (kind === 'video') {
        session.videoTrack.writeRtp(packet);
      } else {
        session.audioTrack.writeRtp(packet);
      }
    } catch (err) {
      // Failure to write usually means track/session is closed.
    }
  }
}

const client = new RTSPClient("Jackmetcalf", "Badabing!!1234", {});

/**
 * Monkey patch Yellowstone's _onData to support interleaved TCP channels
 * higher than 0-1 (specifically required for Tapo audio on 2-3).
 * This also ensures RTSP session IDs (strings) are not converted to Numbers.
 */
(client as any)._onData = function(data: Buffer) {
  const self = this as any;
  let index = 0;
  const PACKET_START = 0x24; // '$'
  const RTSP_HEADER_START = 0x52; // 'R'

  while (index < data.length) {
    // Check for interleaved RTP/RTCP packet ($)
    if (self.readState == 0 && data[index] == PACKET_START) {
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
          // Emit the raw buffer to allow broadcasting original packets with minimal overhead
          self.emit("data", packetChannel, packet.payload, packet, Buffer.from(self.rtspPacket));
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
      // Check for RTSP Response header (starts with 'R' for 'RTSP/1.0')
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
            self.rtspContentLength = 0;
            lines.forEach((line: string) => {
              const indexOf = line.indexOf(":");
              if (indexOf != -1) {
                const key = line.substring(0, indexOf).trim();
                const dataStr = line.substring(indexOf + 1).trim();
                // CRITICAL: Ensure 'Session' string is not converted to Number
                self.rtspHeaders[key] = (key !== "Session" && !isNaN(Number(dataStr))) ? Number(dataStr) : dataStr;
                if (key.toLowerCase() === "content-length") {
                  self.rtspContentLength = Number(dataStr);
                }
              }
            });
            if (self.rtspContentLength > 0) {
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

// Global RTSP state
let h264Parameters = 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1';
let audioChannel = -1;
let videoChannel = 0;
let audioPayloadType = 8; // Default PCMA

/**
 * Initial connection and media track negotiation.
 */
async function startRtsp() {
  try {
    logger.info(`[RTSP] Attempting to connect to: ${RTSP_URL}`);
    
    const connectionTimeout = setTimeout(() => {
      logger.error('[RTSP] Connection attempt timed out');
    }, 10000);

    // Initial connect establishes the first track and session
    const details = await client.connect(RTSP_URL, { keepAlive: true, connection: 'tcp' });
    clearTimeout(connectionTimeout);
    
    logger.info('[RTSP] Connection established. Detecting tracks...');

    let describeSuccess = false;
    try {
        // Attempt a DESCRIBE to find ALL media tracks (audio and video)
        const describeRes = await client.request("DESCRIBE", { Accept: "application/sdp" }, RTSP_URL);
        if (describeRes && describeRes.mediaHeaders) {
            describeSuccess = true;
            const sdp = describeRes.mediaHeaders.join("\r\n");
            const parsedSdp = sdpTransform.parse(sdp);
            logger.info('[RTSP] SDP metadata received. Total media tracks:', parsedSdp.media.length);
            
            let interleavedCount = 0; 
            for (const media of parsedSdp.media) {
                if (media.type === 'audio') {
                    audioChannel = interleavedCount;
                    const codec = media.rtp && media.rtp[0] && media.rtp[0].codec;
                    if (codec === 'PCMU') audioPayloadType = 0;
                    else if (codec === 'PCMA') audioPayloadType = 8;
                    
                    const control = media.control || `track${interleavedCount/2 + 1}`;
                    let setupUrl;
                    if (control.startsWith('rtsp://') || control.startsWith('rtsps://')) {
                        setupUrl = control;
                    } else {
                        const baseUrl = RTSP_URL.endsWith('/') ? RTSP_URL : `${RTSP_URL}/`;
                        setupUrl = control.startsWith('/') ? `${baseUrl}${control.substring(1)}` : `${baseUrl}${control}`;
                    }

                    logger.info(`[RTSP] Setting up audio track: ${setupUrl} on interleaved ${audioChannel}-${audioChannel+1}`);
                    
                    await client.request("SETUP", { 
                        Transport: `RTP/AVP/TCP;interleaved=${audioChannel}-${audioChannel+1}`,
                        Session: (client as any)._session
                    }, setupUrl);
                } else if (media.type === 'video') {
                    videoChannel = interleavedCount;
                }
                interleavedCount += 2;
            }
        }
    } catch (describeErr: any) {
        logger.warn(`[RTSP] Auxiliary DESCRIBE failed. This is expected on some firmwares.`);
    }

    // Blind fallback if DESCRIBE fails but we need audio
    if (!describeSuccess && audioChannel === -1) {
        logger.info('[RTSP] Attempting blind audio SETUP for track2 on interleaved 2-3');
        try {
            const baseUrl = RTSP_URL.endsWith('/') ? RTSP_URL : `${RTSP_URL}/`;
            const setupUrl = `${baseUrl}track2`;
            await client.request("SETUP", { 
                Transport: `RTP/AVP/TCP;interleaved=2-3`,
                Session: (client as any)._session
            }, setupUrl);
            audioChannel = 2;
            audioPayloadType = 8;
            logger.info('[RTSP] Blind audio SETUP successful');
        } catch (e) {
            logger.warn('[RTSP] Blind audio SETUP failed');
        }
    }

    await client.play();
    logger.info('[RTSP] PLAY command sent successfully');
  } catch (err: any) {
    logger.error('[RTSP] Main Connection Error:', err.message || err);
    logger.info('[RTSP] Retrying in 5 seconds...');
    setTimeout(startRtsp, 5000);
  }
}

let packetCount = 0;
let audioPacketCount = 0;
const VIDEO_SSRC = 0x12345678; // Hardcoded SSRCs to simplify browser decoding
const AUDIO_SSRC = 0x12345679;

let lastAudioTime = 0;

/**
 * RTP Data Processing
 * Receives interleaved packets from Yellowstone and broadcasts to WebRTC sessions.
 */
client.on('data', (channel: number, payload: Buffer, packet: any, raw?: Buffer) => {
  packetCount++;
  
  if (channel === audioChannel) {
      audioPacketCount++;
      if (audioPacketCount % 50 === 0) {
          const now = Date.now();
          const interval = lastAudioTime ? now - lastAudioTime : 0;
          lastAudioTime = now;
          const incomingPT = raw ? (raw[1] & 0x7f) : 'unknown';
          logger.info(`[RTSP-Audio] Interval: ${interval}ms, TS: ${packet.timestamp}`);
      }
      
      if (raw) {
          const packetCopy = Buffer.from(raw);
          packetCopy[1] = (packetCopy[1] & 0x80) | (audioPayloadType & 0x7f);
          packetCopy.writeUInt32BE(AUDIO_SSRC, 8);
          broadcastRtp(packetCopy, 'audio');
      }
  } else if (channel === videoChannel) {
      if (raw) {
          const packetCopy = Buffer.from(raw);
          packetCopy[1] = (packetCopy[1] & 0x80) | (96 & 0x7f);
          packetCopy.writeUInt32BE(VIDEO_SSRC, 8);
          broadcastRtp(packetCopy, 'video');
      } else {
          // Construct header manually if raw buffer missing
          const rtpHeader = Buffer.alloc(12);
          rtpHeader[0] = (2 << 6); 
          rtpHeader[1] = (96 & 0x7f) | (packet.marker ? 0x80 : 0);
          rtpHeader.writeUInt16BE(packet.id || 0, 2);
          rtpHeader.writeUInt32BE(packet.timestamp || 0, 4);
          rtpHeader.writeUInt32BE(VIDEO_SSRC, 8);
          const fullPacket = Buffer.concat([rtpHeader, payload]);
          broadcastRtp(fullPacket, 'video');
      }
  }

  if (packetCount % 500 === 0) {
    if (sessions.size > 0) {
        logger.debug(`[WebRTC] Broadcasted total packets: ${packetCount}`);
    }
  }
});

client.on('error', (err) => {
  logger.error('[RTSP] Runtime Client Error:', err);
});

client.on('close', () => {
  logger.info('[RTSP] Connection closed by source. Reconnecting...');
  setTimeout(startRtsp, 5000);
});

/**
 * WebSocket Connection Handler
 * Handles WebRTC signaling (offers, answers, candidates).
 */
wss.on('connection', async (ws: WebSocket) => {
  logger.info('[WS] New client connected');

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

  // Create tracks for this specific client
  const videoTrack = new MediaStreamTrack({ kind: 'video' });
  const audioTrack = new MediaStreamTrack({ kind: 'audio' });

  // Map SSRCs to match values used in broadcastRtp
  (videoTrack as any).ssrc = VIDEO_SSRC;
  (audioTrack as any).ssrc = AUDIO_SSRC;

  pc.addTrack(videoTrack);
  pc.addTrack(audioTrack);

  const session: Session = { pc, videoTrack, audioTrack, ws };
  sessions.add(session);

  if (pc.connectionStateChange) {
    pc.connectionStateChange.subscribe((state) => {
      logger.info(`[WebRTC] Peer connection state: ${state}`);
    });
  }

  if (pc.iceConnectionStateChange) {
    pc.iceConnectionStateChange.subscribe((state) => {
      logger.info(`[WebRTC] ICE connection state: ${state}`);
    });
  }

  if (pc.onIceCandidate) {
    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        ws.send(JSON.stringify({ type: 'candidate', candidate }));
      }
    });
  }

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'offer') {
        logger.info('[WebRTC] Handling offer...');
        await pc.setRemoteDescription(message.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', answer }));
      } else if (message.type === 'candidate') {
        await pc.addIceCandidate(message.candidate);
      }
    } catch (e) {
      logger.error('[WS] Signaling error:', e);
    }
  });

  ws.on('close', () => {
    logger.info('[WS] Client disconnected');
    sessions.delete(session);
    pc.close();
  });

});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`HTTP Server running at http://localhost:${PORT}`);
  startRtsp();
});
