let pollTimer = null;

function clearPollTimer() {
    if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}

function scheduleNextRefresh(hasActiveDownloads) {
    clearPollTimer();

    if (!hasActiveDownloads) {
        return;
    }

    pollTimer = setTimeout(() => {
        loadDownloads().catch((error) => showStatus(error.message, 'error'));
    }, 500);
}

// Load and display downloads
async function loadDownloads() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS' });
    const downloadsList = document.getElementById('downloads-list');
    const settings = await loadSettings();
    
    if (!response.downloads || response.downloads.length === 0) {
        downloadsList.innerHTML = '<p class="placeholder">No active downloads</p>';
        scheduleNextRefresh(false);
        return;
    }

    const hasActiveDownloads = response.downloads.some((dl) => (
        dl.status === 'downloading' || dl.status === 'pending' || dl.status === 'intercepted'
    ));
    
    downloadsList.innerHTML = response.downloads.map(dl => {
        const totalBytes = Number(dl.totalBytes) || 0;
        const progress = Number(dl.progress) || 0;
        const percent = totalBytes > 0 ? (progress / totalBytes * 100).toFixed(1) : '0.0';
        const safeId = String(dl.id).replace(/'/g, "\\'");
        const isComplete = dl.status === 'completed';
        const isIntercepted = dl.status === 'intercepted';
        const downloadDir = escapeHtml(dl.downloadDir || settings.downloadDir || '');

        return `
        <div class="download-item">
            <div class="download-name">${escapeHtml(dl.filename)}</div>
            <div class="download-info">
                <span class="status ${dl.status}">${dl.status.toUpperCase()}</span>
                <span>${formatBytes(progress)} / ${formatBytes(totalBytes)}</span>
            </div>
            <div class="progress-bar ${isIntercepted ? 'is-hidden' : ''}">
                <div class="progress-fill" style="width: ${percent}%"></div>
            </div>
            <div class="download-stats">
                <div class="stat">
                    <span class="stat-label">Speed:</span>
                    <span>${dl.speed ? formatBytes(dl.speed) + '/s' : '—'}</span>
                </div>
                <div class="stat">
                    <span class="stat-label">ETA:</span>
                    <span>${dl.eta ? formatTime(dl.eta) : '—'}</span>
                </div>
            </div>
            ${isIntercepted ? `
                <div class="settings-group intercept-dir-group">
                    <label for="dir-${safeId}">Download Directory:</label>
                    <input type="text" id="dir-${safeId}" class="intercept-dir-input" data-download-id="${safeId}" value="${downloadDir}" placeholder="/home/user/Downloads">
                    <button class="btn-browse" data-role="browse-dir" data-download-id="${safeId}">Browse</button>
                </div>
                <div class="download-actions">
                    <button class="btn-small btn-primary-action" data-role="start-intercepted" data-download-id="${safeId}">Download</button>
                    <button class="btn-small btn-cancel" data-role="dismiss-intercepted" data-download-id="${safeId}">Cancel</button>
                </div>
            ` : ''}
            ${dl.status === 'downloading' ? `
                <div class="download-actions">
                    <button class="btn-small btn-cancel" data-download-id="${safeId}">Cancel</button>
                </div>
            ` : ''}
            ${isComplete ? `
                <div class="download-actions">
                    <button class="btn-small btn-open-dir" data-download-id="${safeId}">Open Directory</button>
                </div>
            ` : ''}
        </div>
    `;
    }).join('');

    scheduleNextRefresh(hasActiveDownloads);
}

// Settings management
async function loadSettings() {
    const settings = await chrome.storage.sync.get([
        'threadCount',
        'downloadDir',
        'authToken',
        'minFileSize'
    ]);

    return {
        threadCount: settings.threadCount || '8',
        downloadDir: settings.downloadDir || '',
        authToken: settings.authToken || '',
        minFileSize: settings.minFileSize !== false
    };
}

function showStatus(message, type) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = `status-message show ${type}`;
    setTimeout(() => {
        statusEl.classList.remove('show');
    }, 3000);
}

function cancelDownload(downloadId) {
    return chrome.runtime.sendMessage({
        type: 'CANCEL_DOWNLOAD',
        downloadId
    });
}

function openDownloadDirectory(downloadId) {
    chrome.runtime.sendMessage({
        type: 'OPEN_DOWNLOAD_DIRECTORY',
        downloadId
    });
}

async function startInterceptedDownload(downloadId, downloadDir) {
    await chrome.storage.sync.set({ downloadDir });
    return chrome.runtime.sendMessage({
        type: 'START_INTERCEPTED_DOWNLOAD',
        downloadId,
        downloadDir
    });
}

function dismissInterceptedDownload(downloadId) {
    return chrome.runtime.sendMessage({
        type: 'DISMISS_INTERCEPTED_DOWNLOAD',
        downloadId
    });
}

function clearHistory() {
    return chrome.runtime.sendMessage({
        type: 'CLEAR_HISTORY'
    });
}

function openSettingsPage() {
    if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
        return;
    }

    chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html') });
}

document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    clearHistory()
        .then((response) => {
            if (response && response.ok === false) {
                showStatus(response.error || 'Failed to clear history', 'error');
                return;
            }
            showStatus(`Removed ${response?.removed_count ?? 0} history entries`, 'success');
            loadDownloads();
        })
        .catch((error) => showStatus(error.message, 'error'));
});

document.getElementById('openSettingsBtn').addEventListener('click', () => {
    openSettingsPage();
});

document.getElementById('downloads-list').addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const downloadId = target.getAttribute('data-download-id');
    if (!downloadId) {
        return;
    }

    if (target.getAttribute('data-role') === 'browse-dir') {
        alert('Please enter the download directory path manually.\n\nExamples:\n• /home/user/Downloads\n• /tmp\n• ~/Downloads');
        return;
    }

    if (target.getAttribute('data-role') === 'start-intercepted') {
        const input = document.getElementById(`dir-${downloadId}`);
        const downloadDir = input instanceof HTMLInputElement ? input.value.trim() : '';
        startInterceptedDownload(downloadId, downloadDir)
            .then((response) => {
                if (response && response.ok === false) {
                    showStatus(response.error || 'Failed to start download', 'error');
                    return;
                }
                showStatus('Download started', 'success');
                loadDownloads();
            })
            .catch((error) => showStatus(error.message, 'error'));
        return;
    }

    if (target.getAttribute('data-role') === 'dismiss-intercepted') {
        dismissInterceptedDownload(downloadId)
            .then(() => loadDownloads())
            .catch((error) => showStatus(error.message, 'error'));
        return;
    }

    if (target.classList.contains('btn-cancel')) {
        cancelDownload(downloadId)
            .then((response) => {
                if (response && response.ok === false) {
                    showStatus(response.error || 'Failed to cancel download', 'error');
                    return;
                }
                showStatus('Download cancelled', 'success');
                loadDownloads();
            })
            .catch((error) => showStatus(error.message, 'error'));
        return;
    }

    if (target.classList.contains('btn-open-dir')) {
        openDownloadDirectory(downloadId);
    }
});

// Listen for progress updates
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'DOWNLOAD_PROGRESS_UPDATE' || request.type === 'DOWNLOAD_PROGRESS') {
        loadDownloads();
    }
});

// Initial load
loadDownloads();

window.addEventListener('beforeunload', () => {
    clearPollTimer();
});

// Utility functions
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function formatTime(seconds) {
    if (seconds < 60) return Math.round(seconds) + 's';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm';
    return (seconds / 3600).toFixed(1) + 'h';
}

function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}
