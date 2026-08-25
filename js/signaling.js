/**
 * OmShare - Hybrid Ultra-Fast Multi-Device Signaling & Relay Manager
 * Real-time sub-second WebRTC signaling via single-document Firestore streams (primary)
 * with automatic seamless chunk relay failover for strict mobile CGNAT networks.
 */

(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./config.js'), require('./ajax.js'));
  } else {
    root.OmSignaling = factory(root.OmConfig, root.OmAjax);
  }
})(typeof self !== 'undefined' ? self : this, function(CONFIG, ajax) {
  'use strict';

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

  class HybridSignalingManager {
    constructor() {
      this.db = null;
      this.firebaseInitialized = false;
      this.useAjaxFallback = false;
      this.activePollingInterval = null;
      this.unsubscribers = [];
      this.processedCandidateKeys = new Set();
      this.processedChunkIndices = new Set();
      this.handledReceivers = new Set();
      this.handledAnswers = new Set();
      this.handledRelayRequests = new Set();

      this.initFirebase();
      this.bindNetworkEvents();
    }

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

    async createTransfer(code, peerId, fileInfo, clientIP) {
      if (!this.useAjaxFallback && this.firebaseInitialized && this.db) {
        try {
          const transferDoc = this.db.collection('transfers').doc(code);
          await transferDoc.set({
            code,
            senderId: peerId,
            receiverIds: [],
            receiverId: null,
            fileName: fileInfo.name,
            fileSize: fileInfo.size,
            fileType: fileInfo.type || 'application/octet-stream',
            totalChunks: fileInfo.totalChunks,
            createdAt: Date.now(),
            expiresAt: Date.now() + CONFIG.CODE_EXPIRY,
            status: 'sharing',
            downloadsCount: 0,
            offers: {},
            answers: {},
            senderCandidates: [],
            receiverCandidates: [],
            relayRequests: [],
            clientIP: clientIP || 'unknown'
          });

          return { mode: 'firebase', code };
        } catch (err) {
          console.warn('[Signaling] Firestore createTransfer failed, switching to fast AJAX:', err.message);
          this.useAjaxFallback = true;
        }
      }

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

    async joinTransfer(code, peerId, clientIP) {
      if (!this.useAjaxFallback && this.firebaseInitialized && this.db) {
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

          await transferDoc.update({
            receiverId: peerId,
            receiverIds: firebase.firestore.FieldValue.arrayUnion(peerId),
            receiverIP: clientIP || 'unknown',
            latestJoinAt: Date.now()
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

    listenSession(code, isSender, peerId, handlers) {
      if (!this.useAjaxFallback && this.firebaseInitialized && this.db) {
        try {
          let hasHandledOffer = false;

          const unsub = this.db.collection('transfers').doc(code).onSnapshot(
            (snapshot) => {
              if (!snapshot.exists) return;
              const data = snapshot.data();
              if (!data) return;

              if (isSender) {
                // Sender detects when any receiver joins
                const recList = data.receiverIds || (data.receiverId ? [data.receiverId] : []);
                recList.forEach(recId => {
                  if (recId && !this.handledReceivers.has(recId) && handlers.onReceiverJoined) {
                    this.handledReceivers.add(recId);
                    handlers.onReceiverJoined(recId);
                  }
                });

                // Sender listens for Answers from any receiver
                if (data.answers && typeof data.answers === 'object') {
                  Object.entries(data.answers).forEach(([recId, ans]) => {
                    const key = recId + '_' + (ans.timestamp || '');
                    if (!this.handledAnswers.has(key) && handlers.onAnswer) {
                      this.handledAnswers.add(key);
                      handlers.onAnswer(ans, recId);
                    }
                  });
                } else if (data.answer && !this.handledAnswers.has('legacy') && handlers.onAnswer) {
                  this.handledAnswers.add('legacy');
                  handlers.onAnswer(data.answer, data.receiverId);
                }

                // Sender listens for incoming receiver candidates
                if (data.receiverCandidates && Array.isArray(data.receiverCandidates) && handlers.onCandidate) {
                  data.receiverCandidates.forEach(cand => {
                    const cleaned = cleanCandidate(cand.candidate || cand);
                    if (!cleaned) return;
                    const key = JSON.stringify(cleaned) + '_' + (cand.from || '');
                    if (!this.processedCandidateKeys.has(key)) {
                      this.processedCandidateKeys.add(key);
                      handlers.onCandidate(cleaned, cand.from);
                    }
                  });
                }

                // Sender listens for relay fallback requests
                if (data.relayRequests && Array.isArray(data.relayRequests) && handlers.onRelayRequested) {
                  data.relayRequests.forEach(reqId => {
                    if (reqId && !this.handledRelayRequests.has(reqId)) {
                      this.handledRelayRequests.add(reqId);
                      handlers.onRelayRequested(reqId);
                    }
                  });
                }
              } else {
                // Receiver listens for its specific Offer
                const targetedOffer = data.offers?.[peerId] || data.offer;
                if (targetedOffer && !hasHandledOffer && handlers.onOffer) {
                  if (!targetedOffer.to || targetedOffer.to === peerId) {
                    hasHandledOffer = true;
                    handlers.onOffer(targetedOffer);
                  }
                }

                // Receiver listens for incoming sender candidates
                if (data.senderCandidates && Array.isArray(data.senderCandidates) && handlers.onCandidate) {
                  data.senderCandidates.forEach(cand => {
                    if (cand.to && cand.to !== peerId) return;
                    const cleaned = cleanCandidate(cand.candidate || cand);
                    if (!cleaned) return;
                    const key = JSON.stringify(cleaned);
                    if (!this.processedCandidateKeys.has(key)) {
                      this.processedCandidateKeys.add(key);
                      handlers.onCandidate(cleaned);
                    }
                  });
                }

                // Receiver listens for incoming relay chunks in real-time
                if (data.chunks && Array.isArray(data.chunks) && handlers.onRelayChunk) {
                    if (ch.to && ch.to !== peerId) return;
                    const key = `${ch.chunkIndex}_${ch.timestamp || ''}`;
                    if (!this.processedChunkIndices.has(key)) {
                      this.processedChunkIndices.add(key);
                      handlers.onRelayChunk(ch);
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

      this.startFastPolling(code, peerId, isSender, handlers);
    }

    async sendOffer(code, peerId, to, offer) {
      const offerData = {
        from: peerId,
        to: to || '',
        sdp: String(offer.sdp || ''),
        type: String(offer.type || 'offer'),
        timestamp: Date.now()
      };

      if (!this.useAjaxFallback && this.firebaseInitialized && this.db) {
        try {
          const updatePayload = { offer: offerData };
          if (to) updatePayload[`offers.${to}`] = offerData;
          await this.db.collection('transfers').doc(code).update(updatePayload);
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
        offer: offerData
      });
    }

    async sendAnswer(code, peerId, to, answer) {
      const answerData = {
        from: peerId,
        to: to || '',
        sdp: String(answer.sdp || ''),
        type: String(answer.type || 'answer'),
        timestamp: Date.now()
      };

      if (!this.useAjaxFallback && this.firebaseInitialized && this.db) {
        try {
          const updatePayload = { answer: answerData };
          if (peerId) updatePayload[`answers.${peerId}`] = answerData;
          await this.db.collection('transfers').doc(code).update(updatePayload);
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
        answer: answerData
      });
    }

    sendCandidate(code, peerId, to, isSender, candidate) {
      const cleaned = cleanCandidate(candidate);
      if (!cleaned || !cleaned.candidate) return;

      const payload = {
        from: peerId,
        to: to || '',
        candidate: cleaned,
        timestamp: Date.now()
      };

      if (!this.useAjaxFallback && this.firebaseInitialized && typeof firebase !== 'undefined' && this.db) {
        try {
          const fieldName = isSender ? 'senderCandidates' : 'receiverCandidates';
          const transferDoc = this.db.collection('transfers').doc(code);
          transferDoc.update({
            [fieldName]: firebase.firestore.FieldValue.arrayUnion(payload)
          }).catch(() => {
            ajax.post(CONFIG.SIGNALING_API_URL, {
              action: 'candidate',
              code,
              peerId,
              to: to || '',
              candidate: cleaned
            }).catch(() => {});
          });
          return;
        } catch (e) {}
      }

      ajax.post(CONFIG.SIGNALING_API_URL, {
        action: 'candidate',
        code,
        peerId,
        to: to || '',
        candidate: cleaned
      }).catch(() => {});
    }

    /**
     * Receiver requests relay fallback when WebRTC P2P handshake cannot punch through strict NAT
     */
    async requestRelay(code, receiverId, handlers) {
      console.log(`[Signaling] Requesting relay fallback for receiver ${receiverId}`);
      if (!this.useAjaxFallback && this.firebaseInitialized && this.db) {
        try {
          await this.db.collection('transfers').doc(code).update({
            relayRequests: firebase.firestore.FieldValue.arrayUnion(receiverId)
          });
        } catch (e) {}
      }

      await ajax.post(CONFIG.SIGNALING_API_URL, {
        action: 'request-relay',
        code,
        peerId: receiverId
      }).catch(() => {});

      if (handlers) {
        this.startFastPolling(code, receiverId, false, handlers, 80);
      }
    }

    /**
     * Sender streams file chunks via serverless/signaling relay
     */
    async sendRelayChunk(code, senderId, receiverId, chunkIndex, totalChunks, base64Data, completed) {
      await ajax.post(CONFIG.SIGNALING_API_URL, {
        action: 'chunk',
        code,
        peerId: senderId,
        to: receiverId,
        chunkIndex,
        totalChunks,
        data: base64Data,
        completed: Boolean(completed)
      });
    }

    startFastPolling(code, peerId, isSender, handlers, intervalMs = 120) {
      if (this.activePollingInterval) return;

      let hasHandledOffer = false;

      this.activePollingInterval = setInterval(async () => {
        try {
          const response = await ajax.post(CONFIG.SIGNALING_API_URL, {
            action: 'poll',
            code,
            peerId
          }, { timeout: 2500, retries: 0 });

          if (!response) return;

          if (isSender) {
            const recList = response.receivers || (response.receiverId ? [response.receiverId] : []);
            recList.forEach(recId => {
              if (recId && !this.handledReceivers.has(recId) && handlers.onReceiverJoined) {
                this.handledReceivers.add(recId);
                handlers.onReceiverJoined(recId);
              }
            });

            if (response.answers && response.answers.length > 0 && handlers.onAnswer) {
              response.answers.forEach(ans => {
                const key = ans.from + '_' + (ans.timestamp || '');
                if (!this.handledAnswers.has(key)) {
                  this.handledAnswers.add(key);
                  handlers.onAnswer(ans, ans.from);
                }
              });
            }

            if (response.candidates && response.candidates.length > 0 && handlers.onCandidate) {
              response.candidates.forEach(c => {
                const cleaned = cleanCandidate(c.candidate || c);
                if (!cleaned) return;
                const key = JSON.stringify(cleaned) + '_' + (c.from || '');
                if (!this.processedCandidateKeys.has(key)) {
                  this.processedCandidateKeys.add(key);
                  handlers.onCandidate(cleaned, c.from);
                }
              });
            }

            if (response.relayRequests && response.relayRequests.length > 0 && handlers.onRelayRequested) {
              response.relayRequests.forEach(reqId => {
                if (reqId && !this.handledRelayRequests.has(reqId)) {
                  this.handledRelayRequests.add(reqId);
                  handlers.onRelayRequested(reqId);
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
                const cleaned = cleanCandidate(c.candidate || c);
                if (!cleaned) return;
                const key = JSON.stringify(cleaned);
                if (!this.processedCandidateKeys.has(key)) {
                  this.processedCandidateKeys.add(key);
                  handlers.onCandidate(cleaned);
                }
              });
            }

            // Receiver receives incoming relay chunks
            if (response.chunks && response.chunks.length > 0 && handlers.onRelayChunk) {
              response.chunks.forEach(ch => {
                const key = `${ch.chunkIndex}_${ch.timestamp}`;
                if (!this.processedChunkIndices.has(key)) {
                  this.processedChunkIndices.add(key);
                  handlers.onRelayChunk(ch);
                }
              });
            }
          }
        } catch (e) {}
      }, intervalMs);
    }

    async markReceiverComplete(code, receiverId) {
      if (!this.useAjaxFallback && this.firebaseInitialized && this.db) {
        try {
          await this.db.collection('transfers').doc(code).update({
            downloadsCount: firebase.firestore.FieldValue.increment(1),
            latestCompletedAt: Date.now()
          });
        } catch (e) {}
      }

      try {
        await ajax.post(CONFIG.SIGNALING_API_URL, { action: 'complete', code, receiverId });
      } catch (e) {}
    }

    async stopSharing(code) {
      if (this.activePollingInterval) {
        clearInterval(this.activePollingInterval);
        this.activePollingInterval = null;
      }

      this.unsubscribers.forEach(unsub => {
        try { if (typeof unsub === 'function') unsub(); } catch (e) {}
      });
      this.unsubscribers = [];
      this.processedCandidateKeys.clear();
      this.processedChunkIndices.clear();
      this.handledReceivers.clear();
      this.handledAnswers.clear();
      this.handledRelayRequests.clear();

      if (code) {
        if (!this.useAjaxFallback && this.firebaseInitialized && this.db) {
          try {
            await this.db.collection('transfers').doc(code).delete();
          } catch (e) {}
        }
        try {
          await ajax.post(CONFIG.SIGNALING_API_URL, { action: 'cancel', code });
        } catch (e) {}
      }
    }

    cleanup(code) {
      return this.stopSharing(code);
    }
  }

  return HybridSignalingManager;
});
