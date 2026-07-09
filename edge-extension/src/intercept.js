const params = new URLSearchParams(window.location.search);
const downloadId = params.get('downloadId');

const fileNameInputEl = document.getElementById('fileNameInput');
const fileNameWarningEl = document.getElementById('fileNameWarning');
const fileSizeEl = document.getElementById('fileSize');
const threadCountEl = document.getElementById('threadCount');
const downloadDirEl = document.getElementById('downloadDir');
const preferNativeForWebsiteEl = document.getElementById('preferNativeForWebsite');
const browseBtn = document.getElementById('browseBtn');
const startBtn = document.getElementById('startBtn');
const nativeBtn = document.getElementById('nativeBtn');
const statusEl = document.getElementById('status');

let originalFilename = '';
let currentDownloadInfo = null;
let shouldDismissOnClose = true;
let userChangedDir = false;

function dismissInterceptedDownloadOnClose() {
    if (!shouldDismissOnClose || !downloadId) {
        return;
    }

    shouldDismissOnClose = false;
    chrome.runtime.sendMessage({
        type: 'DISMISS_INTERCEPTED_DOWNLOAD',
        downloadId
    }).catch(() => {});
}

window.addEventListener('pagehide', dismissInterceptedDownloadOnClose);

function showStatus(message, type = '') {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`.trim();
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return 'Unknown';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Number(bytes);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }

    return `${value.toFixed(2)} ${units[index]}`;
}

async function checkAndUpdateFileName() {
    const downloadDir = downloadDirEl.value.trim();
    const fileName = fileNameInputEl.value.trim();
    
    if (!fileName || !downloadDir) {
        fileNameWarningEl.textContent = '';
        return;
    }

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'CHECK_FILE_EXISTS',
            filename: fileName,
            downloadDir: downloadDir
        });

        if (!response || response.ok === false) {
            fileNameWarningEl.textContent = '';
            return;
        }

        if (response.exists) {
            fileNameWarningEl.textContent = '⚠ File exists. Click "Download" to overwrite.';
        } else {
            fileNameWarningEl.textContent = '';
        }
    } catch (error) {
        console.warn('[MTD] Failed to check file existence:', error);
        fileNameWarningEl.textContent = '';
    }
}

async function suggestNextFilename() {
    const downloadDir = downloadDirEl.value.trim();
    const fileName = fileNameInputEl.value.trim();
    
    if (!fileName || !downloadDir) {
        return;
    }

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'GET_NEXT_FILENAME',
            filename: fileName,
            downloadDir: downloadDir
        });

        if (!response || response.ok === false) {
            return;
        }

        if (response.nextFilename && response.nextFilename !== fileName) {
            fileNameInputEl.value = response.nextFilename;
            fileNameWarningEl.textContent = '';
        }
    } catch (error) {
        console.warn('[MTD] Failed to get next filename:', error);
    }
}

async function loadInterceptedDownload() {
    if (!downloadId) {
        showStatus('Missing intercepted download id', 'error');
        startBtn.disabled = true;
        nativeBtn.disabled = true;
        preferNativeForWebsiteEl.disabled = true;
        return;
    }

    const response = await chrome.runtime.sendMessage({
        type: 'GET_INTERCEPTED_DOWNLOAD',
        downloadId
    });

    if (!response || !response.download) {
        showStatus(response?.error || 'Intercepted download not found', 'error');
        startBtn.disabled = true;
        nativeBtn.disabled = true;
        preferNativeForWebsiteEl.disabled = true;
        return;
    }

    currentDownloadInfo = response.download;
    originalFilename = response.download.filename;
    fileNameInputEl.value = originalFilename;
    fileSizeEl.textContent = formatBytes(Number(response.download.totalBytes) || 0);
    threadCountEl.textContent = String(response.download.threadCount || 8);
    downloadDirEl.value = response.download.downloadDir || '';
    
    // Check if file already exists with default name
    await suggestNextFilename();
    // Then check and update warning
    await checkAndUpdateFileName();
}

browseBtn.addEventListener('click', async () => {
    browseBtn.disabled = true;
    showStatus('Opening directory picker...', '');

    try {
        const currentDirectory = downloadDirEl.value.trim();
        const response = await chrome.runtime.sendMessage({
            type: 'BROWSE_DIRECTORY',
            downloadDir: currentDirectory
        });

        if (!response || response.ok === false) {
            throw new Error(response?.error || 'Failed to browse for directory');
        }

        if (response.cancelled) {
            showStatus('Directory selection cancelled.', '');
            return;
        }

        if (response.path) {
            downloadDirEl.value = response.path;
            userChangedDir = true;
            showStatus('Directory selected.', 'success');
            // Check if filename exists in new directory
            await suggestNextFilename();
            await checkAndUpdateFileName();
        }
    } catch (error) {
        showStatus(error.message, 'error');
    } finally {
        browseBtn.disabled = false;
    }
});

fileNameInputEl.addEventListener('change', async () => {
    await checkAndUpdateFileName();
});

downloadDirEl.addEventListener('change', async () => {
    userChangedDir = true;
    // Check if filename exists in the new directory
    await suggestNextFilename();
    await checkAndUpdateFileName();
});

startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    nativeBtn.disabled = true;
    preferNativeForWebsiteEl.disabled = true;

    try {
        const preferNativeForWebsite = Boolean(preferNativeForWebsiteEl.checked);
        const customFilename = fileNameInputEl.value.trim();
        const downloadDir = downloadDirEl.value.trim();

        // Check if file exists and ask for confirmation
        if (customFilename && downloadDir) {
            try {
                const checkResponse = await chrome.runtime.sendMessage({
                    type: 'CHECK_FILE_EXISTS',
                    filename: customFilename,
                    downloadDir: downloadDir
                });

                if (checkResponse && checkResponse.ok !== false && checkResponse.exists) {
                    const confirmed = confirm(`The file "${customFilename}" already exists. Do you want to overwrite it?`);
                    if (!confirmed) {
                        showStatus('Download cancelled.', '');
                        startBtn.disabled = false;
                        nativeBtn.disabled = false;
                        preferNativeForWebsiteEl.disabled = false;
                        return;
                    }
                }
            } catch (error) {
                console.warn('[MTD] Failed to check file existence:', error);
            }
        }

        let response;

        if (preferNativeForWebsite) {
            showStatus('Starting browser download...', '');
            response = await chrome.runtime.sendMessage({
                type: 'USE_NATIVE_DOWNLOAD',
                downloadId,
                preferNativeForWebsite
            });
        } else {
            showStatus('Starting download...', '');
            response = await chrome.runtime.sendMessage({
                type: 'START_INTERCEPTED_DOWNLOAD',
                downloadId,
                downloadDir: downloadDir,
                filename: customFilename,
                skipSubdir: userChangedDir
            });
        }

        if (!response || response.ok === false) {
            throw new Error(response?.error || 'Failed to start download');
        }

        showStatus(preferNativeForWebsite ? 'Browser download started' : 'Download started', 'success');
        shouldDismissOnClose = false;
        window.close();
    } catch (error) {
        showStatus(error.message, 'error');
        startBtn.disabled = false;
        nativeBtn.disabled = false;
        preferNativeForWebsiteEl.disabled = false;
    }
});

nativeBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    nativeBtn.disabled = true;
    preferNativeForWebsiteEl.disabled = true;
    showStatus('Starting browser download...', '');

    try {
        const preferNativeForWebsite = Boolean(preferNativeForWebsiteEl.checked);
        const response = await chrome.runtime.sendMessage({
            type: 'USE_NATIVE_DOWNLOAD',
            downloadId,
            preferNativeForWebsite
        });

        if (!response || response.ok === false) {
            throw new Error(response?.error || 'Failed to start browser download');
        }

        showStatus('Browser download started', 'success');
        shouldDismissOnClose = false;
        window.close();
    } catch (error) {
        showStatus(error.message, 'error');
        startBtn.disabled = false;
        nativeBtn.disabled = false;
        preferNativeForWebsiteEl.disabled = false;
    }
});

loadInterceptedDownload().catch((error) => {
    showStatus(error.message, 'error');
});