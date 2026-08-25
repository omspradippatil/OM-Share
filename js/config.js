/**
 * OmShare - Configuration Manager
 * Centralizes application settings, environment resolution, and Firebase validation.
 */

(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OmConfig = factory();
  }
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  function getEnvVar(key) {
    if (typeof window !== 'undefined') {
      if (window.__OMSHARE_ENV__ && window.__OMSHARE_ENV__[key]) {
        return window.__OMSHARE_ENV__[key];
      }
      if (window[key]) {
        return window[key];
      }
    }
    if (typeof process !== 'undefined' && process.env) {
      return process.env[key] || process.env['VITE_' + key] || '';
    }
    return '';
  }

  const defaultIceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.services.mozilla.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    // OpenRelay Public TURN servers for universal NAT & firewall traversal
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelay',
      credential: 'openrelay'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelay',
      credential: 'openrelay'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelay',
      credential: 'openrelay'
    }
  ];

  const customStuns = (getEnvVar('STUN_SERVERS') || '')
    .split(',')
    .map(url => url.trim())
    .filter(Boolean)
    .map(url => ({ urls: url }));

  const customTurns = (getEnvVar('TURN_SERVERS') || '')
    .split(',')
    .map(url => url.trim())
    .filter(Boolean)
    .map(url => ({ urls: url }));

  // Merge custom STUN and TURN with high-availability fallbacks
  const iceServers = [
    ...(customStuns.length > 0 ? customStuns : [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]),
    ...(customTurns.length > 0 ? customTurns : [
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelay',
        credential: 'openrelay'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelay',
        credential: 'openrelay'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelay',
        credential: 'openrelay'
      }
    ])
  ];

  const firebaseConfig = {
    apiKey: getEnvVar('FIREBASE_API_KEY'),
    authDomain: getEnvVar('FIREBASE_AUTH_DOMAIN'),
    projectId: getEnvVar('FIREBASE_PROJECT_ID'),
    storageBucket: getEnvVar('FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: getEnvVar('FIREBASE_MESSAGING_SENDER_ID'),
    appId: getEnvVar('FIREBASE_APP_ID'),
    measurementId: getEnvVar('FIREBASE_MEASUREMENT_ID')
  };

  /**
   * Checks if Firebase is configured with real credentials (not placeholders)
   */
  function isFirebaseConfigured() {
    const key = firebaseConfig.apiKey;
    const proj = firebaseConfig.projectId;
    if (!key || !proj) return false;
    if (key.includes('YOUR_API_KEY') || proj.includes('YOUR_PROJECT') || proj.includes('your-project')) {
      return false;
    }
    return true;
  }

  const CONFIG = {
    FIREBASE: firebaseConfig,
    isFirebaseConfigured,

    // WebRTC & Transfer settings
    CHUNK_SIZE: parseInt(getEnvVar('CHUNK_SIZE'), 10) || 65536, // 64KB
    MAX_FILE_SIZE: parseInt(getEnvVar('MAX_FILE_SIZE'), 10) || 10 * 1024 * 1024 * 1024, // 10GB
    CODE_EXPIRY: parseInt(getEnvVar('CODE_EXPIRY'), 10) || 24 * 60 * 60 * 1000, // 24 hours
    MAX_TRANSFER_DURATION: 2 * 60 * 60 * 1000, // 2 hours
    ICE_SERVERS: iceServers.length > 0 ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }],
    RTC_PEER_CONFIG: {
      iceServers: iceServers.length > 0 ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }],
      iceCandidatePoolSize: 5
    },

    // Rate Limiting
    RATE_LIMIT_CODES_PER_HOUR: 10,
    RATE_LIMIT_TRANSFERS_PER_DAY: 50,

    // Cleanup settings
    CLEANUP_AGE_HOURS: 24,
    CLEANUP_INTERVAL: 60 * 60 * 1000,

    // Fallback AJAX signaling endpoint
    SIGNALING_API_URL: getEnvVar('SIGNALING_SERVER_URL') || '/.netlify/functions/signaling'
  };

  return CONFIG;
});
