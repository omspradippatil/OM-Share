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
    // High-Availability Google STUN (IPv4 & IPv6 Dual-Stack Anycast)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Cloudflare STUN
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Twilio Global STUN
    { urls: 'stun:global.stun.twilio.com:3478' },
    // Nextcloud Port 443 STUN (bypasses restrictive network filters)
    { urls: 'stun:stun.nextcloud.com:443' },
    { urls: 'stun:stun.syncthing.net:3478' },
    { urls: 'stun:stun.services.mozilla.com:3478' },

    // OpenRelay Public TURN Relay (UDP, TCP, and TLS on Ports 80 & 443 for Mobile Carrier CGNAT & Symmetric NAT Traversal)
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:80?transport=tcp',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443',
        'turns:openrelay.metered.ca:80'
      ],
      username: 'openrelay',
      credential: 'openrelay'
    },
    {
      urls: [
        'turn:relay.metered.ca:80',
        'turn:relay.metered.ca:80?transport=tcp',
        'turn:relay.metered.ca:443',
        'turn:relay.metered.ca:443?transport=tcp',
        'turns:relay.metered.ca:443?transport=tcp'
      ],
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

  // Crucial: always ensure STUN and multi-transport TURN are merged
  const iceServers = [
    ...(customStuns.length > 0 ? customStuns : [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.nextcloud.com:443' }
    ]),
    ...(customTurns.length > 0 ? customTurns : [
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:80?transport=tcp',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
          'turns:openrelay.metered.ca:443?transport=tcp',
          'turns:openrelay.metered.ca:443',
          'turns:openrelay.metered.ca:80'
        ],
        username: 'openrelay',
        credential: 'openrelay'
      },
      {
        urls: [
          'turn:relay.metered.ca:80',
          'turn:relay.metered.ca:80?transport=tcp',
          'turn:relay.metered.ca:443',
          'turn:relay.metered.ca:443?transport=tcp',
          'turns:relay.metered.ca:443?transport=tcp'
        ],
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
    ICE_SERVERS: iceServers.length > 0 ? iceServers : defaultIceServers,
    RTC_PEER_CONFIG: {
      iceServers: iceServers.length > 0 ? iceServers : defaultIceServers,
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
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
