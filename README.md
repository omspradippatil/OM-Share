# OmShare

**Peer-to-peer file transfer with no size limits. No sign-up, no server storage.**

<p align="center">
  <img src="icon-192.svg" width="64" alt="OmShare Logo">
</p>

OmShare enables fast, direct, and end-to-end encrypted browser-to-browser file transfers using **WebRTC DataChannels**, backed by **Firebase Firestore** for primary real-time signaling and an **AJAX Serverless REST API** for automatic offline/network fallback.

---

## Quick Start

1. **Sender**: Select any file → Click **Generate Code** → Share the 6-digit code.
2. **Receiver**: Enter the 6-digit code → Click **Connect** → The file streams directly and downloads automatically.

---

## Project Structure

```
OM-Share/
├── js/
│   ├── env-config.js     # Auto-generated runtime environment config (from .env.local / build)
│   ├── config.js         # Configuration loader, STUN/TURN parsing & credential validation
│   ├── ajax.js           # Resilient AJAX utility (retries, timeouts, ping, Firebase health check)
│   ├── signaling.js      # Hybrid Signaling Manager (Firebase Firestore + AJAX Fallback)
│   ├── webrtc.js         # WebRTC DataChannel engine, 64KB chunking & backpressure flow control
│   └── app.js            # UI controller, drag & drop, progress speed calculation & toasts
├── functions/
│   └── signaling.js      # Netlify serverless function for fallback AJAX signaling
├── test/
│   ├── ajax.test.js      # Unit tests for HTTP helpers and latency ping
│   ├── config.test.js    # Unit tests for config manager & credential detection
│   ├── functions.test.js # Unit tests for serverless signaling lifecycle
│   └── webrtc.test.js    # Unit tests for chunking calculations & 6-digit code generators
├── index.html            # Main transfer application interface
├── how-it-works.html     # Architecture and guide page
├── privacy.html          # Privacy policy
├── terms.html            # Terms of service
├── css/
│   └── styles.css        # Responsive design system & creator layout
├── inject-env.js         # Build script that generates js/env-config.js
├── netlify.toml          # Netlify routing, headers, CSP, and function configuration
├── firestore.rules       # Firebase Firestore security rules
├── firebase.json         # Firebase hosting and index settings
├── package.json          # Project scripts and dependencies
└── README.md             # Project documentation
```

---

## Architecture & How Signaling Works

```
                        ┌───────────────────────────────┐
                        │      Signaling Layer          │
                        │                               │
                        │  1. Primary: Firebase Firestore│
                        │  2. Fallback: AJAX REST API   │
                        └───────┬───────────────┬───────┘
                                │               │
                        (Offers/Answers) (Offers/Answers)
                                │               │
                        ┌───────▼───────┐┌──────▼───────┐
                        │  Sender Peer  ││Receiver Peer │
                        └───────┬───────┘└──────┬───────┘
                                │               │
                                └─── WebRTC ────┘
                              (Direct P2P Stream)
```

1. **Signaling**: Only used to exchange metadata, WebRTC SDP offers/answers, and ICE candidate connection routes.
2. **Automatic AJAX Fallback**: If Firebase is blocked by CSP, offline, or experiencing network timeout, the application automatically fails over to the AJAX REST signaling layer (`/.netlify/functions/signaling`).
3. **Data Transfer**: 100% Peer-to-Peer via WebRTC `RTCDataChannel`. Files are streamed in 64KB chunks directly between browsers—never touching any backend server.

---

## Fixing the "Failed to get document because the client is offline" Error

If you encountered `Failed to get document because the client is offline`, this repository includes complete fixes for all 4 root causes:

1. **Content Security Policy (CSP)**: `netlify.toml` and `seo.config.json` now include `https://firestore.googleapis.com`, `https://*.googleapis.com`, and `wss://*.firebaseio.com` in `connect-src`.
2. **Configuration Loader**: `inject-env.js` reads `.env.local`, `.env`, and Netlify environment variables (supporting both `FIREBASE_*` and `VITE_FIREBASE_*`), generating `js/env-config.js`.
3. **Graceful Error Recovery & AJAX Fallback**: `js/signaling.js` detects offline/unreachable Firestore states and seamlessly falls back to the serverless AJAX signaling endpoint.
4. **Firestore Rules**: `firestore.rules` allows reads and writes for ephemeral transfer signaling and rate limit records.

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
# Copy .env.example to .env.local and add your Firebase credentials
cp .env.example .env.local

# 3. Build environment configuration & start development server
npm run dev

# 4. Run automated test suite
npm test
```

---

## Production Deployment (Netlify)

1. Connect your repository to Netlify.
2. Under **Site Settings → Environment Variables**, add your Firebase keys:
   - `FIREBASE_API_KEY`
   - `FIREBASE_AUTH_DOMAIN`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_STORAGE_BUCKET`
   - `FIREBASE_MESSAGING_SENDER_ID`
   - `FIREBASE_APP_ID`
   - `FIREBASE_MEASUREMENT_ID`
3. Netlify automatically runs `node inject-env.js` during build as configured in `netlify.toml`.

---

## Security

- **End-to-End Encrypted**: WebRTC DataChannels are encrypted by default with DTLS (Datagram Transport Layer Security).
- **Ephemeral Storage**: Signaling sessions and transfer codes expire automatically after 24 hours.
- **Zero Server Storage**: Files never upload to any server or cloud database.

---

## License

MIT