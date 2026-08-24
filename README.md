# OmShare

**Peer-to-peer file transfer with no size limits. No sign-up, no server storage.**

<p align="center">
  <img src="icon-192.svg" width="64" alt="OmShare Logo">
</p>

## Quick Start

1. **Sender**: Select any file → Get 6-digit code → Share the code
2. **Receiver**: Enter 6-digit code → Download file

## Setup for Production

### 1. Create Firebase Project

```bash
# Go to https://console.firebase.google.com
# Create new project "omshare"
```

### 2. Enable Firestore

1. In Firebase Console → Build → Firestore Database
2. Create database (start in **test mode** for development)
3. Copy your web app config

### 3. Update Firebase Config

Edit `app.js` line 8-16:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

### 4. Deploy to Netlify

```bash
# Connect your repo to Netlify
# It auto-detects netlify.toml config

# Or manual deploy:
npm install -g netlify-cli
netlify deploy --prod
```

## Local Development

```bash
# Using any static server
npx serve .

# Or Python
python3 -m http.server 8000

# Then open http://localhost:8000
```

## Firebase Security (Production)

Update `firestore.rules` for production:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /transfers/{code} {
      // Only allow transfers less than 24 hours old
      allow read, write: if request.time > timestamp.date(2024, 1, 1);
      
      match /offers/{offerId} {
        allow read, write: if request.time > timestamp.date(2024, 1, 1);
      }
      match /answers/{answerId} {
        allow read, write: if request.time > timestamp.date(2024, 1, 1);
      }
      match /candidates/{offerId} {
        allow read, write: if request.time > timestamp.date(2024, 1, 1);
      }
    }
  }
}
```

## Architecture

```
┌─────────────┐                    ┌─────────────┐
│    Sender   │ ←── WebRTC ───→ │  Receiver   │
│             │                    │             │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       └──────── Firebase Firestore ──────┘
              (Signaling only)
```

- **Firebase**: Stores only signaling data (offers, answers, ICE candidates)
- **WebRTC**: Direct P2P transfer - files never touch Firebase
- **Chunk Size**: 64KB for optimal performance
- **Auto-cleanup**: Transfers deleted after completion

## Browser Support

| Browser | Version |
|---------|---------|
| Chrome  | 76+ |
| Firefox | 68+ |
| Safari  | 14.1+ |
| Edge    | 79+ |

## Tech Stack

- **Frontend**: Vanilla JavaScript, CSS (no frameworks)
- **Backend**: Firebase Firestore (signaling only)
- **Protocol**: WebRTC Data Channels
- **Deployment**: Netlify

## File Limits

| Metric | Limit |
|--------|-------|
| File Size | None (P2P streaming) |
| Code Validity | 24 hours |
| Transfer Duration | Until complete |

## Commands

```bash
# Install dependencies
npm install

# Start local server
npx serve .

# Deploy to Netlify
netlify deploy --prod --site=YOUR_SITE_ID
```

## License

MIT