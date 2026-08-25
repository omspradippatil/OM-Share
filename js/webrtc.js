/**
 * OmShare - Multi-Device WebRTC & Relay Streaming Manager
 * Handles WebRTC P2P direct DataChannel streaming with automatic seamless
 * serverless relay fallback for restrictive mobile CGNAT networks.
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

  function cleanCandidate(cand) {
    if (!cand) return null;
    const raw = cand.toJSON ? cand.toJSON() : cand;
    if (!raw || !raw.candidate) return null;

    const out = {
      candidate: String(raw.candidate)
    };
    if (raw.sdpMid !== undefined && raw.sdpMid !== null) {
      out.sdpMid = String(raw.sdpMid);
    }
    if (raw.sdpMLineIndex !== undefined && raw.sdpMLineIndex !== null) {
      out.sdpMLineIndex = Number(raw.sdpMLineIndex);
    }
    if (raw.usernameFragment !== undefined && raw.usernameFragment !== null) {
      out.usernameFragment = String(raw.usernameFragment);
    }
    return out;
  }

  // Convert ArrayBuffer to Base64
  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Convert Base64 to ArrayBuffer
  function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  class WebRTCConnectionManager {
    constructor() {
      this.signaling = new HybridSignaling();
      this.peerId = this.generatePeerId();
      this.code = null;
      this.file = null;
      this.fileInfo = null;
      this.isSender = false;
      this.startTime = null;
      this.downloadsCount = 0;
      this.clientIP = 'client-' + Math.random().toString(36).substr(2, 9);
      this.listeners = new Map();
      this.isDestroyed = false;
      this.isRelayFallbackActive = false;

      // Multi-device peers map: receiverId -> { pc, dataChannel, pendingCandidates, isStreaming, isRelaying }
      this.peers = new Map();

      // Receiver side variables
      this.receiverPC = null;
      this.receiverDataChannel = null;
      this.receivedChunks = new Map();
      this.pendingReceiverCandidates = [];
      this.fallbackTimeoutTimer = null;
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
     * Sender starts persistent multi-device transfer session
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
      console.log(`[WebRTC] Multi-device session ready: code ${this.code} (${result.mode})`);

      // Real-time listener for incoming receivers
      this.signaling.listenSession(this.code, true, this.peerId, {
        onReceiverJoined: async (receiverId) => {
          console.log(`[WebRTC] New receiver ${receiverId} connected! Initiating handshake.`);
          this.emit('receiver-joined', { receiverId, count: this.peers.size + 1 });
          this.emit('status', `Device connected. Connecting stream...`);
          await this.handleNewReceiver(receiverId);
        },
        onAnswer: async (answer, fromReceiverId) => {
          await this.handleReceiverAnswer(answer, fromReceiverId);
        },
        onCandidate: async (candidateData, fromReceiverId) => {
          await this.handleReceiverCandidate(candidateData, fromReceiverId);
        },
        onRelayRequested: async (fromReceiverId) => {
          console.log(`[WebRTC] Relay requested by ${fromReceiverId}. Switching to serverless stream.`);
          this.emit('status', `Connecting via secure relay stream...`);
          await this.streamFileViaRelay(fromReceiverId);
        }
      });

      return this.code;
    }

    /**
     * Sender sets up dedicated RTCPeerConnection for a new receiver
     */
    async handleNewReceiver(receiverId) {
      if (this.peers.has(receiverId)) return;

      const peerSession = {
        receiverId,
        pc: null,
        dataChannel: null,
        pendingCandidates: [],
        bytesSent: 0,
        isStreaming: false,
        isRelaying: false
      };

      const pcConfig = CONFIG.RTC_PEER_CONFIG || {
        iceServers: CONFIG.ICE_SERVERS,
        iceCandidatePoolSize: 10,
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      };

      const pc = new RTCPeerConnection(pcConfig);
      peerSession.pc = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate && event.candidate.candidate && this.code) {
          this.signaling.sendCandidate(this.code, this.peerId, receiverId, true, event.candidate);
        }
      };

      pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] Receiver ${receiverId} Connection State:`, pc.connectionState);
        if (pc.connectionState === 'connected') {
          this.emit('connected', { receiverId });
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          console.warn(`[WebRTC] P2P connection failed for ${receiverId}. Activating relay fallback.`);
          this.streamFileViaRelay(receiverId);
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC] Receiver ${receiverId} ICE State:`, pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          this.emit('connected', { receiverId });
        } else if (pc.iceConnectionState === 'failed') {
          console.warn(`[WebRTC] Receiver ${receiverId} ICE failed. Triggering relay fallback.`);
          this.streamFileViaRelay(receiverId);
        }
      };

      // Create DataChannel with low latency ordered delivery
      const dc = pc.createDataChannel('omshare-transfer', { ordered: true });
      dc.binaryType = 'arraybuffer';
      peerSession.dataChannel = dc;

      const handleChannelOpen = () => {
        console.log(`[WebRTC] DataChannel opened for receiver ${receiverId}!`);
        this.emit('connected', { receiverId });
        this.streamFileToReceiver(receiverId);
      };

      dc.onopen = handleChannelOpen;
      if (dc.readyState === 'open') {
        handleChannelOpen();
      }

      this.peers.set(receiverId, peerSession);

      // Create and set Offer
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);
        await this.signaling.sendOffer(this.code, this.peerId, receiverId, offer);
        console.log(`[WebRTC] Offer sent to receiver ${receiverId}`);
      } catch (err) {
        console.error(`[WebRTC] Error generating offer for ${receiverId}:`, err);
      }
    }

    async handleReceiverAnswer(answer, receiverId) {
      let session = receiverId ? this.peers.get(receiverId) : null;
      if (!session && this.peers.size === 1) {
        session = Array.from(this.peers.values())[0];
      }

      if (!session || !session.pc) return;

      try {
        if (session.pc.signalingState !== 'stable') {
          const sdpInit = { type: answer.type || 'answer', sdp: answer.sdp };
          await session.pc.setRemoteDescription(new RTCSessionDescription(sdpInit));

          while (session.pendingCandidates.length > 0) {
            const cand = session.pendingCandidates.shift();
            try {
              await session.pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch (e) {}
          }
          console.log(`[WebRTC] Remote answer applied for receiver ${session.receiverId}`);
        }
      } catch (err) {
        console.error('[WebRTC] Error setting answer:', err);
      }
    }

    async handleReceiverCandidate(candidateData, receiverId) {
      const candObj = cleanCandidate(candidateData);
      if (!candObj || !candObj.candidate) return;

      let session = receiverId ? this.peers.get(receiverId) : null;
      if (!session && this.peers.size === 1) {
        session = Array.from(this.peers.values())[0];
      }

      if (!session || !session.pc || !session.pc.remoteDescription || !session.pc.remoteDescription.type) {
        if (session) {
          session.pendingCandidates.push(candObj);
        }
        return;
      }

      try {
        await session.pc.addIceCandidate(new RTCIceCandidate(candObj));
      } catch (e) {}
    }

    /**
     * Streams file chunks via WebRTC DataChannel (Direct P2P)
     */
    async streamFileToReceiver(receiverId) {
      const session = this.peers.get(receiverId);
      if (!session || !session.dataChannel || !this.file || !this.fileInfo) return;
      if (session.isStreaming || session.isRelaying) return;
      session.isStreaming = true;

      console.log(`[WebRTC] Starting P2P file stream to receiver ${receiverId}`);

      try {
        session.dataChannel.send(JSON.stringify({
          type: 'METADATA',
          payload: this.fileInfo
        }));

        const totalChunks = this.fileInfo.totalChunks;
        const BUFFER_THRESHOLD = 2 * 1024 * 1024; // 2MB backpressure threshold

        for (let i = 0; i < totalChunks; i++) {
          if (this.isDestroyed || !session.dataChannel || session.dataChannel.readyState !== 'open') {
            console.warn(`[WebRTC] P2P stream interrupted for ${receiverId}. Switching to relay.`);
            session.isStreaming = false;
            return this.streamFileViaRelay(receiverId, i);
          }

          while (session.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
            await new Promise(res => setTimeout(res, 25));
          }

          const start = i * CONFIG.CHUNK_SIZE;
          const end = Math.min(start + CONFIG.CHUNK_SIZE, this.file.size);
          const slice = this.file.slice(start, end);
          const arrayBuffer = await slice.arrayBuffer();

          session.dataChannel.send(JSON.stringify({
            type: 'CHUNK_HEADER',
            index: i
          }));

          session.dataChannel.send(arrayBuffer);

          const percent = Math.min(100, ((i + 1) / totalChunks) * 100);
          this.emit('progress', {
            receiverId,
            sent: i + 1,
            total: totalChunks,
            percent,
            bytesTransferred: (i + 1) * CONFIG.CHUNK_SIZE
          });
        }

        session.dataChannel.send(JSON.stringify({ type: 'COMPLETE' }));
        this.downloadsCount++;
        await this.signaling.markReceiverComplete(this.code, receiverId);

        this.emit('receiver-completed', {
          receiverId,
          downloadsCount: this.downloadsCount
        });
        console.log(`[WebRTC] Download #${this.downloadsCount} finished for ${receiverId} (P2P).`);
      } catch (err) {
        console.warn(`[WebRTC] Stream error for ${receiverId}, falling back to relay:`, err.message);
        await this.streamFileViaRelay(receiverId);
      } finally {
        session.isStreaming = false;
      }
    }

    /**
     * Streams file chunks via Serverless Relay (Guaranteed 100% Carrier & Firewall Traversal)
     */
    async streamFileViaRelay(receiverId, startFromIndex = 0) {
      const session = this.peers.get(receiverId) || { receiverId, isRelaying: false };
      this.peers.set(receiverId, session);

      if (session.isRelaying || !this.file || !this.fileInfo) return;
      session.isRelaying = true;

      console.log(`[WebRTC] Streaming file via secure relay to ${receiverId} (from chunk #${startFromIndex})`);
      this.emit('connected', { receiverId });

      try {
        const totalChunks = this.fileInfo.totalChunks;

        for (let i = startFromIndex; i < totalChunks; i++) {
          if (this.isDestroyed) return;

          const start = i * CONFIG.CHUNK_SIZE;
          const end = Math.min(start + CONFIG.CHUNK_SIZE, this.file.size);
          const slice = this.file.slice(start, end);
          const arrayBuffer = await slice.arrayBuffer();
          const base64Data = arrayBufferToBase64(arrayBuffer);
          const isLast = (i === totalChunks - 1);

          await this.signaling.sendRelayChunk(
            this.code,
            this.peerId,
            receiverId,
            i,
            totalChunks,
            base64Data,
            isLast
          );

          const percent = Math.min(100, ((i + 1) / totalChunks) * 100);
          this.emit('progress', {
            receiverId,
            sent: i + 1,
            total: totalChunks,
            percent,
            bytesTransferred: (i + 1) * CONFIG.CHUNK_SIZE
          });

          // Smooth pacing for relay stream
          await new Promise(r => setTimeout(r, 10));
        }

        this.downloadsCount++;
        await this.signaling.markReceiverComplete(this.code, receiverId);

        this.emit('receiver-completed', {
          receiverId,
          downloadsCount: this.downloadsCount
        });
        console.log(`[WebRTC] Download #${this.downloadsCount} finished for ${receiverId} (Relay).`);
      } catch (err) {
        console.error(`[WebRTC] Relay stream error for ${receiverId}:`, err);
      } finally {
        session.isRelaying = false;
      }
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

      const pcConfig = CONFIG.RTC_PEER_CONFIG || {
        iceServers: CONFIG.ICE_SERVERS,
        iceCandidatePoolSize: 10,
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      };

      const pc = new RTCPeerConnection(pcConfig);
      this.receiverPC = pc;

      // Fail-Safe Watchdog: If WebRTC P2P doesn't open within 3.5s, request relay fallback!
      this.fallbackTimeoutTimer = setTimeout(async () => {
        if (!this.receiverDataChannel || this.receiverDataChannel.readyState !== 'open') {
          console.warn('[WebRTC] Direct P2P negotiation timed out. Requesting relay fallback.');
          await this.triggerReceiverRelayFallback();
        }
      }, 3500);

      pc.onicecandidate = (event) => {
        if (event.candidate && event.candidate.candidate && this.code) {
          this.signaling.sendCandidate(this.code, this.peerId, senderId, false, event.candidate);
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('[WebRTC] Receiver Connection State:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          if (this.fallbackTimeoutTimer) clearTimeout(this.fallbackTimeoutTimer);
          this.emit('connected');
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          console.warn('[WebRTC] Receiver connection state failed. Activating relay.');
          this.triggerReceiverRelayFallback();
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log('[WebRTC] Receiver ICE State:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          if (this.fallbackTimeoutTimer) clearTimeout(this.fallbackTimeoutTimer);
          this.emit('connected');
        } else if (pc.iceConnectionState === 'failed') {
          this.triggerReceiverRelayFallback();
        }
      };

      pc.ondatachannel = (event) => {
        console.log('[WebRTC] Receiver received DataChannel');
        if (this.fallbackTimeoutTimer) clearTimeout(this.fallbackTimeoutTimer);
        this.receiverDataChannel = event.channel;
        this.setupReceiverDataChannel();
      };

      // Listen for Offer, Candidates, and Relay Chunks in real-time
      this.signaling.listenSession(this.code, false, this.peerId, {
        onOffer: async (offer) => {
          try {
            if (this.receiverPC && this.receiverPC.signalingState !== 'closed') {
              console.log('[WebRTC] Receiver received offer, applying...');
              const sdpInit = { type: offer.type || 'offer', sdp: offer.sdp };
              await this.receiverPC.setRemoteDescription(new RTCSessionDescription(sdpInit));

              while (this.pendingReceiverCandidates.length > 0) {
                const cand = this.pendingReceiverCandidates.shift();
                try {
                  await this.receiverPC.addIceCandidate(new RTCIceCandidate(cand));
                } catch (e) {}
              }

              const answer = await this.receiverPC.createAnswer();
              await this.receiverPC.setLocalDescription(answer);

              await this.signaling.sendAnswer(this.code, this.peerId, senderId, answer);
              console.log(`[WebRTC] Answer dispatched to sender in ${(Date.now() - this.startTime)}ms`);
            }
          } catch (err) {
            console.error('[WebRTC] Error processing offer:', err);
          }
        },
        onCandidate: async (candidateData) => {
          const candObj = cleanCandidate(candidateData);
          if (!candObj || !candObj.candidate) return;

          if (!this.receiverPC || !this.receiverPC.remoteDescription || !this.receiverPC.remoteDescription.type) {
            this.pendingReceiverCandidates.push(candObj);
            return;
          }

          try {
            await this.receiverPC.addIceCandidate(new RTCIceCandidate(candObj));
          } catch (e) {}
        },
        onRelayChunk: (chunk) => {
          this.handleRelayChunk(chunk);
        }
      });

      return this.fileInfo;
    }

    async triggerReceiverRelayFallback() {
      if (this.isRelayFallbackActive) return;
      this.isRelayFallbackActive = true;
      console.warn('[WebRTC] Activating serverless relay fallback stream on receiver...');
      this.emit('status', 'Connecting via secure relay stream...');
      await this.signaling.requestRelay(this.code, this.peerId, {
        onRelayChunk: (chunk) => this.handleRelayChunk(chunk)
      });
    }

    setupReceiverDataChannel() {
      if (!this.receiverDataChannel) return;
      this.receiverDataChannel.binaryType = 'arraybuffer';

      const handleOpen = () => {
        const duration = this.startTime ? `${Date.now() - this.startTime}ms` : '';
        console.log(`[WebRTC] Receiver DataChannel opened in ${duration}!`);
        if (this.fallbackTimeoutTimer) clearTimeout(this.fallbackTimeoutTimer);
        this.emit('connected');
      };

      this.receiverDataChannel.onopen = handleOpen;
      if (this.receiverDataChannel.readyState === 'open') {
        handleOpen();
      }

      this.receiverDataChannel.onmessage = (event) => {
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

      this.receiverDataChannel.onerror = (err) => {
        console.error('[WebRTC] DataChannel error:', err);
      };

      this.receiverDataChannel.onclose = () => {
        console.log('[WebRTC] Receiver DataChannel closed');
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

    handleRelayChunk(chunk) {
      this.emit('connected');
      const arrayBuffer = base64ToArrayBuffer(chunk.data);
      this.receivedChunks.set(chunk.chunkIndex, arrayBuffer);

      const receivedCount = this.receivedChunks.size;
      const total = this.fileInfo ? this.fileInfo.totalChunks : chunk.totalChunks;
      const percent = Math.min(100, (receivedCount / total) * 100);

      this.emit('progress', {
        received: receivedCount,
        total,
        percent,
        bytesTransferred: receivedCount * CONFIG.CHUNK_SIZE
      });

      if (chunk.completed || receivedCount >= total) {
        this.finalizeReceivedFile();
      }
    }

    async finalizeReceivedFile() {
      if (this.hasFinalized) return;
      this.hasFinalized = true;

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

      await this.signaling.markReceiverComplete(this.code, this.peerId);
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

    async stopSharing() {
      this.isDestroyed = true;
      if (this.fallbackTimeoutTimer) {
        clearTimeout(this.fallbackTimeoutTimer);
        this.fallbackTimeoutTimer = null;
      }

      if (this.signaling) {
        await this.signaling.stopSharing(this.code);
      }

      this.peers.forEach(session => {
        try { if (session.dataChannel) session.dataChannel.close(); } catch (e) {}
        try { if (session.pc) session.pc.close(); } catch (e) {}
      });
      this.peers.clear();

      if (this.receiverDataChannel) {
        try { this.receiverDataChannel.close(); } catch (e) {}
        this.receiverDataChannel = null;
      }
      if (this.receiverPC) {
        try { this.receiverPC.close(); } catch (e) {}
        this.receiverPC = null;
      }
      this.receivedChunks.clear();
      this.pendingReceiverCandidates = [];
    }

    cancel() {
      return this.stopSharing();
    }
  }

  return WebRTCConnectionManager;
});
