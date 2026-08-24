/**
 * OmShare - Hybrid Signaling Manager
 * Seamlessly manages WebRTC signaling via Firebase Firestore (primary)
 * and AJAX Serverless REST endpoints (fallback), handling offline errors and network transitions.
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
      this.mode = 'auto'; // 'firebase' | 'ajax' | 'auto'

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
        console.warn('[Signaling] Firebase is not configured with real API keys. Falling back to AJAX signaling mode.');
        this.useAjaxFallback = true;
        return;
      }

      try {
        if (!firebase.apps.length) {
          firebase.initializeApp(CONFIG.FIREBASE);
        }
        this.db = firebase.firestore();
        this.firebaseInitialized = true;
        console.log('[Signaling] Firebase Firestore initialized successfully');
      } catch (err) {
        console.warn('[Signaling] Firebase initialization error:', err.message);
        this.useAjaxFallback = true;
      }
    }

    /**
     * Listens to browser online/offline events and controls Firestore network state
     */
    bindNetworkEvents() {
      if (typeof window === 'undefined') return;

      window.addEventListener('online', async () => {
        console.log('[Signaling] Network back online');
        if (this.db) {
          try {
            await this.db.enableNetwork();
          } catch (e) {
            console.warn('[Signaling] enableNetwork error:', e.message);
          }
        }
      });

      window.addEventListener('offline', async () => {
        console.warn('[Signaling] Network is offline');
        if (this.db) {
          try {
            await this.db.disableNetwork();
          } catch (e) {
            console.warn('[Signaling] disableNetwork error:', e.message);
          }
        }
      });
    }

    /**
     * Creates a new transfer session
     */
    async createTransfer(code, peerId, fileInfo, clientIP) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          const transferDoc = this.db.collection('transfers').doc(code);
          await transferDoc.set({
            code,
            senderId: peerId,
            fileName: fileInfo.name,
            fileSize: fileInfo.size,
            fileType: fileInfo.type || 'application/octet-stream',
            totalChunks: fileInfo.totalChunks,
            createdAt: Date.now(),
            expiresAt: Date.now() + CONFIG.CODE_EXPIRY,
            status: 'waiting',
            clientIP: clientIP || 'unknown'
          });

          return { mode: 'firebase', code };
        } catch (err) {
          console.warn('[Signaling] Firestore createTransfer failed (offline/blocked), falling back to AJAX:', err.message);
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
     * Sender listens for receiver joining the transfer
     */
    listenForReceiver(code, callback) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          const unsub = this.db.collection('transfers').doc(code).onSnapshot(
            (snapshot) => {
              const data = snapshot.data();
              if (data && data.receiverId) {
                callback(data.receiverId);
              }
            },
            (error) => {
              console.warn('[Signaling] Firestore receiver listener error:', error.message);
              // Switch to polling if Firestore snapshot fails
              this.startPolling(code, 'sender', (pollData) => {
                if (pollData && pollData.receiverId) {
                  callback(pollData.receiverId);
                }
              });
            }
          );
          this.unsubscribers.push(unsub);
          return;
        } catch (e) {
          console.warn('[Signaling] Snapshot error, falling back to polling:', e.message);
        }
      }

      // Polling fallback
      this.startPolling(code, 'sender', (pollData) => {
        if (pollData && pollData.receiverId) {
          callback(pollData.receiverId);
        }
      });
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
          // If offline error or unavailable, attempt AJAX fallback
          if (err.message.includes('offline') || err.message.includes('unavailable') || err.message.includes('permission')) {
            console.warn('[Signaling] Firestore join failed (offline/error), trying AJAX fallback:', err.message);
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
     * Send WebRTC Offer
     */
    async sendOffer(code, peerId, to, offer) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          await this.db.collection('transfers')
            .doc(code)
            .collection('offers')
            .add({
              from: peerId,
              to: to || '',
              sdp: offer.sdp,
              type: offer.type,
              createdAt: Date.now()
            });
          return;
        } catch (e) {
          console.warn('[Signaling] Failed to send offer to Firestore, trying AJAX:', e.message);
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
     * Listen for WebRTC Offers
     */
    listenForOffers(code, peerId, callback) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          const unsub = this.db.collection('transfers')
            .doc(code)
            .collection('offers')
            .where('to', '==', peerId)
            .limit(1)
            .onSnapshot((snapshot) => {
              snapshot.docChanges().forEach(async (change) => {
                if (change.type === 'added') {
                  const offer = change.doc.data();
                  callback(offer);
                  try {
                    await change.doc.ref.delete();
                  } catch (e) {}
                }
              });
            });
          this.unsubscribers.push(unsub);
          return;
        } catch (e) {
          console.warn('[Signaling] Listen for offers fallback to polling:', e.message);
        }
      }

      this.startPolling(code, peerId, (pollData) => {
        if (pollData.offers && pollData.offers.length > 0) {
          pollData.offers.forEach(callback);
        }
      });
    }

    /**
     * Send WebRTC Answer
     */
    async sendAnswer(code, peerId, to, answer) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          await this.db.collection('transfers')
            .doc(code)
            .collection('answers')
            .add({
              from: peerId,
              to: to || '',
              sdp: answer.sdp,
              type: answer.type,
              createdAt: Date.now()
            });
          return;
        } catch (e) {
          console.warn('[Signaling] Failed to send answer to Firestore, trying AJAX:', e.message);
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
     * Listen for WebRTC Answers
     */
    listenForAnswers(code, peerId, callback) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          const unsub = this.db.collection('transfers')
            .doc(code)
            .collection('answers')
            .where('to', '==', peerId)
            .limit(1)
            .onSnapshot((snapshot) => {
              snapshot.docChanges().forEach(async (change) => {
                if (change.type === 'added') {
                  const answer = change.doc.data();
                  callback(answer);
                  try {
                    await change.doc.ref.delete();
                  } catch (e) {}
                }
              });
            });
          this.unsubscribers.push(unsub);
          return;
        } catch (e) {
          console.warn('[Signaling] Listen for answers fallback to polling:', e.message);
        }
      }

      this.startPolling(code, peerId, (pollData) => {
        if (pollData.answers && pollData.answers.length > 0) {
          pollData.answers.forEach(callback);
        }
      });
    }

    /**
     * Send ICE Candidate
     */
    async sendCandidate(code, peerId, to, candidate) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          await this.db.collection('transfers')
            .doc(code)
            .collection('candidates')
            .add({
              from: peerId,
              to: to || '',
              candidate: candidate.toJSON ? candidate.toJSON() : candidate,
              createdAt: Date.now()
            });
          return;
        } catch (e) {
          console.warn('[Signaling] Failed to send candidate to Firestore, trying AJAX:', e.message);
        }
      }

      await ajax.post(CONFIG.SIGNALING_API_URL, {
        action: 'candidate',
        code,
        peerId,
        to,
        candidate: candidate.toJSON ? candidate.toJSON() : candidate
      });
    }

    /**
     * Listen for ICE Candidates
     */
    listenForCandidates(code, peerId, callback) {
      if (!this.useAjaxFallback && this.firebaseInitialized) {
        try {
          const unsub = this.db.collection('transfers')
            .doc(code)
            .collection('candidates')
            .where('to', '==', peerId)
            .limit(20)
            .onSnapshot((snapshot) => {
              snapshot.docChanges().forEach(async (change) => {
                if (change.type === 'added') {
                  const cand = change.doc.data();
                  callback(cand.candidate);
                  try {
                    await change.doc.ref.delete();
                  } catch (e) {}
                }
              });
            });
          this.unsubscribers.push(unsub);
          return;
        } catch (e) {
          console.warn('[Signaling] Listen for candidates fallback to polling:', e.message);
        }
      }

      this.startPolling(code, peerId, (pollData) => {
        if (pollData.candidates && pollData.candidates.length > 0) {
          pollData.candidates.forEach(c => callback(c.candidate || c));
        }
      });
    }

    /**
     * Mark transfer as complete
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
     * Starts AJAX polling when Firestore listeners are unavailable
     */
    startPolling(code, peerId, onUpdate, intervalMs = 1200) {
      if (this.activePollingInterval) return;

      this.activePollingInterval = setInterval(async () => {
        try {
          const response = await ajax.post(CONFIG.SIGNALING_API_URL, {
            action: 'poll',
            code,
            peerId
          }, { timeout: 3000, retries: 0 });

          if (response) {
            onUpdate(response);
          }
        } catch (e) {
          // Ignore poll errors quietly
        }
      }, intervalMs);
    }

    /**
     * Cleans up all listeners, polling intervals, and session handles
     */
    cleanup(code) {
      if (this.activePollingInterval) {
        clearInterval(this.activePollingInterval);
        this.activePollingInterval = null;
      }

      this.unsubscribers.forEach(unsub => {
        try {
          if (typeof unsub === 'function') unsub();
        } catch (e) {}
      });
      this.unsubscribers = [];

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
