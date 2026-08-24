/**
 * OmShare - Main Application UI Controller
 * Integrates WebRTC streaming, hybrid signaling, AJAX diagnostics, and reactive UI updates.
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

      // Safe DOM initialization
      if (!this.initElements()) {
        console.log('[OmShare] UI elements not present on this page, skipping controller binding.');
        return;
      }

      this.bindEvents();
      this.initNetworkStatus();
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
      this.sendStatusEl = document.getElementById('send-status');
      this.sendProgressEl = document.getElementById('send-progress');
      this.progressFill = document.getElementById('progress-fill');
      this.progressPercentEl = document.getElementById('progress-percent');
      this.progressSpeedEl = document.getElementById('progress-speed');
      this.cancelSendBtn = document.getElementById('cancel-send');

      // Receive panel elements
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

      // Status indicator
      this.connectionStatusEl = document.getElementById('connection-status');

      // Return true if critical elements are found
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
      if (this.cancelSendBtn) this.cancelSendBtn.addEventListener('click', () => this.cancelTransfer());

      // Receive actions
      if (this.codeInput) {
        this.codeInput.addEventListener('input', (e) => {
          e.target.value = e.target.value.replace(/[^0-9]/g, '');
          if (this.connectBtn) {
            this.connectBtn.disabled = e.target.value.length !== 6;
          }
        });

        this.codeInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter' && this.codeInput.value.length === 6) {
            this.startReceiving();
          }
        });
      }

      if (this.connectBtn) this.connectBtn.addEventListener('click', () => this.startReceiving());
      if (this.cancelReceiveBtn) this.cancelReceiveBtn.addEventListener('click', () => this.cancelTransfer());
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

    async startSending() {
      if (!this.currentFile) {
        showToast('Please select a file first', 'error');
        return;
      }

      this.createCodeBtn.disabled = true;
      this.createCodeBtn.innerHTML = '<span>Generating...</span>';

      try {
        this.webrtc = new WebRTCManager();
        this.bindWebRTCEvents(this.webrtc, true);

        const code = await this.webrtc.createTransfer(this.currentFile);
        this.shareCodeEl.textContent = code;
        this.filePreview.classList.add('hidden');
        this.sharingPanel.classList.remove('hidden');
        showToast(`Code generated: ${code}`, 'success');
      } catch (error) {
        console.error('Failed to create transfer:', error);
        showToast(error.message || 'Failed to create transfer', 'error');
      } finally {
        this.createCodeBtn.disabled = false;
        this.createCodeBtn.innerHTML = `<span>Generate Code</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
      }
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
        this.bindWebRTCEvents(this.webrtc, false);

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
        this.connectBtn.innerHTML = `<span>Connect</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>`;
      }
    }

    bindWebRTCEvents(manager, isSender) {
      this.transferStartTime = Date.now();

      manager.on('status', (message) => {
        if (isSender && this.sendStatusEl) {
          this.sendStatusEl.textContent = message;
        } else if (!isSender && this.receiveStatusEl) {
          this.receiveStatusEl.textContent = message;
        }
      });

      manager.on('connected', () => {
        if (this.connectionStatusEl) this.connectionStatusEl.textContent = 'Direct P2P Connected';
        if (!isSender && this.receiveStatusEl) {
          this.receiveStatusEl.textContent = 'Receiving stream...';
        }
      });

      manager.on('progress', (progress) => {
        const elapsed = (Date.now() - this.transferStartTime) / 1000;
        const bytes = progress.bytesTransferred || 0;
        const speed = elapsed > 0 ? bytes / elapsed : 0;

        if (isSender) {
          if (this.sendProgressEl) this.sendProgressEl.classList.remove('hidden');
          if (this.progressFill) this.progressFill.style.width = progress.percent + '%';
          if (this.progressPercentEl) this.progressPercentEl.textContent = Math.round(progress.percent) + '%';
          if (this.progressSpeedEl) this.progressSpeedEl.textContent = formatSpeed(speed);
        } else {
          if (this.receiveProgressEl) this.receiveProgressEl.classList.remove('hidden');
          if (this.receiveProgressFill) this.receiveProgressFill.style.width = progress.percent + '%';
          if (this.receivePercentEl) this.receivePercentEl.textContent = Math.round(progress.percent) + '%';
          if (this.receiveSpeedEl) this.receiveSpeedEl.textContent = formatSpeed(speed);
        }
      });

      manager.on('complete', () => {
        if (isSender) {
          if (this.sendStatusEl) this.sendStatusEl.textContent = '✓ File transferred successfully!';
          showToast('File sent successfully!', 'success');
        } else {
          if (this.receiveStatusEl) this.receiveStatusEl.textContent = '✓ Download completed!';
          showToast('File downloaded successfully!', 'success');
        }
        if (this.connectionStatusEl) this.connectionStatusEl.textContent = 'Transfer Complete';
      });

      manager.on('error', (error) => {
        showToast(error.message || 'Transfer interrupted', 'error');
        this.cancelTransfer();
      });
    }

    copyCode() {
      const code = this.shareCodeEl.textContent;
      if (!code) return;

      navigator.clipboard.writeText(code).then(() => {
        this.copyCodeBtn.classList.add('copied');
        setTimeout(() => this.copyCodeBtn.classList.remove('copied'), 2000);
        showToast('Code copied to clipboard!', 'success');
      }).catch(() => {
        showToast('Code: ' + code, 'success');
      });
    }

    cancelTransfer() {
      if (this.webrtc) {
        this.webrtc.cancel();
        this.webrtc = null;
      }

      if (this.sharingPanel) this.sharingPanel.classList.add('hidden');
      if (this.receivingPanel) this.receivingPanel.classList.add('hidden');
      if (this.inputSection) this.inputSection.classList.remove('hidden');
      if (this.sendProgressEl) this.sendProgressEl.classList.add('hidden');
      if (this.receiveProgressEl) this.receiveProgressEl.classList.add('hidden');

      if (this.codeInput) this.codeInput.value = '';
      if (this.connectBtn) this.connectBtn.disabled = true;

      this.clearFile();

      if (this.connectionStatusEl) this.connectionStatusEl.textContent = 'Ready';
      if (this.sendStatusEl) this.sendStatusEl.textContent = 'Waiting for receiver...';
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
