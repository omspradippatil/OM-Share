/**
 * OmShare - Hybrid Ultra-Fast Signaling Manager
 * Real-time sub-second WebRTC signaling via single-document Firestore streams (primary)
 * and low-latency AJAX micro-polling (fallback).
 */

(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./config.js'), require('./ajax.js'));
  } else {
    root.OmSignaling = factory(root.OmConfig, root.OmAjax);
  }
})(typeof self !== 'undefined' ? self : this, function(CONFIG, ajax) {
  'use strict';

  class HybridSignalingManager {
    constructor() {
      this.db = null;
      this.firebaseInitialized = false;
      this.useAjaxFallback = false;
      this.activePollingInterval = null;
      this.unsubscribers = [];
      this.processedCandidateKeys = new Set();
      this.candidateBatchQueue = [];
      this.candidateBatchTimer = null;

      this.initFirebase();
      this.bindNetworkEvents();
    }

    /**
     * Initializes Firebase Firestore with error resilience
     */
    initFirebase() {
      if (typeof firebase === 'undefined') {
        console.warn('[Signaling] Firebase SDK not loaded, enabling AJAX fallback');
        this.useAjaxFallback = true;
        return;
      }

      if (!CONFIG.isFirebaseConfigured()) {
        console.warn('[Signaling] Firebase not configured with real credentials. Using fast AJAX signaling.');
        this.useAjaxFallback = true;
        return;
      }

      try {
        if (!firebase.apps.length) {
          firebase.initializeApp(CONFIG.FIREBASE);
        }
        this.db = firebase.firestore();
        this.firebaseInitialized = true;
        console.log('[Signaling] Firebase Firestore initialized in real-time mode');
      } catch (err) {
        console.warn('[Signaling] Firebase initialization error:', err.message);
        this.useAjaxFallback = true;
      }
    }

    /**
     * Listens to browser network state
     */
    bindNetworkEvents() {
      if (typeof window === 'undefined') return;

      window.addEventListener('online', async () => {
        if (this.db) {
          try { await this.db.enableNetwork(); } catch (e) {}
        }
      });

      window.addEventListener('offline', async () => {
        if (this.db) {
          try { await this.db.disableNetwork(); } catch (e) {}
        }
      });
    }

    /**
     * Creates a new transfer session document
     */
    async createTransfer(code, peerId, fileInfo, clientIP) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          const transferDoc = this.db.collection('transfers').doc(code);
          await transferDoc.set({
            code,
            senderId: peerId,
            receiverId: null,
            fileName: fileInfo.name,
            fileSize: fileInfo.size,
            fileType: fileInfo.type || 'application/octet-stream',
            totalChunks: fileInfo.totalChunks,
            createdAt: Date.now(),
            expiresAt: Date.now() + CONFIG.CODE_EXPIRY,
            status: 'waiting',
            offer: null,
            answer: null,
            senderCandidates: [],
            receiverCandidates: [],
            clientIP: clientIP || 'unknown'
          });

          return { mode: 'firebase', code };
        } catch (err) {
          console.warn('[Signaling] Firestore createTransfer failed, switching to fast AJAX:', err.message);
          this.useAjaxFallback = true;
        }
      }

      // AJAX Fallback
      try {
        await ajax.post(CONFIG.SIGNALING_API_URL, {
          action: 'create',
          code,
          peerId,
          fileInfo
        });
        return { mode: 'ajax', code };
      } catch (ajaxErr) {
        throw new Error(`Failed to create transfer session: ${ajaxErr.message}`);
      }
    }

    /**
     * Receiver joins a transfer session
     */
    async joinTransfer(code, peerId, clientIP) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          const transferDoc = this.db.collection('transfers').doc(code);
          const doc = await transferDoc.get();

          if (!doc.exists) {
            throw new Error('Transfer code not found or has expired.');
          }

          const data = doc.data();
          if (Date.now() > data.expiresAt) {
            await transferDoc.delete().catch(() => {});
            throw new Error('Transfer code has expired.');
          }

          if (data.status === 'complete') {
            throw new Error('Transfer is already complete.');
          }

          // Atomic join update
          await transferDoc.update({
            receiverId: peerId,
            status: 'active',
            receiverIP: clientIP || 'unknown',
            receiverJoinedAt: Date.now()
          });

          return {
            mode: 'firebase',
            senderId: data.senderId,
            fileInfo: {
              name: data.fileName,
              size: data.fileSize,
              type: data.fileType,
              totalChunks: data.totalChunks
            }
          };
        } catch (err) {
          if (err.message.includes('offline') || err.message.includes('unavailable') || err.message.includes('permission')) {
            console.warn('[Signaling] Firestore join failed, falling back to fast AJAX:', err.message);
            this.useAjaxFallback = true;
          } else {
            throw err;
          }
        }
      }

      // AJAX Fallback
      try {
        const response = await ajax.post(CONFIG.SIGNALING_API_URL, {
          action: 'join',
          code,
          peerId
        });

        return {
          mode: 'ajax',
          senderId: response.senderId,
          fileInfo: response.fileInfo
        };
      } catch (ajaxErr) {
        if (ajaxErr.status === 404) {
          throw new Error('Transfer code not found or has expired.');
        }
        throw new Error(`Failed to join transfer: ${ajaxErr.message}`);
      }
    }

    /**
     * Unified Real-Time Session Listener for Sender & Receiver
     * Subscribes to single-document real-time stream for instant millisecond handshakes.
     */
    listenSession(code, isSender, peerId, handlers) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          let hasHandledReceiver = false;
          let hasHandledOffer = false;
          let hasHandledAnswer = false;

          const unsub = this.db.collection('transfers').doc(code).onSnapshot(
            (snapshot) => {
              if (!snapshot.exists) return;
              const data = snapshot.data();
              if (!data) return;

              if (isSender) {
                // Sender waits for receiver to join
                if (data.receiverId && !hasHandledReceiver && handlers.onReceiverJoined) {
                  hasHandledReceiver = true;
                  handlers.onReceiverJoined(data.receiverId);
                }

                // Sender listens for Answer
                if (data.answer && !hasHandledAnswer && handlers.onAnswer) {
                  hasHandledAnswer = true;
                  handlers.onAnswer(data.answer);
                }

                // Sender listens for incoming receiver candidates
                if (data.receiverCandidates && Array.isArray(data.receiverCandidates) && handlers.onCandidate) {
                  data.receiverCandidates.forEach(cand => {
                    const key = JSON.stringify(cand);
                    if (!this.processedCandidateKeys.has(key)) {
                      this.processedCandidateKeys.add(key);
                      handlers.onCandidate(cand);
                    }
                  });
                }
              } else {
                // Receiver listens for Offer
                if (data.offer && !hasHandledOffer && handlers.onOffer) {
                  hasHandledOffer = true;
                  handlers.onOffer(data.offer);
                }

                // Receiver listens for incoming sender candidates
                if (data.senderCandidates && Array.isArray(data.senderCandidates) && handlers.onCandidate) {
                  data.senderCandidates.forEach(cand => {
                    const key = JSON.stringify(cand);
                    if (!this.processedCandidateKeys.has(key)) {
                      this.processedCandidateKeys.add(key);
                      handlers.onCandidate(cand);
                    }
                  });
                }
              }
            },
            (err) => {
              console.warn('[Signaling] Snapshot stream error, falling back to fast polling:', err.message);
              this.startFastPolling(code, peerId, isSender, handlers);
            }
          );

          this.unsubscribers.push(unsub);
          return;
        } catch (e) {
          console.warn('[Signaling] Document listener setup error:', e.message);
        }
      }

      // Fast AJAX Polling mode (150ms interval)
      this.startFastPolling(code, peerId, isSender, handlers);
    }

    /**
     * Sender transmits WebRTC Offer
     */
    async sendOffer(code, peerId, to, offer) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          await this.db.collection('transfers').doc(code).update({
            offer: {
              from: peerId,
              to: to || '',
              sdp: offer.sdp,
              type: offer.type,
              timestamp: Date.now()
            }
          });
          return;
        } catch (e) {
          console.warn('[Signaling] Firestore sendOffer failed, using AJAX:', e.message);
        }
      }

      await ajax.post(CONFIG.SIGNALING_API_URL, {
        action: 'offer',
        code,
        peerId,
        to,
        offer
      });
    }

    /**
     * Receiver transmits WebRTC Answer
     */
    async sendAnswer(code, peerId, to, answer) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          await this.db.collection('transfers').doc(code).update({
            answer: {
              from: peerId,
              to: to || '',
              sdp: answer.sdp,
              type: answer.type,
              timestamp: Date.now()
            }
          });
          return;
        } catch (e) {
          console.warn('[Signaling] Firestore sendAnswer failed, using AJAX:', e.message);
        }
      }

      await ajax.post(CONFIG.SIGNALING_API_URL, {
        action: 'answer',
        code,
        peerId,
        to,
        answer
      });
    }

    /**
     * Batched ICE candidate transmission for minimal network overhead
     */
    sendCandidate(code, peerId, to, isSender, candidate) {
      if (!candidate) return;
      const candJson = candidate.toJSON ? candidate.toJSON() : candidate;
      if (!candJson || (!candJson.candidate && candJson.candidate !== '')) return;

      this.candidateBatchQueue.push(candJson);

      if (this.candidateBatchTimer) return;

      // Batch candidates in 25ms window
      this.candidateBatchTimer = setTimeout(async () => {
        this.candidateBatchTimer = null;
        const batch = [...this.candidateBatchQueue];
        this.candidateBatchQueue = [];
        if (batch.length === 0) return;

        if (!this.useAjaxFallback && this.firebaseInitialized && typeof firebase !== 'undefined' && this.db) {
          try {
            const fieldName = isSender ? 'senderCandidates' : 'receiverCandidates';
            const transferDoc = this.db.collection('transfers').doc(code);
            await transferDoc.update({
              [fieldName]: firebase.firestore.FieldValue.arrayUnion(...batch)
            });
            return;
          } catch (e) {
            console.warn('[Signaling] Firestore batch candidate update failed, falling back to AJAX:', e.message);
          }
        }

        // AJAX candidate transmission
        for (const c of batch) {
          ajax.post(CONFIG.SIGNALING_API_URL, {
            action: 'candidate',
            code,
            peerId,
            to: to || '',
            candidate: c
          }).catch(() => {});
        }
      }, 25);
    }

    /**
     * Starts ultra-fast 150ms polling for sub-second AJAX connections
     */
    startFastPolling(code, peerId, isSender, handlers, intervalMs = 150) {
      if (this.activePollingInterval) return;

      let hasHandledReceiver = false;
      let hasHandledOffer = false;
      let hasHandledAnswer = false;

      this.activePollingInterval = setInterval(async () => {
        try {
          const response = await ajax.post(CONFIG.SIGNALING_API_URL, {
            action: 'poll',
            code,
            peerId
          }, { timeout: 2500, retries: 0 });

          if (!response) return;

          if (isSender) {
            if (response.receiverId && !hasHandledReceiver && handlers.onReceiverJoined) {
              hasHandledReceiver = true;
              handlers.onReceiverJoined(response.receiverId);
            }

            if (response.answers && response.answers.length > 0 && !hasHandledAnswer && handlers.onAnswer) {
              hasHandledAnswer = true;
              handlers.onAnswer(response.answers[0]);
            }

            if (response.candidates && response.candidates.length > 0 && handlers.onCandidate) {
              response.candidates.forEach(c => {
                const candData = c.candidate || c;
                const key = JSON.stringify(candData);
                if (!this.processedCandidateKeys.has(key)) {
                  this.processedCandidateKeys.add(key);
                  handlers.onCandidate(candData);
                }
              });
            }
          } else {
            if (response.offers && response.offers.length > 0 && !hasHandledOffer && handlers.onOffer) {
              hasHandledOffer = true;
              handlers.onOffer(response.offers[0]);
            }

            if (response.candidates && response.candidates.length > 0 && handlers.onCandidate) {
              response.candidates.forEach(c => {
                const candData = c.candidate || c;
                const key = JSON.stringify(candData);
                if (!this.processedCandidateKeys.has(key)) {
                  this.processedCandidateKeys.add(key);
                  handlers.onCandidate(candData);
                }
              });
            }
          }
        } catch (e) {
          // Keep polling silently
        }
      }, intervalMs);
    }

    /**
     * Mark transfer complete
     */
    async markComplete(code) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          await this.db.collection('transfers').doc(code).update({
            status: 'complete',
            completedAt: Date.now()
          });
        } catch (e) {}
      }

      try {
        await ajax.post(CONFIG.SIGNALING_API_URL, { action: 'complete', code });
      } catch (e) {}
    }

    /**
     * Full cleanup
     */
    cleanup(code) {
      if (this.activePollingInterval) {
        clearInterval(this.activePollingInterval);
        this.activePollingInterval = null;
      }
      if (this.candidateBatchTimer) {
        clearTimeout(this.candidateBatchTimer);
        this.candidateBatchTimer = null;
      }

      this.unsubscribers.forEach(unsub => {
        try { if (typeof unsub === 'function') unsub(); } catch (e) {}
      });
      this.unsubscribers = [];
      this.processedCandidateKeys.clear();
      this.candidateBatchQueue = [];

      if (code) {
        if (!this.useAjaxFallback && this.firebaseInitialized) {
          this.db.collection('transfers').doc(code).delete().catch(() => {});
        }
        ajax.post(CONFIG.SIGNALING_API_URL, { action: 'cancel', code }).catch(() => {});
      }
    }
  }

  return HybridSignalingManager;
});
