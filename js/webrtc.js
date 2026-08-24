/**
 * OmShare - WebRTC Peer Connection & Streaming Manager
 * Ultra-fast sub-second connection establishment with pre-gathered ICE pools,
 * candidate queuing, and low-latency chunk streaming.
 */

(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./config.js'), require('./signaling.js'), require('./ajax.js'));
  } else {
    root.OmWebRTC = factory(root.OmConfig, root.OmSignaling, root.OmAjax);
  }
})(typeof self !== 'undefined' ? self : this, function(CONFIG, HybridSignaling, ajax) {
  'use strict';

  function formatSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  class WebRTCConnectionManager {
    constructor() {
      this.signaling = new HybridSignaling();
      this.peerId = this.generatePeerId();
      this.code = null;
      this.peerConnection = null;
      this.dataChannel = null;
      this.file = null;
      this.fileInfo = null;
      this.receivedChunks = new Map();
      this.isSender = false;
      this.startTime = null;
      this.clientIP = 'client-' + Math.random().toString(36).substr(2, 9);
      this.listeners = new Map();
      this.pendingCandidates = [];
      this.isDestroyed = false;
    }

    generatePeerId() {
      return 'peer_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    }

    on(event, callback) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, []);
      }
      this.listeners.get(event).push(callback);
    }

    emit(event, data) {
      if (this.listeners.has(event)) {
        this.listeners.get(event).forEach(cb => {
          try {
            cb(data);
          } catch (e) {
            console.error(`Error in event listener for ${event}:`, e);
          }
        });
      }
    }

    generateCode() {
      return String(Math.floor(100000 + Math.random() * 900000));
    }

    /**
     * Sender starts transfer session
     */
    async createTransfer(file) {
      if (!file) throw new Error('Please select a file to share.');

      if (CONFIG.MAX_FILE_SIZE && file.size > CONFIG.MAX_FILE_SIZE) {
        throw new Error(`File too large. Maximum size is ${formatSize(CONFIG.MAX_FILE_SIZE)}`);
      }

      this.file = file;
      this.isSender = true;
      this.startTime = Date.now();
      this.code = this.generateCode();

      this.fileInfo = {
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        totalChunks: Math.ceil(file.size / CONFIG.CHUNK_SIZE)
      };

      const result = await this.signaling.createTransfer(this.code, this.peerId, this.fileInfo, this.clientIP);
      console.log(`[WebRTC] Transfer created with code ${this.code} (${result.mode})`);

      // Start unified real-time stream listener for instant receiver detection
      this.signaling.listenSession(this.code, true, this.peerId, {
        onReceiverJoined: async (receiverId) => {
          console.log(`[WebRTC] Receiver ${receiverId} joined in ${(Date.now() - this.startTime)}ms. Starting handshake.`);
          this.emit('status', 'Receiver connected. Establishing direct connection...');
          await this.handleReceiverJoined(receiverId);
        },
        onAnswer: async (answer) => {
          if (this.peerConnection && this.peerConnection.signalingState !== 'stable') {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            await this.flushPendingCandidates();
            console.log(`[WebRTC] Remote answer applied in ${(Date.now() - this.startTime)}ms`);
          }
        },
        onCandidate: async (candidateData) => {
          await this.addOrQueueCandidate(candidateData);
        }
      });

      return this.code;
    }

    /**
     * Sender generates Offer and dispatches to receiver
     */
    async handleReceiverJoined(receiverId) {
      this.peerConnection = this.createPeerConnection(receiverId, true);

      // Create DataChannel with low latency ordered delivery
      this.dataChannel = this.peerConnection.createDataChannel('omshare-transfer', {
        ordered: true
      });
      this.setupDataChannel();

      // Create and set local Offer
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      // Transmit offer immediately
      await this.signaling.sendOffer(this.code, this.peerId, receiverId, offer);
    }

    /**
     * Receiver joins transfer session
     */
    async joinTransfer(code) {
      if (!code || code.length !== 6) {
        throw new Error('Please enter a valid 6-digit transfer code.');
      }

      this.code = code;
      this.isSender = false;
      this.startTime = Date.now();

      const session = await this.signaling.joinTransfer(code, this.peerId, this.clientIP);
      this.fileInfo = session.fileInfo;
      const senderId = session.senderId;

      // Pre-warm RTCPeerConnection immediately with pre-gathered ICE candidates
      this.peerConnection = this.createPeerConnection(senderId, false);

      this.peerConnection.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel();
      };

      // Listen for Offer and ICE candidates in real-time
      this.signaling.listenSession(this.code, false, this.peerId, {
        onOffer: async (offer) => {
          if (this.peerConnection && this.peerConnection.signalingState !== 'closed') {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            await this.flushPendingCandidates();

            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);

            await this.signaling.sendAnswer(this.code, this.peerId, senderId, answer);
            console.log(`[WebRTC] Answer dispatched in ${(Date.now() - this.startTime)}ms`);
          }
        },
        onCandidate: async (candidateData) => {
          await this.addOrQueueCandidate(candidateData);
        }
      });

      return this.fileInfo;
    }

    /**
     * Creates and configures RTCPeerConnection with fast ICE pooling
     */
    createPeerConnection(targetPeerId, isSender) {
      const pcConfig = CONFIG.RTC_PEER_CONFIG || {
        iceServers: CONFIG.ICE_SERVERS,
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      };

      const pc = new RTCPeerConnection(pcConfig);

      pc.onicecandidate = (event) => {
        if (event.candidate && this.code) {
          this.signaling.sendCandidate(this.code, this.peerId, targetPeerId, isSender, event.candidate);
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log('[WebRTC] ICE Connection State:', state);

        if (state === 'connected' || state === 'completed') {
          this.emit('connected');
        } else if (state === 'failed') {
          console.warn('[WebRTC] Connection failed, attempting ICE restart...');
          pc.restartIce();
        } else if (state === 'disconnected') {
          this.emit('status', 'Connection temporarily interrupted...');
        }
      };

      return pc;
    }

    /**
     * Candidate queuing to eliminate race conditions
     */
    async addOrQueueCandidate(candidateData) {
      if (!candidateData) return;

      if (!this.peerConnection || !this.peerConnection.remoteDescription) {
        this.pendingCandidates.push(candidateData);
        return;
      }

      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidateData));
      } catch (e) {
        console.warn('[WebRTC] Candidate error:', e.message);
      }
    }

    async flushPendingCandidates() {
      if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
      while (this.pendingCandidates.length > 0) {
        const cand = this.pendingCandidates.shift();
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {}
      }
    }

    /**
     * Sets up DataChannel event handlers and flow control
     */
    setupDataChannel() {
      if (!this.dataChannel) return;
      this.dataChannel.binaryType = 'arraybuffer';

      this.dataChannel.onopen = () => {
        const duration = this.startTime ? `${Date.now() - this.startTime}ms` : '';
        console.log(`[WebRTC] DataChannel opened in ${duration}!`);
        this.emit('connected');
        if (this.isSender) {
          this.startStreamingFile();
        }
      };

      this.dataChannel.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data);
            this.handleControlMessage(message);
          } catch (e) {
            console.error('[WebRTC] Failed to parse control message:', e);
          }
        } else if (event.data instanceof ArrayBuffer) {
          this.handleBinaryChunk(event.data);
        }
      };

      this.dataChannel.onerror = (err) => {
        console.error('[WebRTC] DataChannel error:', err);
        this.emit('error', new Error('Data transfer channel error'));
      };

      this.dataChannel.onclose = () => {
        console.log('[WebRTC] DataChannel closed');
        if (this.isSender && this.file) {
          this.emit('status', 'Transfer ended');
        }
      };
    }

    handleControlMessage(message) {
      switch (message.type) {
        case 'METADATA':
          this.fileInfo = message.payload;
          this.emit('file-info', this.fileInfo);
          break;

        case 'CHUNK_HEADER':
          this.currentReceivingChunkIndex = message.index;
          break;

        case 'COMPLETE':
          this.finalizeReceivedFile();
          break;
      }
    }

    handleBinaryChunk(arrayBuffer) {
      const chunkIndex = this.currentReceivingChunkIndex ?? this.receivedChunks.size;
      this.receivedChunks.set(chunkIndex, arrayBuffer);

      const receivedCount = this.receivedChunks.size;
      const total = this.fileInfo.totalChunks;
      const percent = Math.min(100, (receivedCount / total) * 100);

      this.emit('progress', {
        received: receivedCount,
        total,
        percent,
        bytesTransferred: receivedCount * CONFIG.CHUNK_SIZE
      });
    }

    /**
     * Streams file chunks with Backpressure & Flow Control
     */
    async startStreamingFile() {
      if (!this.file || !this.fileInfo) return;

      console.log(`[WebRTC] Starting file stream: ${this.fileInfo.name} (${formatSize(this.fileInfo.size)})`);

      // Send initial metadata
      this.dataChannel.send(JSON.stringify({
        type: 'METADATA',
        payload: this.fileInfo
      }));

      const totalChunks = this.fileInfo.totalChunks;
      const BUFFER_THRESHOLD = 2 * 1024 * 1024; // 2MB max buffered before pausing

      for (let i = 0; i < totalChunks; i++) {
        if (this.isDestroyed || !this.dataChannel || this.dataChannel.readyState !== 'open') {
          throw new Error('Connection closed during file transfer');
        }

        // Flow control: wait if buffer is full to prevent browser crash / packet loss
        while (this.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
          await new Promise(res => setTimeout(res, 25));
        }

        const start = i * CONFIG.CHUNK_SIZE;
        const end = Math.min(start + CONFIG.CHUNK_SIZE, this.file.size);
        const slice = this.file.slice(start, end);

        // Read chunk as ArrayBuffer on demand
        const arrayBuffer = await slice.arrayBuffer();

        // Send header then binary payload
        this.dataChannel.send(JSON.stringify({
          type: 'CHUNK_HEADER',
          index: i
        }));

        this.dataChannel.send(arrayBuffer);

        const percent = Math.min(100, ((i + 1) / totalChunks) * 100);
        this.emit('progress', {
          sent: i + 1,
          total: totalChunks,
          percent,
          bytesTransferred: (i + 1) * CONFIG.CHUNK_SIZE
        });
      }

      // Signal completion
      this.dataChannel.send(JSON.stringify({ type: 'COMPLETE' }));
      await this.signaling.markComplete(this.code);

      this.emit('complete');
      console.log('[WebRTC] File streaming complete!');
    }

    /**
     * Assembles all chunks and triggers browser download
     */
    async finalizeReceivedFile() {
      console.log(`[WebRTC] Finalizing download of ${this.fileInfo.name}...`);

      const total = this.fileInfo.totalChunks;
      const chunks = [];

      for (let i = 0; i < total; i++) {
        const chunk = this.receivedChunks.get(i);
        if (!chunk) {
          throw new Error(`Missing chunk #${i} in file assembly.`);
        }
        chunks.push(chunk);
      }

      const blob = new Blob(chunks, { type: this.fileInfo.type || 'application/octet-stream' });
      this.triggerDownload(blob, this.fileInfo.name);

      await this.signaling.markComplete(this.code);
      this.emit('complete');
    }

    triggerDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'downloaded-file';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 500);
    }

    cancel() {
      this.isDestroyed = true;
      if (this.signaling) {
        this.signaling.cleanup(this.code);
      }
      if (this.dataChannel) {
        try { this.dataChannel.close(); } catch (e) {}
        this.dataChannel = null;
      }
      if (this.peerConnection) {
        try { this.peerConnection.close(); } catch (e) {}
        this.peerConnection = null;
      }
      this.receivedChunks.clear();
      this.pendingCandidates = [];
    }
  }

  return WebRTCConnectionManager;
});
