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
      this.selectedFiles = [];
      this.isFolder = false;
      this.folderName = '';
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
      this.folderInput = document.getElementById('folder-input');
      this.btnBrowseFiles = document.getElementById('btn-browse-files');
      this.btnBrowseFolder = document.getElementById('btn-browse-folder');
      this.filePreview = document.getElementById('file-preview');
      this.filenameEl = document.getElementById('filename');
      this.filesizeEl = document.getElementById('filesize');
      this.previewIconBox = document.getElementById('preview-icon-box');
      this.batchTypeTag = document.getElementById('batch-type-tag');
      this.batchFileList = document.getElementById('batch-file-list');
      this.addMoreBtn = document.getElementById('add-more-btn');
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

      // File & Folder selection buttons
      if (this.btnBrowseFiles) {
        this.btnBrowseFiles.addEventListener('click', (e) => {
          e.stopPropagation();
          this.fileInput.click();
        });
      }
      if (this.btnBrowseFolder) {
        this.btnBrowseFolder.addEventListener('click', (e) => {
          e.stopPropagation();
          this.folderInput.click();
        });
      }
      if (this.addMoreBtn) {
        this.addMoreBtn.addEventListener('click', () => {
          this.fileInput.click();
        });
      }

      this.dropzone.addEventListener('click', (e) => {
        if (e.target.closest('.btn-dropzone')) return;
        this.fileInput.click();
      });

      this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
      if (this.folderInput) {
        this.folderInput.addEventListener('change', (e) => this.handleFolderSelect(e));
      }

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

      this.dropzone.addEventListener('drop', async (e) => {
        const scanned = await this.scanDroppedEntries(e.dataTransfer);
        if (scanned.length > 0) {
          this.addFiles(scanned);
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

    async scanDroppedEntries(dataTransfer) {
      const items = dataTransfer.items;
      const fileList = [];

      if (items && items.length > 0 && items[0].webkitGetAsEntry) {
        const queue = [];
        for (let i = 0; i < items.length; i++) {
          const entry = items[i].webkitGetAsEntry();
          if (entry) {
            if (entry.isDirectory && !this.folderName) {
              this.isFolder = true;
              this.folderName = entry.name;
            }
            queue.push(this.traverseEntry(entry, ''));
          }
        }
        const results = await Promise.all(queue);
        results.forEach(arr => fileList.push(...arr));
      } else if (dataTransfer.files) {
        for (let i = 0; i < dataTransfer.files.length; i++) {
          const f = dataTransfer.files[i];
          fileList.push({ file: f, path: f.name, name: f.name, size: f.size });
        }
      }
      return fileList;
    }

    traverseEntry(entry, path) {
      if (entry.isFile) {
        return new Promise((resolve) => {
          entry.file((file) => {
            resolve([{
              file: file,
              path: path ? `${path}/${file.name}` : file.name,
              name: file.name,
              size: file.size
            }]);
          }, () => resolve([]));
        });
      } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        const dirPath = path ? `${path}/${entry.name}` : entry.name;
        return new Promise((resolve) => {
          const readAllEntries = () => {
            dirReader.readEntries(async (entries) => {
              if (entries.length === 0) {
                resolve([]);
              } else {
                const promises = entries.map(e => this.traverseEntry(e, dirPath));
                const nested = await Promise.all(promises);
                const combined = nested.flat();
                dirReader.readEntries(async (moreEntries) => {
                  if (moreEntries.length > 0) {
                    const moreNested = await Promise.all(moreEntries.map(e => this.traverseEntry(e, dirPath)));
                    resolve(combined.concat(moreNested.flat()));
                  } else {
                    resolve(combined);
                  }
                }, () => resolve(combined));
              }
            }, () => resolve([]));
          };
          readAllEntries();
        });
      }
      return Promise.resolve([]);
    }

    handleFileSelect(e) {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        const items = files.map(f => ({
          file: f,
          path: f.name,
          name: f.name,
          size: f.size
        }));
        this.addFiles(items);
      }
      this.fileInput.value = '';
    }

    handleFolderSelect(e) {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        this.isFolder = true;
        const firstRel = files[0].webkitRelativePath || '';
        this.folderName = firstRel ? firstRel.split('/')[0] : 'Folder';

        const items = files.map(f => ({
          file: f,
          path: f.webkitRelativePath || f.name,
          name: f.name,
          size: f.size
        }));
        this.addFiles(items, true);
      }
      if (this.folderInput) this.folderInput.value = '';
    }

    addFiles(newItems, isFolder = false) {
      if (isFolder) {
        this.selectedFiles = newItems;
      } else {
        const existingPaths = new Set(this.selectedFiles.map(f => f.path));
        newItems.forEach(item => {
          if (!existingPaths.has(item.path)) {
            this.selectedFiles.push(item);
            existingPaths.add(item.path);
          }
        });
      }

      this.updateBatchPreview();
    }

    removeFileItem(index) {
      this.selectedFiles.splice(index, 1);
      if (this.selectedFiles.length === 0) {
        this.clearFile();
      } else {
        this.updateBatchPreview();
      }
    }

    updateBatchPreview() {
      if (this.selectedFiles.length === 0) {
        this.clearFile();
        return;
      }

      const count = this.selectedFiles.length;
      const totalSize = this.selectedFiles.reduce((acc, f) => acc + (f.size || 0), 0);

      this.dropzone.classList.add('hidden');
      this.filePreview.classList.remove('hidden');

      if (count === 1 && !this.isFolder) {
        const file = this.selectedFiles[0];
        if (this.filenameEl) this.filenameEl.textContent = file.name;
        if (this.filesizeEl) this.filesizeEl.textContent = formatSize(file.size);
        if (this.batchTypeTag) this.batchTypeTag.textContent = 'Single File';
        if (this.previewIconBox) this.previewIconBox.className = 'file-icon-box';
        if (this.batchFileList) this.batchFileList.classList.add('hidden');
      } else {
        const title = this.isFolder && this.folderName
          ? `${this.folderName} (${count} files)`
          : `${count} files selected`;
        
        if (this.filenameEl) this.filenameEl.textContent = title;
        if (this.filesizeEl) this.filesizeEl.textContent = formatSize(totalSize);
        if (this.batchTypeTag) this.batchTypeTag.textContent = this.isFolder ? 'Folder Archive' : 'Multi-File Batch';
        if (this.previewIconBox) this.previewIconBox.className = 'file-icon-box folder-icon-box';

        if (this.batchFileList) {
          this.batchFileList.innerHTML = this.selectedFiles.map((item, idx) => `
            <div class="batch-file-item">
              <div class="batch-file-item-left">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span class="batch-file-item-name" title="${item.path}">${item.path}</span>
              </div>
              <div class="batch-file-item-right">
                <span class="batch-file-item-size">${formatSize(item.size)}</span>
                <button type="button" class="batch-file-item-del" data-index="${idx}" title="Remove file">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
          `).join('');

          this.batchFileList.querySelectorAll('.batch-file-item-del').forEach(btn => {
            btn.addEventListener('click', (e) => {
              const idx = parseInt(btn.dataset.index, 10);
              this.removeFileItem(idx);
            });
          });

          this.batchFileList.classList.remove('hidden');
        }
      }
    }

    clearFile() {
      this.currentFile = null;
      this.selectedFiles = [];
      this.isFolder = false;
      this.folderName = '';
      if (this.fileInput) this.fileInput.value = '';
      if (this.folderInput) this.folderInput.value = '';
      if (this.dropzone) this.dropzone.classList.remove('hidden');
      if (this.filePreview) this.filePreview.classList.add('hidden');
      if (this.batchFileList) this.batchFileList.classList.add('hidden');
    }

    async packageFilesToZip(items, archiveName) {
      if (typeof JSZip === 'undefined') {
        throw new Error('JSZip compression engine not loaded. Please refresh.');
      }
      const zip = new JSZip();
      for (const item of items) {
        zip.file(item.path, item.file);
      }
      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 1 }
      });
      return new File([zipBlob], archiveName, { type: 'application/zip' });
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
      if (!this.selectedFiles || this.selectedFiles.length === 0) {
        showToast('Please select at least one file or folder', 'error');
        return;
      }

      this.createCodeBtn.disabled = true;

      try {
        let fileToTransfer = null;
        if (this.selectedFiles.length === 1 && !this.isFolder) {
          fileToTransfer = this.selectedFiles[0].file;
        } else {
          this.createCodeBtn.innerHTML = `<span>Packaging ${this.selectedFiles.length} files...</span>`;
          const archiveName = this.isFolder && this.folderName
            ? `${this.folderName}.zip`
            : `OmShare_Archive_${this.selectedFiles.length}_Files.zip`;
          fileToTransfer = await this.packageFilesToZip(this.selectedFiles, archiveName);
        }

        this.currentFile = fileToTransfer;
        this.createCodeBtn.innerHTML = '<span>Generating Session...</span>';

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
