/**
 * OmShare - Production P2P File Transfer with Firebase + WebRTC
 * Built with Firebase for signaling, WebRTC for direct transfer
 */

(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    // Code settings
    CODE_EXPIRY: 24 * 60 * 60 * 1000, // 24 hours
    MAX_TRANSFER_DURATION: 2 * 60 * 60 * 1000, // 2 hours
    RATE_LIMIT_CODES_PER_HOUR: 10,
    RATE_LIMIT_TRANSFERS_PER_DAY: 50,

    // Transfer settings
    CHUNK_SIZE: 65536, // 64KB
    MAX_FILE_SIZE: 10 * 1024 * 1024 * 1024, // 10GB (optional limit)

    // WebRTC settings
    ICE_SERVERS: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ],

    // Cleanup settings
    CLEANUP_AGE_HOURS: 24,
    CLEANUP_INTERVAL: 60 * 60 * 1000 // 1 hour
  };

  // Firebase Configuration (from Netlify environment variables)
  // On Netlify, these are set as FIREBASE_* env vars and injected at deploy time
  const firebaseConfig = {
    apiKey: window.FIREBASE_API_KEY || "YOUR_API_KEY",
    authDomain: window.FIREBASE_AUTH_DOMAIN || "YOUR_PROJECT.firebaseapp.com",
    projectId: window.FIREBASE_PROJECT_ID || "YOUR_PROJECT_ID",
    storageBucket: window.FIREBASE_STORAGE_BUCKET || "YOUR_PROJECT.appspot.com",
    messagingSenderId: window.FIREBASE_MESSAGING_SENDER_ID || "YOUR_SENDER_ID",
    appId: window.FIREBASE_APP_ID || "YOUR_APP_ID",
    measurementId: window.FIREBASE_MEASUREMENT_ID
  };

  // Initialize Firebase
  let db = null;
  let firebaseInitialized = false;

  try {
    if (typeof firebase !== 'undefined') {
      firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
      firebaseInitialized = true;
      console.log('Firebase initialized');
    }
  } catch (e) {
    console.warn('Firebase not available:', e.message);
  }

  /**
   * Generate a short 6-digit code with rate limiting
   */
  function generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  /**
   * Check rate limiting for an IP address
   */
  async function checkRateLimit(ipAddress) {
    if (!firebaseInitialized) return true;

    const now = Date.now();
    const hourAgo = now - 3600000;
    const dayAgo = now - 86400000;

    // Check codes per hour
    const hourlySnapshot = await db.collection('rate_limits')
      .where('ip', '==', ipAddress)
      .where('type', '==', 'code')
      .where('timestamp', '>', hourAgo)
      .get();

    if (hourlySnapshot.size >= CONFIG.RATE_LIMIT_CODES_PER_HOUR) {
      throw new Error('Rate limit exceeded: Too many codes created in the last hour');
    }

    // Check transfers per day
    const dailySnapshot = await db.collection('rate_limits')
      .where('ip', '==', ipAddress)
      .where('type', '==', 'transfer')
      .where('timestamp', '>', dayAgo)
      .get();

    if (dailySnapshot.size >= CONFIG.RATE_LIMIT_TRANSFERS_PER_DAY) {
      throw new Error('Rate limit exceeded: Too many transfers in the last 24 hours');
    }

    return true;
  }

  /**
   * Get client IP (simplified - in production use proper IP detection)
   */
  function getClientIP() {
    // This is a simplified version
    // In production, use proper IP detection via server-side function
    return 'client-' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Record rate limit usage
   */
  async function recordRateLimit(ipAddress, type) {
    if (!firebaseInitialized) return;

    await db.collection('rate_limits').add({
      ip: ipAddress,
      type: type,
      timestamp: Date.now()
    });
  }

  /**
   * Format file size
   */
  function formatSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Format transfer speed
   */
  function formatSpeed(bytesPerSecond) {
    return formatSize(bytesPerSecond) + '/s';
  }

  /**
   * Show toast notification
   */
  function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast ' + type + ' visible';
    setTimeout(() => {
      toast.classList.remove('visible');
    }, 3000);
  }

  /**
   * Clean up old transfers (run periodically)
   */
  async function cleanupOldTransfers() {
    if (!firebaseInitialized) return;

    const cutoffTime = Date.now() - (CONFIG.CLEANUP_AGE_HOURS * 60 * 60 * 1000);

    const oldTransfers = await db.collection('transfers')
      .where('createdAt', '<', cutoffTime)
      .get();

    const batch = db.batch();
    oldTransfers.forEach(doc => {
      batch.delete(doc.ref);
    });

    try {
      await batch.commit();
      console.log(`Cleaned up ${oldTransfers.size} old transfers`);
    } catch (error) {
      console.error('Cleanup failed:', error);
    }
  }

  /**
   * Connection Manager - Handles Firebase + WebRTC with security
   */
  class SecureConnectionManager {
    constructor() {
      this.peerId = this.generatePeerId();
      this.code = null;
      this.transferId = null;
      this.peerConnection = null;
      this.dataChannel = null;
      this.fileInfo = null;
      this.chunks = [];
      this.receivedChunks = new Map();
      this.isSender = false;
      this.startTime = null;
      this.clientIP = getClientIP();

      this.listeners = new Map();
      this.unsubscribers = [];
    }

    generatePeerId() {
      return 'peer_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    }

    /**
     * Create a new transfer as sender with rate limiting
     */
    async createTransfer(file) {
      if (!firebaseInitialized) {
        throw new Error('Firebase not configured. Please set up Firebase.');
      }

      // Check file size limit
      if (CONFIG.MAX_FILE_SIZE && file.size > CONFIG.MAX_FILE_SIZE) {
        throw new Error(`File too large. Maximum size is ${formatSize(CONFIG.MAX_FILE_SIZE)}`);
      }

      // Check rate limits
      await checkRateLimit(this.clientIP);

      // Generate unique code
      let code;
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts) {
        code = generateCode();
        const existing = await db.collection('transfers').doc(code).get();
        if (!existing.exists) break;
        attempts++;
      }

      if (attempts >= maxAttempts) {
        throw new Error('Could not generate unique code. Please try again.');
      }

      this.code = code;
      this.isSender = true;
      this.startTime = Date.now();

      // Record rate limit
      await recordRateLimit(this.clientIP, 'code');

      // Prepare file chunks
      this.fileInfo = {
        name: file.name,
        size: file.size,
        type: file.type,
        totalChunks: Math.ceil(file.size / CONFIG.CHUNK_SIZE)
      };

      // Read file chunks
      const reader = new FileReader();
      const chunkPromises = [];

      for (let i = 0; i < this.fileInfo.totalChunks; i++) {
        const start = i * CONFIG.CHUNK_SIZE;
        const end = Math.min(start + CONFIG.CHUNK_SIZE, file.size);

        chunkPromises.push(new Promise((resolve) => {
          const slice = file.slice(start, end);
          reader.onload = (e) => {
            resolve(new Uint8Array(e.target.result));
          };
          reader.readAsArrayBuffer(slice);
        }));
      }

      this.chunks = await Promise.all(chunkPromises);

      // Store transfer in Firestore with expiry
      const transferDoc = db.collection('transfers').doc(this.code);
      await transferDoc.set({
        code: this.code,
        senderId: this.peerId,
        fileName: this.fileInfo.name,
        fileSize: this.fileInfo.size,
        fileType: this.fileInfo.type,
        totalChunks: this.fileInfo.totalChunks,
        createdAt: Date.now(),
        expiresAt: Date.now() + CONFIG.CODE_EXPIRY,
        status: 'waiting',
        clientIP: this.clientIP
      });

      // Set auto-delete timeout
      setTimeout(async () => {
        if (this.code && !this.dataChannel) {
          await transferDoc.delete();
        }
      }, CONFIG.CODE_EXPIRY);

      // Set up receiver listener
      const receiverUnsub = transferDoc.onSnapshot(async (snapshot) => {
        const data = snapshot.data();
        if (data && data.receiverId && !this.dataChannel) {
          try {
            await this.connectToPeer(data.receiverId, true);
          } catch (error) {
            console.error('Connection failed:', error);
            this.emit('error', error);
          }
        }
      });

      this.unsubscribers.push(receiverUnsub);

      return this.code;
    }

    /**
     * Join a transfer as receiver
     */
    async joinTransfer(code) {
      if (!firebaseInitialized) {
        throw new Error('Firebase not configured. Please set up Firebase.');
      }

      this.code = code;
      this.isSender = false;
      this.startTime = Date.now();

      const transferDoc = db.collection('transfers').doc(code);
      const doc = await transferDoc.get();

      if (!doc.exists) {
        throw new Error('Transfer not found. The code may have expired.');
      }

      const transferData = doc.data();

      // Check if transfer expired
      if (Date.now() > transferData.expiresAt) {
        await transferDoc.delete();
        throw new Error('Transfer code has expired.');
      }

      if (transferData.status === 'complete') {
        throw new Error('Transfer already complete.');
      }

      if (transferData.status === 'active') {
        throw new Error('Transfer already in progress.');
      }

      // Record rate limit for receiver
      await recordRateLimit(this.clientIP, 'transfer');

      // Register as receiver
      await transferDoc.update({
        receiverId: this.peerId,
        status: 'active',
        receiverIP: this.clientIP,
        receiverJoinedAt: Date.now()
      });

      // Listen for ICE candidates
      const candidatesUnsub = db.collection('transfers')
        .doc(code)
        .collection('candidates')
        .where('to', '==', this.peerId)
        .limit(20) // Limit for safety
        .onSnapshot((snapshot) => {
          snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added') {
              const candidate = change.doc.data();
              try {
                if (this.peerConnection) {
                  await this.peerConnection.addIceCandidate(
                    new RTCIceCandidate(candidate.candidate)
                  );
                }
                change.doc.ref.delete();
              } catch (error) {
                console.warn('Failed to add ICE candidate:', error);
              }
            }
          });
        });

      this.unsubscribers.push(candidatesUnsub);

      // Create WebRTC connection
      this.peerConnection = this.createPeerConnection();
      this.dataChannel = this.peerConnection.createDataChannel('file-transfer', {
        ordered: true,
        maxPacketLifeTime: 30000
      });

      this.setupDataChannel();

      const offer = await this.peerConnection.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false
      });

      await this.peerConnection.setLocalDescription(offer);

      await db.collection('transfers')
        .doc(code)
        .collection('offers')
        .add({
          from: this.peerId,
          sdp: offer.sdp,
          type: offer.type,
          createdAt: Date.now(),
          to: transferData.senderId
        });

      // Listen for answers
      const answerUnsub = db.collection('transfers')
        .doc(code)
        .collection('answers')
        .where('to', '==', this.peerId)
        .limit(1)
        .onSnapshot(async (snapshot) => {
          snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added') {
              const answer = change.doc.data();
              try {
                await this.peerConnection.setRemoteDescription(
                  new RTCSessionDescription({ type: 'answer', sdp: answer.sdp })
                );
                change.doc.ref.delete();
              } catch (error) {
                console.error('Failed to set remote description:', error);
                this.emit('error', error);
              }
            }
          });
        });

      this.unsubscribers.push(answerUnsub);

      // Set transfer timeout
      setTimeout(() => {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
          this.emit('error', new Error('Transfer timeout'));
          this.cleanup();
        }
      }, CONFIG.MAX_TRANSFER_DURATION);

      return {
        name: transferData.fileName,
        size: transferData.fileSize,
        type: transferData.fileType
      };
    }

    /**
     * Create WebRTC peer connection with security settings
     */
    createPeerConnection() {
      const pc = new RTCPeerConnection({
        iceServers: CONFIG.ICE_SERVERS,
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      });

      pc.onicecandidate = (event) => {
        if (event.candidate && this.code) {
          db?.collection('transfers')
            ?.doc(this.code)
            ?.collection('candidates')
            ?.add({
              candidate: event.candidate.toJSON(),
              from: this.peerId,
              createdAt: Date.now()
            });
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log('ICE connection state:', state);

        if (state === 'failed' || state === 'disconnected') {
          this.emit('error', new Error(`Connection ${state}`));
        } else if (state === 'connected') {
          this.emit('connected');
        }
      };

      pc.onsignalingstatechange = () => {
        console.log('Signaling state:', pc.signalingState);
      };

      return pc;
    }

    /**
     * Connect to peer (sender side)
     */
    async connectToPeer(receiverId, isOffer) {
      this.peerConnection = this.createPeerConnection();

      // Listen for data channel (for sender)
      this.peerConnection.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel();
      };

      if (isOffer) {
        this.emit('status', 'Receiver connected, preparing transfer...');

        // Listen for answers from receiver
        const answerUnsub = db.collection('transfers')
          .doc(this.code)
          .collection('answers')
          .where('to', '==', this.peerId)
          .limit(1)
          .onSnapshot(async (snapshot) => {
            snapshot.docChanges().forEach(async (change) => {
              if (change.type === 'added') {
                const answer = change.doc.data();
                try {
                  await this.peerConnection.setRemoteDescription(
                    new RTCSessionDescription({ type: 'answer', sdp: answer.sdp })
                  );
                  change.doc.ref.delete();
                } catch (error) {
                  console.error('Failed to set remote description:', error);
                  this.emit('error', error);
                }
              }
            });
          });

        this.unsubscribers.push(answerUnsub);

      } else {
        // Receiver side - create data channel
        this.dataChannel = this.peerConnection.createDataChannel('file-transfer', {
          ordered: true,
          maxPacketLifeTime: 30000
        });

        this.setupDataChannel();

        const offer = await this.peerConnection.createOffer({
          offerToReceiveVideo: false,
          offerToReceiveAudio: false
        });

        await this.peerConnection.setLocalDescription(offer);

        await db.collection('transfers')
          .doc(this.code)
          .collection('offers')
          .add({
            from: this.peerId,
            sdp: offer.sdp,
            type: offer.type,
            to: receiverId,
            createdAt: Date.now()
          });
      }

      // Set connection timeout
      setTimeout(() => {
        if (this.peerConnection?.iceConnectionState !== 'connected' &&
            this.peerConnection?.iceConnectionState !== 'completed') {
          this.emit('error', new Error('Connection timeout'));
          this.cleanup();
        }
      }, 30000); // 30 second connection timeout
    }

    setupDataChannel() {
      this.dataChannel.onopen = () => {
        console.log('Data channel opened');
        this.emit('connected');
        if (this.isSender) {
          this.startSending();
        }
      };

      this.dataChannel.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      };

      this.dataChannel.onerror = (error) => {
        console.error('Data channel error:', error);
        this.emit('error', error);
      };

      this.dataChannel.onclose = () => {
        console.log('Data channel closed');
        if (this.isSender && this.chunks.length > 0) {
          this.emit('error', new Error('Connection closed during transfer'));
        }
        this.cleanup();
      };
    }

    handleMessage(message) {
      switch (message.type) {
        case 'FILE_METADATA':
          this.fileInfo = message.payload;
          this.emit('file-info', this.fileInfo);
          break;

        case 'FILE_CHUNK':
          const progress = this.processChunk(message.payload);
          this.emit('progress', progress);
          break;

        case 'FILE_COMPLETE':
          this.completeTransfer();
          break;
      }
    }

    processChunk(payload) {
      this.receivedChunks.set(payload.index, payload.data);
      const received = this.receivedChunks.size;
      return {
        received,
        total: this.fileInfo.totalChunks,
        percent: (received / this.fileInfo.totalChunks) * 100
      };
    }

    async completeTransfer() {
      if (this.receivedChunks.size !== this.fileInfo.totalChunks) {
        throw new Error('Incomplete file received');
      }

      const chunks = [];
      for (let i = 0; i < this.fileInfo.totalChunks; i++) {
        chunks.push(this.receivedChunks.get(i));
      }

      const blob = new Blob(chunks, { type: this.fileInfo.type });
      this.downloadFile(blob, this.fileInfo.name);

      // Mark transfer as complete in Firestore
      if (this.code && firebaseInitialized) {
        await db.collection('transfers').doc(this.code).update({
          status: 'complete',
          completedAt: Date.now()
        });
      }

      this.emit('complete');
      this.cleanup();
    }

    downloadFile(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    }

    async startSending() {
      if (!this.fileInfo || !this.chunks.length) {
        throw new Error('File not prepared for sending');
      }

      // Send metadata
      this.dataChannel.send(JSON.stringify({
        type: 'FILE_METADATA',
        payload: this.fileInfo
      }));

      // Send chunks with progress
      for (let i = 0; i < this.chunks.length; i++) {
        if (this.dataChannel.readyState !== 'open') {
          throw new Error('Connection lost during transfer');
        }

        this.dataChannel.send(JSON.stringify({
          type: 'FILE_CHUNK',
          payload: {
            index: i,
            data: this.chunks[i]
          }
        }));

        const progress = {
          sent: i + 1,
          total: this.chunks.length,
          percent: ((i + 1) / this.chunks.length) * 100
        };
        this.emit('progress', progress);

        // Small delay to prevent overwhelming the channel
        await new Promise(r => setTimeout(r, 1));
      }

      // Send completion
      this.dataChannel.send(JSON.stringify({
        type: 'FILE_COMPLETE',
        payload: { id: this.transferId }
      }));

      // Mark as complete
      if (this.code && firebaseInitialized) {
        await db.collection('transfers').doc(this.code).update({
          status: 'complete',
          completedAt: Date.now()
        });
      }

      this.emit('complete');
      this.cleanup();
    }

    cancel() {
      this.cleanup();
      if (this.code && firebaseInitialized) {
        db.collection('transfers').doc(this.code).delete();
      }
    }

    cleanup() {
      this.unsubscribers.forEach(unsub => unsub?.());
      this.unsubscribers = [];
      this.dataChannel?.close();
      this.peerConnection?.close();
      this.dataChannel = null;
      this.peerConnection = null;
    }

    on(event, callback) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, []);
      }
      this.listeners.get(event).push(callback);
    }

    emit(event, data) {
      if (this.listeners.has(event)) {
        this.listeners.get(event).forEach(cb => cb(data));
      }
    }
  }

  /**
   * App Controller
   */
  class OmShareApp {
    constructor() {
      this.connection = new SecureConnectionManager();
      this.currentFile = null;
      this.cleanupInterval = null;

      this.initElements();
      this.bindEvents();
      this.bindConnectionEvents();
      this.startCleanupTimer();
    }

    initElements() {
      // Tabs
      this.tabs = document.querySelectorAll('.tab');
      this.panels = document.querySelectorAll('.panel');

      // Send
      this.dropzone = document.getElementById('dropzone');
      this.fileInput = document.getElementById('file-input');
      this.filePreview = document.getElementById('file-preview');
      this.filenameEl = document.getElementById('filename');
      this.filesizeEl = document.getElementById('filesize');
      this.removeFileBtn = document.getElementById('remove-file');
      this.createCodeBtn = document.getElementById('create-code');
      this.sharingPanel = document.getElementById('sharing-panel');
      this.shareCodeEl = document.getElementById('share-code');
      this.copyCodeBtn = document.getElementById('copy-code');
      this.sendStatusEl = document.getElementById('send-status');
      this.sendProgressEl = document.getElementById('send-progress');
      this.progressFill = document.getElementById('progress-fill');
      this.progressPercentEl = document.getElementById('progress-percent');
      this.progressSpeedEl = document.getElementById('progress-speed');
      this.cancelSendBtn = document.getElementById('cancel-send');

      // Receive
      this.codeInput = document.getElementById('code-input');
      this.connectBtn = document.getElementById('connect-btn');
      this.inputSection = document.getElementById('input-section');
      this.receivingPanel = document.getElementById('receiving-panel');
      this.incomingNameEl = document.getElementById('incoming-name');
      this.incomingSizeEl = document.getElementById('incoming-size');
      this.receiveStatusEl = document.getElementById('receive-status');
      this.receiveProgressEl = document.getElementById('receive-progress');
      this.receiveProgressFill = document.getElementById('receive-progress-fill');
      this.receivePercentEl = document.getElementById('receive-percent');
      this.receiveSpeedEl = document.getElementById('receive-speed');
      this.cancelReceiveBtn = document.getElementById('cancel-receive');

      // Status
      this.connectionStatusEl = document.getElementById('connection-status');
    }

    bindEvents() {
      // Tab switching
      this.tabs.forEach(tab => {
        tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
      });

      // File selection
      this.dropzone.addEventListener('click', () => this.fileInput.click());
      this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
      this.dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        this.dropzone.classList.add('dragover');
      });
      this.dropzone.addEventListener('dragleave', () => {
        this.dropzone.classList.remove('dragover');
      });
      this.dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        this.dropzone.classList.remove('dragover');
        if (e.dataTransfer.files[0]) {
          this.selectFile(e.dataTransfer.files[0]);
        }
      });

      // File actions
      this.removeFileBtn.addEventListener('click', () => this.clearFile());
      this.createCodeBtn.addEventListener('click', () => this.createTransfer());

      // Share code
      this.copyCodeBtn.addEventListener('click', () => this.copyCode());
      this.cancelSendBtn.addEventListener('click', () => this.cancelTransfer());

      // Receive
      this.codeInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/[^0-9]/g, '');
        this.connectBtn.disabled = e.target.value.length !== 6;
      });
      this.connectBtn.addEventListener('click', () => this.joinTransfer());
      this.cancelReceiveBtn.addEventListener('click', () => this.cancelTransfer());
    }

    bindConnectionEvents() {
      const conn = this.connection;

      conn.on('status', (message) => {
        this.sendStatusEl.textContent = message;
        this.connectionStatusEl.textContent = 'Connecting...';
      });

      conn.on('connected', () => {
        this.connectionStatusEl.textContent = 'Connected';
        if (!conn.isSender) {
          this.receiveStatusEl.textContent = 'Receiving...';
        }
      });

      conn.on('file-info', (info) => {
        this.incomingNameEl.textContent = info.name;
        this.incomingSizeEl.textContent = formatSize(info.size);
      });

      conn.on('progress', (progress) => {
        this.updateProgress(progress);
      });

      conn.on('complete', () => {
        if (conn.isSender) {
          this.sendStatusEl.textContent = '✓ File sent!';
          showToast('File sent successfully!', 'success');
        } else {
          this.receiveStatusEl.textContent = '✓ File received!';
          showToast('File downloaded successfully!', 'success');
        }
        this.connectionStatusEl.textContent = 'Transfer complete';
      });

      conn.on('error', (error) => {
        showToast(error.message || 'Transfer failed', 'error');
        this.connectionStatusEl.textContent = 'Error';
        this.cancelTransfer();
      });
    }

    startCleanupTimer() {
      // Run cleanup every hour
      this.cleanupInterval = setInterval(() => {
        cleanupOldTransfers();
      }, CONFIG.CLEANUP_INTERVAL);
    }

    switchTab(tabId) {
      this.tabs.forEach(t => t.classList.remove('active'));
      this.panels.forEach(p => p.classList.remove('active'));

      document.getElementById('tab-' + tabId).classList.add('active');
      document.getElementById('panel-' + tabId).classList.add('active');
    }

    handleFileSelect(e) {
      const file = e.target.files[0];
      if (file) this.selectFile(file);
    }

    selectFile(file) {
      this.currentFile = file;
      this.filenameEl.textContent = file.name;
      this.filesizeEl.textContent = formatSize(file.size);

      this.dropzone.classList.add('hidden');
      this.filePreview.classList.remove('hidden');
    }

    clearFile() {
      this.currentFile = null;
      this.fileInput.value = '';
      this.dropzone.classList.remove('hidden');
      this.filePreview.classList.add('hidden');
    }

    async createTransfer() {
      if (!this.currentFile) {
        showToast('Please select a file first', 'error');
        return;
      }

      this.createCodeBtn.disabled = true;
      this.createCodeBtn.innerHTML = 'Generating...';

      try {
        const code = await this.connection.createTransfer(this.currentFile);
        if (code) {
          this.shareCodeEl.textContent = code;
          this.filePreview.classList.add('hidden');
          this.sharingPanel.classList.remove('hidden');
          showToast('Code generated: ' + code, 'success');
        }
      } catch (error) {
        showToast(error.message || 'Failed to create transfer', 'error');
      } finally {
        this.createCodeBtn.disabled = false;
        this.createCodeBtn.innerHTML = 'Generate Code';
      }
    }

    copyCode() {
      const code = this.shareCodeEl.textContent;
      navigator.clipboard.writeText(code).then(() => {
        this.copyCodeBtn.classList.add('copied');
        setTimeout(() => this.copyCodeBtn.classList.remove('copied'), 2000);
        showToast('Code copied!', 'success');
      });
    }

    updateProgress(progress) {
      const elapsed = (Date.now() - this.connection.startTime) / 1000;
      const bytes = this.connection.isSender
        ? (progress.sent / progress.total) * this.connection.fileInfo.size
        : (progress.received / progress.total) * this.connection.fileInfo.size;
      const speed = bytes / elapsed;

      if (this.connection.isSender) {
        this.sendProgressEl.classList.remove('hidden');
        this.progressFill.style.width = progress.percent + '%';
        this.progressPercentEl.textContent = Math.round(progress.percent) + '%';
        this.progressSpeedEl.textContent = formatSpeed(speed);
      } else {
        this.receiveProgressEl.classList.remove('hidden');
        this.receiveProgressFill.style.width = progress.percent + '%';
        this.receivePercentEl.textContent = Math.round(progress.percent) + '%';
        this.receiveSpeedEl.textContent = formatSpeed(speed);
      }
    }

    async joinTransfer() {
      const code = this.codeInput.value.trim();
      if (code.length !== 6) {
        showToast('Enter a valid 6-digit code', 'error');
        return;
      }

      this.connectBtn.disabled = true;
      this.connectBtn.innerHTML = 'Connecting...';

      try {
        const fileInfo = await this.connection.joinTransfer(code);
        if (fileInfo) {
          this.inputSection.classList.add('hidden');
          this.receivingPanel.classList.remove('hidden');
          this.incomingNameEl.textContent = fileInfo.name;
          this.incomingSizeEl.textContent = formatSize(fileInfo.size);
          showToast('Connected! Starting transfer...', 'success');
        }
      } catch (e) {
        showToast(e.message || 'Failed to connect', 'error');
      } finally {
        this.connectBtn.disabled = false;
        this.connectBtn.innerHTML = 'Connect';
      }
    }

    cancelTransfer() {
      this.connection.cancel();
      this.sharingPanel.classList.add('hidden');
      this.receivingPanel.classList.add('hidden');
      this.inputSection.classList.remove('hidden');
      this.codeInput.value = '';
      this.connectBtn.disabled = true;
      this.clearFile();
      this.connectionStatusEl.textContent = 'Ready';
      this.sendStatusEl.textContent = 'Waiting for receiver...';
      this.sendProgressEl.classList.add('hidden');
      this.receiveProgressEl.classList.add('hidden');
      this.receiveStatusEl.textContent = 'Connecting...';
    }

    destroy() {
      clearInterval(this.cleanupInterval);
      this.connection.cancel();
    }
  }

  // Initialize when DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    window.omShare = new OmShareApp();

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
      window.omShare?.destroy();
    });
  });

})();cache-buster
