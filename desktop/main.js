/**
 * desktop/main.js — Electron Main Process
 *
 * Responsibilities:
 *  1. Create the BrowserWindow (desktop UI)
 *  2. Start the embedded Express/Baileys server
 *  3. Forward server status/log events → renderer via webContents.send
 *  4. Handle IPC calls from renderer (connect, disconnect, restart, etc.)
 *  5. System tray (minimize-to-tray)
 *  6. Graceful shutdown
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
    app,
    BrowserWindow,
    ipcMain,
    Tray,
    Menu,
    nativeImage,
    shell,
} = require('electron');
const path = require('path');
const fs   = require('fs');

const { APP_NAME, APP_VERSION, DEFAULT_PORT, DEFAULT_CLIENT_ID } = require('../shared/config');
const { startServer } = require('../server');

// ─── State ────────────────────────────────────────────────────────────────────

let win       = null;
let tray      = null;
let serverHandle = null;
let isQuitting   = false;

// Buffer for events that fire before the window is ready to receive them
let lastStatus   = null;  // { event, data } — most recent wa:status event
let lastQR       = null;  // base64 string — most recent QR (cleared when connected)

// Persisted settings (clientId, port) stored in userData
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
    } catch (_) {}
    return { clientId: DEFAULT_CLIENT_ID, port: DEFAULT_PORT };
}

function saveSettings(data) {
    try {
        const current = loadSettings();
        fs.writeFileSync(settingsPath, JSON.stringify({ ...current, ...data }, null, 2));
    } catch (_) {}
}

// ─── Auth path: store in userData so it survives app updates ─────────────────

function getAuthBasePath() {
    const p = path.join(app.getPath('userData'), 'auth');
    fs.mkdirSync(p, { recursive: true });
    return p;
}

// ─── Send event to renderer (safe: only if window exists & ready) ─────────────

function sendToRenderer(channel, data) {
    if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, data);
    }
}

// ─── Start embedded server ────────────────────────────────────────────────────

function initServer() {
    const settings = loadSettings();
    const port     = Number(process.env.PORT || settings.port || DEFAULT_PORT);
    const authBasePath = getAuthBasePath();

    serverHandle = startServer({
        port,
        authBasePath,

        onStatusChange(event, data) {
            const statusMap = {
                'initializing':    { waStatus: 'Initializing',      type: 'info' },
                'qr':              { waStatus: 'QR Generated',       type: 'qr'  },
                'connected':       { waStatus: 'Connected',          type: 'success' },
                'disconnected':    { waStatus: 'Disconnected',       type: 'error' },
                'reconnecting':    { waStatus: 'Reconnecting...',    type: 'warn' },
                'restoring':       { waStatus: 'Restoring Session',  type: 'info' },
                'session-cleared': { waStatus: 'Session Cleared',    type: 'warn' },
                'server-started':  { waStatus: null,                 type: 'info' },
                'error':           { waStatus: 'Error',              type: 'error' },
            };

            const mapped = statusMap[event];

            if (event === 'qr') {
                lastQR = data.qrBase64;
                lastStatus = { waStatus: 'Waiting for Scan', type: 'qr', event };
                sendToRenderer('wa:qr', data.qrBase64);
                sendToRenderer('wa:status', lastStatus);
            } else {
                const payload = { ...(mapped || {}), event, ...data };
                lastStatus = payload;
                // Clear QR buffer once connected or session cleared
                if (event === 'connected' || event === 'session-cleared' || event === 'disconnected') {
                    lastQR = null;
                }
                sendToRenderer('wa:status', payload);
            }
        },

        onLog(level, message) {
            sendToRenderer('wa:log', { level, message, ts: new Date().toISOString() });
        },
    });

    return port;
}

// ─── Browser Window ───────────────────────────────────────────────────────────

function createWindow() {
    win = new BrowserWindow({
        width: 1050,
        height: 720,
        minWidth: 780,
        minHeight: 560,
        title: APP_NAME,
        backgroundColor: '#0f1117',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false, // needed for preload to use require
        },
        show: false, // show after ready-to-show to avoid flash
        // Use default Electron icon; replace with custom icon if available
        ...(fs.existsSync(path.join(__dirname, 'icon.png'))
            ? { icon: path.join(__dirname, 'icon.png') }
            : {}),
    });

    win.loadFile(path.join(__dirname, 'ui', 'index.html'));

    win.once('ready-to-show', () => {
        win.show();
        // Replay any status/QR that arrived before the window was ready
        if (lastStatus) {
            win.webContents.send('wa:status', lastStatus);
        }
        if (lastQR) {
            win.webContents.send('wa:qr', lastQR);
        }
    });

    // Minimize to tray instead of closing
    win.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            win.hide();
            if (tray) {
                tray.displayBalloon?.({
                    title: APP_NAME,
                    content: 'Running in system tray. Right-click the tray icon to quit.',
                });
            }
        }
    });

    win.on('closed', () => { win = null; });

    // Open external links in the system browser
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// ─── System Tray ──────────────────────────────────────────────────────────────

function createTray() {
    const iconPath = path.join(__dirname, 'icon.png');
    const icon = fs.existsSync(iconPath)
        ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
        : nativeImage.createEmpty();

    tray = new Tray(icon);
    tray.setToolTip(APP_NAME);

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show App',
            click: () => {
                if (win) { win.show(); win.focus(); }
            },
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
        if (win) { win.show(); win.focus(); }
    });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

function registerIPC() {
    const settings = loadSettings();

    ipcMain.handle('get-status', () => {
        const s = serverHandle ? serverHandle.getStatus() : { connected: false };
        return { ...s, serverRunning: !!serverHandle };
    });

    ipcMain.handle('get-port', () => {
        const s = loadSettings();
        return Number(process.env.PORT || s.port || DEFAULT_PORT);
    });

    ipcMain.handle('get-client-id', () => loadSettings().clientId || DEFAULT_CLIENT_ID);

    // Let the renderer check at startup whether valid session files exist on disk
    ipcMain.handle('get-has-session', () => {
        return serverHandle ? serverHandle.hasExistingSession() : false;
    });

    ipcMain.handle('set-client-id', (_, id) => {
        if (id && typeof id === 'string') saveSettings({ clientId: id });
        return true;
    });

    ipcMain.handle('whatsapp:connect', async (_, clientId) => {
        const id = clientId || loadSettings().clientId || DEFAULT_CLIENT_ID;
        try {
            return await serverHandle.connectClient(id);
        } catch (e) {
            return { success: false, message: e.message || String(e) };
        }
    });

    ipcMain.handle('whatsapp:disconnect', async () => {
        try {
            await serverHandle.disconnectClient();
            return { success: true };
        } catch (e) {
            return { success: false, message: e.message || String(e) };
        }
    });

    ipcMain.handle('whatsapp:restart', async (_, clientId) => {
        const id = clientId || loadSettings().clientId || DEFAULT_CLIENT_ID;
        try {
            return await serverHandle.restartClient(id);
        } catch (e) {
            return { success: false, message: e.message || String(e) };
        }
    });

    ipcMain.handle('whatsapp:clear-session', async () => {
        try {
            await serverHandle.disconnectClient();
            return { success: true, message: 'Session cleared' };
        } catch (e) {
            return { success: false, message: e.message || String(e) };
        }
    });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
    // Start server first so it can auto-restore session
    const port = initServer();
    saveSettings({ port });

    createWindow();
    createTray();
    registerIPC();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', (e) => {
    // Don't quit on macOS or when minimizing to tray
    if (process.platform !== 'darwin' && !isQuitting) {
        e.preventDefault();
    }
});

app.on('before-quit', async () => {
    isQuitting = true;
    if (serverHandle) {
        try { await serverHandle.stop(); } catch (_) {}
    }
});
