/**
 * OmShare - Main Application UI Controller
 * Integrates WebRTC streaming, multi-device persistent sharing, reactive HUD updates,
 * and high-fidelity micro-interactions.
 */

(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./config.js'), require('./ajax.js'), require('./webrtc.js'));
  } else {
    root.OmShareApp = factory(root.OmConfig, root.OmAjax, root.OmWebRTC);
  }
})(typeof self !== 'undefined' ? self : this, function(CONFIG, ajax, WebRTCManager) {
  'use strict';

  function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatSpeed(bytesPerSecond) {
    return formatSize(bytesPerSecond) + '/s';
  }

  function playSuccessChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5

      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(880, now + 0.08); // A5
      osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.22); // D6

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now + 0.08);
      osc1.stop(now + 0.45);
      osc2.stop(now + 0.45);
    } catch (e) {}
  }

  function triggerHaptic() {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate([60, 40, 80]); } catch (e) {}
    }
  }

  function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'toast ' + type + ' visible';
    setTimeout(() => {
      toast.classList.remove('visible');
    }, 3500);
  }

  class OmShareUI {
    constructor() {
      this.webrtc = null;
      this.currentFile = null;
      this.transferStartTime = null;
      this.activeTransferCode = null;

      // Safe DOM initialization
      if (!this.initElements()) {
        console.log('[OmShare] UI elements not present on this page, skipping controller binding.');
        return;
      }

      this.bindEvents();
      this.initNetworkStatus();
      this.checkUrlParameters();
    }

    initElements() {
      // Tabs
      this.tabs = document.querySelectorAll('.tab');
      this.panels = document.querySelectorAll('.panel');

      // Send panel elements
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
      this.copyLinkBtn = document.getElementById('copy-link');
      this.toggleQrBtn = document.getElementById('toggle-qr');
      this.qrCard = document.getElementById('qr-card');
      this.qrContainer = document.getElementById('qr-container');
      this.stopSharingBtn = document.getElementById('stop-sharing');
      this.downloadsBadge = document.getElementById('downloads-badge');
      this.sendStatusEl = document.getElementById('send-status');
      this.sendStatusRipple = document.getElementById('send-status-ripple');
      this.sendProgressEl = document.getElementById('send-progress');
      this.progressFill = document.getElementById('progress-fill');
      this.progressPercentEl = document.getElementById('progress-percent');
      this.progressSpeedEl = document.getElementById('progress-speed');

      // Digit display boxes
      this.digitBoxes = [
        document.getElementById('digit-0'),
        document.getElementById('digit-1'),
        document.getElementById('digit-2'),
        document.getElementById('digit-3'),
        document.getElementById('digit-4'),
        document.getElementById('digit-5')
      ];

      // Receive panel elements
      this.codeInput = document.getElementById('code-input');
      this.connectBtn = document.getElementById('connect-btn');
      this.inputSection = document.getElementById('input-section');
      this.receivingPanel = document.getElementById('receiving-panel');
      this.incomingNameEl = document.getElementById('incoming-name');
      this.incomingSizeEl = document.getElementById('incoming-size');
      this.receiveStatusEl = document.getElementById('receive-status');
      this.receiveStatusRipple = document.getElementById('receive-status-ripple');
      this.receiveProgressEl = document.getElementById('receive-progress');
      this.receiveProgressFill = document.getElementById('receive-progress-fill');
      this.receivePercentEl = document.getElementById('receive-percent');
      this.receiveSpeedEl = document.getElementById('receive-speed');
      this.cancelReceiveBtn = document.getElementById('cancel-receive');

      // Global status indicator
      this.connectionStatusEl = document.getElementById('connection-status');

      return Boolean(this.dropzone && this.codeInput);
    }

    bindEvents() {
      // Tab navigation
      this.tabs.forEach(tab => {
        tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
      });

      // File selection
      this.dropzone.addEventListener('click', () => this.fileInput.click());
      this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

      // Drag & Drop
      ['dragenter', 'dragover'].forEach(eventName => {
        this.dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          this.dropzone.classList.add('dragover');
        });
      });

      ['dragleave', 'drop'].forEach(eventName => {
        this.dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          this.dropzone.classList.remove('dragover');
        });
      });

      this.dropzone.addEventListener('drop', (e) => {
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          this.selectFile(e.dataTransfer.files[0]);
        }
      });

      // File actions
      if (this.removeFileBtn) this.removeFileBtn.addEventListener('click', () => this.clearFile());
      if (this.createCodeBtn) this.createCodeBtn.addEventListener('click', () => this.startSending());
      if (this.copyCodeBtn) this.copyCodeBtn.addEventListener('click', () => this.copyCode());
      if (this.copyLinkBtn) this.copyLinkBtn.addEventListener('click', () => this.copyShareLink());
      if (this.toggleQrBtn) this.toggleQrBtn.addEventListener('click', () => this.toggleQrCode());
      if (this.stopSharingBtn) this.stopSharingBtn.addEventListener('click', () => this.stopSharing());

      // Receive actions
      if (this.codeInput) {
        this.codeInput.addEventListener('input', (e) => {
          e.target.value = e.target.value.replace(/[^0-9]/g, '');
          if (this.connectBtn) {
            this.connectBtn.disabled = e.target.value.length !== 6;
          }
          if (e.target.value.length === 6) {
            this.connectBtn.classList.add('ready-pulse');
          } else {
            this.connectBtn.classList.remove('ready-pulse');
          }
        });

        this.codeInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter' && this.codeInput.value.length === 6) {
            this.startReceiving();
          }
        });
      }

      if (this.connectBtn) this.connectBtn.addEventListener('click', () => this.startReceiving());
      if (this.cancelReceiveBtn) this.cancelReceiveBtn.addEventListener('click', () => this.cancelReceive());
    }

    checkUrlParameters() {
      if (typeof window === 'undefined' || !window.location) return;
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab');
      const codeParam = params.get('code');
      const autoConnect = params.get('auto');

      if (codeParam && codeParam.length === 6) {
        this.switchTab('receive');
        if (this.codeInput) {
          this.codeInput.value = codeParam;
          if (this.connectBtn) {
            this.connectBtn.disabled = false;
            this.connectBtn.classList.add('ready-pulse');
          }
          if (autoConnect === 'true' || autoConnect === '1') {
            setTimeout(() => this.startReceiving(), 300);
          }
        }
      } else if (tabParam === 'send') {
        this.switchTab('send');
      } else if (tabParam === 'receive') {
        this.switchTab('receive');
      }
    }

    async initNetworkStatus() {
      const updateStatus = async () => {
        const isOnline = await ajax.checkConnectivity();
        if (this.connectionStatusEl) {
          this.connectionStatusEl.textContent = isOnline ? 'Ready • Online' : 'Offline • Check Connection';
        }
      };

      window.addEventListener('online', updateStatus);
      window.addEventListener('offline', updateStatus);
      updateStatus();
    }

    switchTab(tabId) {
      this.tabs.forEach(t => t.classList.remove('active'));
      this.panels.forEach(p => p.classList.remove('active'));

      const targetTab = document.getElementById('tab-' + tabId);
      const targetPanel = document.getElementById('panel-' + tabId);

      if (targetTab) targetTab.classList.add('active');
      if (targetPanel) targetPanel.classList.add('active');
    }

    handleFileSelect(e) {
      const file = e.target.files[0];
      if (file) this.selectFile(file);
    }

    selectFile(file) {
      this.currentFile = file;
      if (this.filenameEl) this.filenameEl.textContent = file.name;
      if (this.filesizeEl) this.filesizeEl.textContent = formatSize(file.size);

      this.dropzone.classList.add('hidden');
      this.filePreview.classList.remove('hidden');
    }

    clearFile() {
      this.currentFile = null;
      if (this.fileInput) this.fileInput.value = '';
      if (this.dropzone) this.dropzone.classList.remove('hidden');
      if (this.filePreview) this.filePreview.classList.add('hidden');
    }

    renderCodeDigits(code) {
      this.activeTransferCode = String(code);
      if (this.shareCodeEl) this.shareCodeEl.textContent = String(code);
      const digits = String(code).split('');
      this.digitBoxes.forEach((box, index) => {
        if (box) {
          box.textContent = digits[index] || '-';
          box.classList.add('filled');
        }
      });

      // Render QR Code SVG
      this.renderQrCode(code);
    }

    renderQrCode(code) {
      if (!this.qrContainer) return;
      const shareUrl = `${window.location.origin}/?code=${code}&auto=1`;
      if (typeof OmQRCode !== 'undefined' && OmQRCode.generateSvg) {
        this.qrContainer.innerHTML = OmQRCode.generateSvg(shareUrl, { size: 160, margin: 2 });
      }
    }

    toggleQrCode() {
      if (!this.qrCard) return;
      const isHidden = this.qrCard.classList.contains('hidden');
      if (isHidden) {
        this.qrCard.classList.remove('hidden');
        if (this.toggleQrBtn) this.toggleQrBtn.classList.add('active-toggle');
        if (this.activeTransferCode) this.renderQrCode(this.activeTransferCode);
      } else {
        this.qrCard.classList.add('hidden');
        if (this.toggleQrBtn) this.toggleQrBtn.classList.remove('active-toggle');
      }
    }

    async startSending() {
      if (!this.currentFile) {
        showToast('Please select a file first', 'error');
        return;
      }

      this.createCodeBtn.disabled = true;
      this.createCodeBtn.innerHTML = '<span>Generating Session...</span>';

      try {
        this.webrtc = new WebRTCManager();
        this.bindWebRTCSenderEvents(this.webrtc);

        const code = await this.webrtc.createTransfer(this.currentFile);
        this.renderCodeDigits(code);

        this.filePreview.classList.add('hidden');
        this.sharingPanel.classList.remove('hidden');
        if (this.downloadsBadge) this.downloadsBadge.textContent = '0 downloads completed';
        if (this.sendStatusEl) this.sendStatusEl.textContent = 'Ready for receivers • Code active';
        showToast(`Share session live: ${code}`, 'success');
      } catch (error) {
        console.error('Failed to create transfer:', error);
        showToast(error.message || 'Failed to create transfer', 'error');
      } finally {
        this.createCodeBtn.disabled = false;
        this.createCodeBtn.innerHTML = `<span>Generate Share Code</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;
      }
    }

    bindWebRTCSenderEvents(manager) {
      manager.on('receiver-joined', ({ receiverId, count }) => {
        if (this.sendStatusEl) {
          this.sendStatusEl.textContent = `Streaming to device (${count} connected)...`;
        }
        if (this.sendStatusRipple) {
          this.sendStatusRipple.className = 'status-ripple active';
        }
        if (this.sendProgressEl) this.sendProgressEl.classList.remove('hidden');
        this.transferStartTime = Date.now();
      });

      manager.on('progress', (progress) => {
        const elapsed = (Date.now() - this.transferStartTime) / 1000;
        const bytes = progress.bytesTransferred || 0;
        const speed = elapsed > 0 ? bytes / elapsed : 0;

        if (this.sendProgressEl) this.sendProgressEl.classList.remove('hidden');
        if (this.progressFill) this.progressFill.style.width = progress.percent + '%';
        if (this.progressPercentEl) this.progressPercentEl.textContent = Math.round(progress.percent) + '%';
        if (this.progressSpeedEl) this.progressSpeedEl.textContent = formatSpeed(speed);
      });

      manager.on('receiver-completed', ({ downloadsCount }) => {
        const plural = downloadsCount === 1 ? 'download' : 'downloads';
        if (this.downloadsBadge) {
          this.downloadsBadge.textContent = `${downloadsCount} ${plural} completed`;
          this.downloadsBadge.classList.add('highlight-badge');
        }
        if (this.sendStatusEl) {
          this.sendStatusEl.textContent = `✓ Download finished! Code remains live for more devices.`;
        }
        if (this.sendStatusRipple) {
          this.sendStatusRipple.className = 'status-ripple waiting';
        }
        if (this.progressFill) this.progressFill.style.width = '100%';
        if (this.progressPercentEl) this.progressPercentEl.textContent = '100%';

        playSuccessChime();
        triggerHaptic();
        showToast(`Device downloaded file! (${downloadsCount} total)`, 'success');
      });

      manager.on('error', (error) => {
        showToast(error.message || 'Stream notice', 'error');
      });
    }

    async startReceiving() {
      const code = this.codeInput.value.trim();
      if (code.length !== 6) {
        showToast('Please enter a 6-digit code', 'error');
        return;
      }

      this.connectBtn.disabled = true;
      this.connectBtn.innerHTML = '<span>Connecting...</span>';

      try {
        this.webrtc = new WebRTCManager();
        this.bindWebRTCReceiverEvents(this.webrtc);

        const fileInfo = await this.webrtc.joinTransfer(code);
        this.inputSection.classList.add('hidden');
        this.receivingPanel.classList.remove('hidden');

        if (this.incomingNameEl) this.incomingNameEl.textContent = fileInfo.name;
        if (this.incomingSizeEl) this.incomingSizeEl.textContent = formatSize(fileInfo.size);

        showToast('Connected to sender!', 'success');
      } catch (error) {
        console.error('Failed to join transfer:', error);
        showToast(error.message || 'Failed to connect. Check code and try again.', 'error');
      } finally {
        this.connectBtn.disabled = false;
        this.connectBtn.innerHTML = `<span>Connect & Download</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
      }
    }

    bindWebRTCReceiverEvents(manager) {
      this.transferStartTime = Date.now();

      manager.on('connected', () => {
        if (this.connectionStatusEl) this.connectionStatusEl.textContent = 'Direct P2P Connected';
        if (this.receiveStatusEl) this.receiveStatusEl.textContent = 'Receiving stream...';
        if (this.receiveStatusRipple) this.receiveStatusRipple.className = 'status-ripple active';
        if (this.receiveProgressEl) this.receiveProgressEl.classList.remove('hidden');
      });

      manager.on('progress', (progress) => {
        const elapsed = (Date.now() - this.transferStartTime) / 1000;
        const bytes = progress.bytesTransferred || 0;
        const speed = elapsed > 0 ? bytes / elapsed : 0;

        if (this.receiveProgressEl) this.receiveProgressEl.classList.remove('hidden');
        if (this.receiveProgressFill) this.receiveProgressFill.style.width = progress.percent + '%';
        if (this.receivePercentEl) this.receivePercentEl.textContent = Math.round(progress.percent) + '%';
        if (this.receiveSpeedEl) this.receiveSpeedEl.textContent = formatSpeed(speed);
      });

      manager.on('complete', () => {
        if (this.receiveStatusEl) this.receiveStatusEl.textContent = '✓ File downloaded successfully!';
        if (this.receiveStatusRipple) this.receiveStatusRipple.className = 'status-ripple complete';
        if (this.connectionStatusEl) this.connectionStatusEl.textContent = 'Download Complete';

        playSuccessChime();
        triggerHaptic();
        showToast('File downloaded successfully!', 'success');
      });

      manager.on('error', (error) => {
        showToast(error.message || 'Connection interrupted', 'error');
        this.cancelReceive();
      });
    }

    copyCode() {
      const code = this.activeTransferCode || this.shareCodeEl.textContent;
      if (!code) return;

      navigator.clipboard.writeText(code).then(() => {
        this.copyCodeBtn.classList.add('copied');
        this.copyCodeBtn.querySelector('span').textContent = 'Copied!';
        setTimeout(() => {
          this.copyCodeBtn.classList.remove('copied');
          this.copyCodeBtn.querySelector('span').textContent = 'Copy Code';
        }, 2000);
        showToast('Code copied to clipboard!', 'success');
      }).catch(() => {
        showToast('Code: ' + code, 'success');
      });
    }

    copyShareLink() {
      const code = this.activeTransferCode || this.shareCodeEl.textContent;
      if (!code) return;

      const url = `${window.location.origin}/?code=${code}`;
      navigator.clipboard.writeText(url).then(() => {
        this.copyLinkBtn.classList.add('copied');
        this.copyLinkBtn.querySelector('span').textContent = 'Link Copied!';
        setTimeout(() => {
          this.copyLinkBtn.classList.remove('copied');
          this.copyLinkBtn.querySelector('span').textContent = 'Copy Link';
        }, 2000);
        showToast('Share link copied to clipboard!', 'success');
      }).catch(() => {
        showToast('Share link: ' + url, 'success');
      });
    }

    async stopSharing() {
      if (this.webrtc) {
        await this.webrtc.stopSharing();
        this.webrtc = null;
      }

      this.activeTransferCode = null;
      if (this.sharingPanel) this.sharingPanel.classList.add('hidden');
      if (this.sendProgressEl) this.sendProgressEl.classList.add('hidden');
      this.clearFile();

      if (this.connectionStatusEl) this.connectionStatusEl.textContent = 'Ready';
      if (this.sendStatusEl) this.sendStatusEl.textContent = 'Ready for receivers • Code active';
      showToast('Sharing session ended', 'info');
    }

    cancelReceive() {
      if (this.webrtc) {
        this.webrtc.cancel();
        this.webrtc = null;
      }

      if (this.receivingPanel) this.receivingPanel.classList.add('hidden');
      if (this.inputSection) this.inputSection.classList.remove('hidden');
      if (this.receiveProgressEl) this.receiveProgressEl.classList.add('hidden');

      if (this.codeInput) this.codeInput.value = '';
      if (this.connectBtn) this.connectBtn.disabled = true;

      if (this.connectionStatusEl) this.connectionStatusEl.textContent = 'Ready';
      if (this.receiveStatusEl) this.receiveStatusEl.textContent = 'Connecting...';
    }
  }

  // Initialize on DOM ready
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      window.omShareApp = new OmShareUI();
    });
  }

  return OmShareUI;
});
