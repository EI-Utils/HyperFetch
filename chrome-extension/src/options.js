const EXCLUDED_SITE_DEFAULTS = [];

// Default settings
const DEFAULTS = {
    threadCount: 8,
    chunkSize: 5,
    minFileSize: 100,
    autoIntercept: true,
    authToken: '',
    authType: 'api-key',
    username: '',
    downloadDir: '',
    createSubdir: false,
    timeout: 30,
    retries: 3,
    enableLogging: false,
    excludedSites: EXCLUDED_SITE_DEFAULTS
};

let excludedSitesState = [...EXCLUDED_SITE_DEFAULTS];

// Load settings on page load
document.addEventListener('DOMContentLoaded', () => {
    bindUiEvents();
    loadSettings();
});

function bindUiEvents() {
    document.getElementById('saveBtn').addEventListener('click', saveSettings);
    document.getElementById('resetBtn').addEventListener('click', resetSettings);
    document.getElementById('clearCacheBtn').addEventListener('click', clearHistory);
    document.getElementById('testBtn').addEventListener('click', testConnection);
    document.getElementById('browseBtn').addEventListener('click', browseForDirectory);

    document.getElementById('addSiteBtn').addEventListener('click', addExcludedSiteFromInput);
    document.getElementById('excludedSiteInput').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            addExcludedSiteFromInput();
        }
    });

    document.getElementById('excludedSitesList').addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const site = target.getAttribute('data-remove-site');
        if (!site) {
            return;
        }

        excludedSitesState = excludedSitesState.filter((entry) => entry !== site);
        renderExcludedSites();
    });

    // Update display values when sliders change
    document.getElementById('threadCount').addEventListener('input', (e) => {
        document.getElementById('threadCountValue').textContent = e.target.value;
    });

    document.getElementById('chunkSize').addEventListener('input', (e) => {
        document.getElementById('chunkSizeValue').textContent = `${e.target.value} MB`;
    });

    document.getElementById('minFileSize').addEventListener('input', (e) => {
        document.getElementById('minFileSizeValue').textContent = `${e.target.value} MB`;
    });
}

function normalizeExcludedSite(value) {
    const trimmed = (value || '').trim();
    if (!trimmed) {
        return null;
    }

    const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;

    try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }

        const hostname = parsed.hostname.toLowerCase();
        const withPort = parsed.port ? `${hostname}:${parsed.port}` : hostname;
        return `${parsed.protocol}//${withPort}/`;
    } catch {
        return null;
    }
}

function sanitizeExcludedSites(rawSites) {
    const source = Array.isArray(rawSites) ? rawSites : [];
    const normalized = source
        .map((entry) => normalizeExcludedSite(String(entry || '')))
        .filter((entry) => Boolean(entry));

    return Array.from(new Set(normalized));
}

function renderExcludedSites() {
    const listEl = document.getElementById('excludedSitesList');

    if (excludedSitesState.length === 0) {
        listEl.innerHTML = '<p class="site-empty">No excluded websites configured.</p>';
        return;
    }

    listEl.innerHTML = excludedSitesState
        .map((site) => (
            `<div class="site-chip">`
            + `<span class="site-url">${escapeHtml(site)}</span>`
            + `<button type="button" class="site-remove" data-remove-site="${escapeHtmlAttr(site)}">Remove</button>`
            + `</div>`
        ))
        .join('');
}

function addExcludedSiteFromInput() {
    const input = document.getElementById('excludedSiteInput');
    const normalized = normalizeExcludedSite(input.value);

    if (!normalized) {
        showStatus('Enter a valid website URL (http/https)', 'error');
        return;
    }

    if (excludedSitesState.includes(normalized)) {
        showStatus('Website already in list', 'info');
        input.value = '';
        return;
    }

    excludedSitesState = [...excludedSitesState, normalized];
    renderExcludedSites();
    input.value = '';
}

async function loadSettings() {
    try {
        const settings = await chrome.storage.sync.get(DEFAULTS);

        // Populate form
        document.getElementById('threadCount').value = settings.threadCount;
        document.getElementById('threadCountValue').textContent = settings.threadCount;
        document.getElementById('chunkSize').value = settings.chunkSize;
        document.getElementById('chunkSizeValue').textContent = `${settings.chunkSize} MB`;
        document.getElementById('minFileSize').value = settings.minFileSize;
        document.getElementById('minFileSizeValue').textContent = `${settings.minFileSize} MB`;
        document.getElementById('autoIntercept').checked = settings.autoIntercept;
        document.getElementById('downloadDir').value = settings.downloadDir;
        document.getElementById('createSubdir').checked = settings.createSubdir;
        document.getElementById('timeout').value = settings.timeout;
        document.getElementById('retries').value = settings.retries;
        document.getElementById('enableLogging').checked = settings.enableLogging;

        excludedSitesState = sanitizeExcludedSites(settings.excludedSites);
        renderExcludedSites();
    } catch (error) {
        console.error('Failed to load settings:', error);
        showStatus('Failed to load settings', 'error');
    }
}

async function saveSettings() {
    try {
        const excludedSites = sanitizeExcludedSites(excludedSitesState);

        const settings = {
            threadCount: parseInt(document.getElementById('threadCount').value, 10),
            chunkSize: parseInt(document.getElementById('chunkSize').value, 10),
            minFileSize: parseInt(document.getElementById('minFileSize').value, 10),
            autoIntercept: document.getElementById('autoIntercept').checked,
            downloadDir: document.getElementById('downloadDir').value,
            createSubdir: document.getElementById('createSubdir').checked,
            timeout: parseInt(document.getElementById('timeout').value, 10),
            retries: parseInt(document.getElementById('retries').value, 10),
            enableLogging: document.getElementById('enableLogging').checked,
            excludedSites
        };

        await chrome.storage.sync.set(settings);
        excludedSitesState = excludedSites;
        renderExcludedSites();
        showStatus('Settings saved successfully!', 'success');
    } catch (error) {
        console.error('Failed to save settings:', error);
        showStatus('Failed to save settings', 'error');
    }
}

async function resetSettings() {
    if (!confirm('Are you sure you want to reset all settings to defaults?')) {
        return;
    }

    try {
        await chrome.storage.sync.set(DEFAULTS);
        await loadSettings();
        showStatus('Settings reset to defaults', 'info');
    } catch (error) {
        console.error('Failed to reset settings:', error);
        showStatus('Failed to reset settings', 'error');
    }
}

async function clearHistory() {
    if (!confirm('Are you sure you want to clear all download history?')) {
        return;
    }

    try {
        await chrome.storage.local.set({ downloads: [] });
        showStatus('Download history cleared', 'success');
    } catch (error) {
        console.error('Failed to clear history:', error);
        showStatus('Failed to clear history', 'error');
    }
}

async function testConnection() {
    const btn = document.getElementById('testBtn');
    const status = document.getElementById('connectionStatus');

    btn.disabled = true;
    btn.textContent = 'Testing...';
    status.innerHTML = '';

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'NATIVE_PING'
        });

        if (response && response.ok) {
            status.className = 'success';
            status.innerHTML = `Connected. Native host version: ${response.version || 'unknown'}`;
        } else {
            status.className = 'error';
            status.innerHTML = `Native host unavailable: ${response?.error || 'unknown error'}`;
        }
    } catch (error) {
        status.className = 'error';
        status.innerHTML = `Connection failed: ${error.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Test Native Host';
    }
}

async function browseForDirectory() {
    const btn = document.getElementById('browseBtn');
    const input = document.getElementById('downloadDir');

    btn.disabled = true;
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'BROWSE_DIRECTORY',
            downloadDir: input.value.trim()
        });

        if (!response || response.ok === false) {
            throw new Error(response?.error || 'Failed to open directory picker');
        }

        if (response.cancelled) {
            showStatus('Directory selection cancelled', 'info');
            return;
        }

        if (response.path) {
            input.value = response.path;
            showStatus('Directory selected', 'success');
        }
    } catch (error) {
        console.error('Failed to browse for directory:', error);
        showStatus(error.message || 'Failed to open directory picker', 'error');
    } finally {
        btn.disabled = false;
    }
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function showStatus(message, type) {
    const el = document.getElementById('statusMessage');
    el.textContent = message;
    el.className = `status-message show ${type}`;

    setTimeout(() => {
        el.classList.remove('show');
    }, 4000);
}
