# MiloCam - Tapo C120 WebRTC Streamer

MiloCam is a high-performance RTSP to WebRTC bridge specifically optimized for Tapo C120 cameras. It allows for low-latency video and audio streaming directly to modern web browsers without the need for plugins.

## Features

- **Low Latency**: Uses WebRTC for near-real-time streaming.
- **Multi-Client Support**: Broadcasts a single RTSP stream to multiple concurrent WebRTC viewers.
- **Robust Connection Handling**: Optimized state machine to handle Tapo-specific RTSP quirks (e.g., 400 Bad Request on redundant DESCRIBE calls).
- **Audio Support**: Supports G.711 PCMA/PCMU audio tracks.
- **Enhanced Debugging**: Centralized logging system with a toggleable global `DEBUG` flag.
- **Graceful Recovery**: Automatically attempts to reconnect to the RTSP source on connection loss.

## Architecture

1.  **RTSP Client**: Connects to the camera using the `yellowstone` library. A custom monkey patch is applied to support interleaved TCP channels beyond the standard video/RTCP pair.
2.  **WebRTC Bridge**: Uses `werift` to manage peer connections and media tracks. RTP packets from the RTSP stream are rewritten with consistent SSRCs and broadcasted to all active WebRTC clients.
3.  **Signaling Server**: An Express server with `ws` (WebSockets) handles the WebRTC handshake (Offer/Answer/ICE).
4.  **Frontend**: A simple, modern HTML5 interface with optimized track handling and autoplay workarounds.

## Setup

### Prerequisites

- Node.js (v18 or higher)
- A Tapo C120 camera (or any RTSP-compatible camera)

### Installation

1.  Clone the repository.
2.  Install dependencies:
    ```bash
    npm install
    ```

### Configuration

Set the `RTSP_URL` environment variable to your camera's stream URL:
```bash
export RTSP_URL='rtsp://username:password@camera-ip:554/stream1'
```

To enable verbose logging:
```bash
export DEBUG=true
```

### Running the Server

Start the server using `tsx`:
```bash
npx tsx server.ts
```

The application will be available at `http://localhost:3000`.

## Advanced Debugging

The project includes a centralized `logger.ts` that prefixes logs with `[INFO]`, `[DEBUG]`, `[WARN]`, or `[ERROR]`. Frontend diagnostics can be viewed in the browser console, including WebRTC connection states and ICE gathering progress.
