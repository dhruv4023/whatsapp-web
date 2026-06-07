/**
 * desktop/ui/app.js — Renderer Process Logic
 *
 * Wires up the electronAPI (exposed via preload.js) to DOM elements.
 * Handles:
 *  - Status pill updates
 *  - QR code display / hide / connected state
 *  - Log panel (color-coded, auto-scroll, counter)
 *  - Button enable/disable rules
 *  - Client ID save
 */

'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const serverPill       = $('server-pill');
const serverStatusText = $('server-status-text');
const waPill           = $('wa-pill');
const waStatusText     = $('wa-status-text');
const portDisplay      = $('port-display');
const appVersion       = $('app-version');

const qrCard             = $('qr-card');
const qrImage            = $('qr-image');
const qrPlaceholder      = $('qr-placeholder');
const qrHint             = $('qr-hint');
const connectedIndicator = $('connected-indicator');
const connectedClientLbl = $('connected-client-label');

const clientIdInput = $('client-id-input');
const btnSaveId     = $('btn-save-id');

const btnConnect      = $('btn-connect');
const btnRestart      = $('btn-restart');
const btnDisconnect   = $('btn-disconnect');
const btnClearSession = $('btn-clear-session');

const spinnerConnect = $('spinner-connect');
const spinnerRestart = $('spinner-restart');

const logPanel    = $('log-panel');
const logCountEl  = $('log-count');
const btnClearLog = $('btn-clear-logs');

// ─── State ────────────────────────────────────────────────────────────────────

let logCount  = 0;
let connected = false;
let currentClientId = 'default-client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(isoStr) {
    const d = isoStr ? new Date(isoStr) : new Date();
    return d.toTimeString().slice(0, 8);
}

function addLog(level, message, ts) {
    logCount++;
    logCountEl.textContent = logCount;

    const levelLabels = { info: 'INFO', success: 'OK', warn: 'WARN', error: 'ERR', debug: 'DBG' };
    const label = levelLabels[level] || 'INFO';

    const entry = document.createElement('div');
    entry.className = `log-entry log-${level}`;

    entry.innerHTML = `
        <span class="log-ts">${formatTime(ts)}</span>
        <span class="log-badge">${label}</span>
        <span class="log-msg">${escapeHtml(message)}</span>
    `;

    logPanel.appendChild(entry);
    // Keep scroll at bottom
    logPanel.scrollTop = logPanel.scrollHeight;

    // Trim to last 500 entries for memory
    if (logPanel.children.length > 500) {
        logPanel.removeChild(logPanel.firstElementChild);
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ─── Status Pill ──────────────────────────────────────────────────────────────

const WA_STATUS_MAP = {
    'Connected':         { cls: 'pill-connected',    text: 'Connected' },
    'QR Generated':      { cls: 'pill-qr',           text: 'QR Generated' },
    'Waiting for Scan':  { cls: 'pill-qr',           text: 'Waiting for Scan' },
    'Initializing':      { cls: 'pill-initializing', text: 'Initializing' },
    'Reconnecting...':   { cls: 'pill-reconnecting', text: 'Reconnecting...' },
    'Restoring Session': { cls: 'pill-initializing', text: 'Restoring Session' },
    'Disconnected':      { cls: 'pill-disconnected', text: 'Disconnected' },
    'Session Cleared':   { cls: 'pill-disconnected', text: 'Session Cleared' },
    'Error':             { cls: 'pill-disconnected', text: 'Error' },
    'Not Connected':     { cls: 'pill-idle',         text: 'Not Connected' },
};

const ALL_WA_PILL_CLASSES = Object.values(WA_STATUS_MAP).map(v => v.cls);

function setWAStatus(statusKey) {
    const mapped = WA_STATUS_MAP[statusKey] || WA_STATUS_MAP['Not Connected'];
    waPill.classList.remove(...ALL_WA_PILL_CLASSES);
    waPill.classList.add(mapped.cls);
    waStatusText.textContent = mapped.text;
}

// ─── QR / Connected UI state ──────────────────────────────────────────────────

function showQR(base64DataUrl) {
    qrImage.src = base64DataUrl;
    qrImage.classList.add('visible');
    qrPlaceholder.classList.add('hidden');
    connectedIndicator.classList.remove('visible');
    qrCard.classList.add('has-qr');
    qrCard.classList.remove('is-connected');
    qrHint.textContent = 'Scan this QR code with WhatsApp on your phone';
    setWAStatus('Waiting for Scan');
}

function showConnected(clientId) {
    qrImage.classList.remove('visible');
    qrPlaceholder.classList.add('hidden');
    connectedIndicator.classList.add('visible');
    qrCard.classList.remove('has-qr');
    qrCard.classList.add('is-connected');
    connectedClientLbl.textContent = `Client: ${clientId || currentClientId}`;
    qrHint.textContent = 'Your WhatsApp session is active';
    setWAStatus('Connected');
    connected = true;
    updateButtons();
}

function showIdle(hint = 'Click Connect to start your WhatsApp session') {
    qrImage.classList.remove('visible');
    qrPlaceholder.classList.remove('hidden');
    connectedIndicator.classList.remove('visible');
    qrCard.classList.remove('has-qr', 'is-connected');
    qrHint.textContent = hint;
    connected = false;
    updateButtons();
}

// ─── Button state rules ────────────────────────────────────────────────────────

function updateButtons(isLoading = false) {
    btnConnect.disabled    = connected || isLoading;
    btnRestart.disabled    = !connected || isLoading;
    btnDisconnect.disabled = !connected || isLoading;

    spinnerConnect.classList.toggle('visible', isLoading && !connected);
    spinnerRestart.classList.toggle('visible', isLoading && connected);
}

// ─── Initialise ───────────────────────────────────────────────────────────────

async function init() {
    // App version
    appVersion.textContent = 'v1.0.0';

    // Port
    try {
        const port = await window.electronAPI.getPort();
        portDisplay.textContent = port;
    } catch (_) {}

    // Client ID
    try {
        const id = await window.electronAPI.getClientId();
        currentClientId = id;
        clientIdInput.value = id;
    } catch (_) {}

    // Initial WA status
    try {
        const status = await window.electronAPI.getStatus();
        if (status.connected) {
            showConnected(status.clientId);
        } else {
            showIdle();
            setWAStatus('Not Connected');
        }
    } catch (_) {
        showIdle();
    }

    // Add startup log
    addLog('info', 'Application started — server initializing...');
}

// ─── Event listeners from main process ───────────────────────────────────────

window.electronAPI.onWAStatus((data) => {
    const { waStatus, event, message, attempt, max } = data;

    if (waStatus) setWAStatus(waStatus);

    if (event === 'connected') {
        showConnected(data.clientId);
    } else if (event === 'disconnected') {
        showIdle('WhatsApp disconnected. Click Connect to reconnect.');
        setWAStatus('Disconnected');
    } else if (event === 'session-cleared') {
        showIdle('Session cleared. Click Connect to start a new session.');
        setWAStatus('Not Connected');
    } else if (event === 'initializing') {
        setWAStatus('Initializing');
        qrHint.textContent = 'Initializing WhatsApp client...';
    } else if (event === 'restoring') {
        setWAStatus('Restoring Session');
        qrHint.textContent = 'Restoring previous session...';
    } else if (event === 'reconnecting') {
        setWAStatus('Reconnecting...');
        const msg = attempt ? `Reconnecting (attempt ${attempt}/${max})...` : 'Reconnecting...';
        qrHint.textContent = msg;
    }
});

window.electronAPI.onWAQR((qrBase64) => {
    showQR(qrBase64);
    updateButtons(false);
});

window.electronAPI.onLog(({ level, message, ts }) => {
    addLog(level, message, ts);
});

// ─── Button handlers ──────────────────────────────────────────────────────────

btnConnect.addEventListener('click', async () => {
    updateButtons(true);
    setWAStatus('Initializing');
    qrHint.textContent = 'Connecting to WhatsApp...';
    addLog('info', `Connecting client: ${currentClientId}`);
    try {
        const result = await window.electronAPI.connect(currentClientId);
        if (!result.success && result.message !== 'QR code generated' && result.message !== 'Connected') {
            addLog('error', result.message || 'Connection failed');
            showIdle('Connection failed. Please try again.');
            setWAStatus('Disconnected');
            updateButtons(false);
        }
    } catch (e) {
        addLog('error', `Connect error: ${e.message || e}`);
        showIdle('Connection failed. Check logs for details.');
        setWAStatus('Disconnected');
        updateButtons(false);
    }
});

btnRestart.addEventListener('click', async () => {
    updateButtons(true);
    addLog('info', `Restarting client: ${currentClientId}`);
    showIdle('Restarting WhatsApp connection...');
    setWAStatus('Initializing');
    try {
        const result = await window.electronAPI.restart(currentClientId);
        if (!result || (!result.success && result.message !== 'QR code generated' && result.message !== 'Connected')) {
            addLog('warn', result?.message || 'Restart initiated');
            updateButtons(false);
        }
    } catch (e) {
        addLog('error', `Restart error: ${e.message || e}`);
        updateButtons(false);
    }
});

btnDisconnect.addEventListener('click', async () => {
    addLog('warn', 'Disconnecting session...');
    try {
        await window.electronAPI.disconnect();
        showIdle('Disconnected. Click Connect to start again.');
        setWAStatus('Disconnected');
    } catch (e) {
        addLog('error', `Disconnect error: ${e.message || e}`);
    }
});

btnClearSession.addEventListener('click', async () => {
    const confirmed = confirm('Clear the current session? You will need to scan a new QR code.');
    if (!confirmed) return;
    addLog('warn', 'Clearing session data...');
    try {
        await window.electronAPI.clearSession();
        showIdle('Session cleared. Click Connect to start a new session.');
        setWAStatus('Not Connected');
    } catch (e) {
        addLog('error', `Clear session error: ${e.message || e}`);
    }
});

btnSaveId.addEventListener('click', async () => {
    const val = clientIdInput.value.trim();
    if (!val) return;
    currentClientId = val;
    await window.electronAPI.setClientId(val);
    addLog('info', `Client ID updated to: ${val}`);
    btnSaveId.textContent = '✓ Saved';
    setTimeout(() => { btnSaveId.textContent = 'Save'; }, 1500);
});

clientIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSaveId.click();
});

btnClearLog.addEventListener('click', () => {
    logPanel.innerHTML = '';
    logCount = 0;
    logCountEl.textContent = '0';
    addLog('info', 'Log cleared');
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

init().catch(console.error);
