/**
 * server/index.js
 *
 * Extracted Express + Baileys server.
 * Exports a startServer({ port, authBasePath, onStatusChange, onLog }) function
 * that can be embedded inside Electron or run standalone via CLI.
 *
 * Baileys is ESM-only, so it is loaded via dynamic import().
 * All original routes are preserved exactly.
 */

'use strict';

const express = require('express');
const cors    = require('cors');
require('dotenv').config();
const qrcode = require('qrcode');
const fs     = require('fs');
const path   = require('path');
const multer = require('multer');

// ─── Module-level state ──────────────────────────────────────────────────────

let sock             = null;
let currentClientId  = null;
let isReconnecting   = false;
const MAX_RETRIES    = 5;

// Baileys symbols — populated after dynamic import
let makeWASocket            = null;
let useMultiFileAuthState   = null;
let fetchLatestBaileysVersion = null;
let DisconnectReason        = null;

// Callbacks injected by the caller
let _onStatusChange = null;
let _onLog          = null;

// ─── Lazy-load Baileys (ESM) ─────────────────────────────────────────────────

async function loadBaileys() {
    if (makeWASocket) return; // already loaded
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket              = baileys.default;
    useMultiFileAuthState     = baileys.useMultiFileAuthState;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
    DisconnectReason          = baileys.DisconnectReason;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emit(event, data = {}) {
    if (_onStatusChange) {
        try { _onStatusChange(event, data); } catch (_) {}
    }
}

function log(level, message) {
    const prefix = { info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅', debug: '🔍' }[level] || '•';
    const full = `${prefix} ${message}`;
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](full);
    if (_onLog) {
        try { _onLog(level, message); } catch (_) {}
    }
}

function getSessionPath(clientId, authBasePath) {
    return path.join(authBasePath, clientId);
}

function getExistingClient(authBasePath) {
    if (currentClientId) return currentClientId;
    if (!fs.existsSync(authBasePath)) return null;

    // Check for a direct creds.json at the auth root (legacy)
    if (fs.existsSync(path.join(authBasePath, 'creds.json'))) return null;

    const folders = fs.readdirSync(authBasePath, { withFileTypes: true })
        .filter(item => item.isDirectory())
        .map(item => item.name);

    return folders.length > 0 ? folders[0] : null;
}

// ─── Core: Session creator ────────────────────────────────────────────────────

async function createSession(clientId, authBasePath, retryCount = 0) {
    await loadBaileys();

    if (sock && getExistingClient(authBasePath) === clientId) {
        return { success: true, message: 'Already connected', data: {} };
    }

    const sessionPath = getSessionPath(clientId, authBasePath);
    fs.mkdirSync(sessionPath, { recursive: true });

    log('info', `Initializing session for client: ${clientId}`);
    emit('initializing', { clientId });

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                log('error', 'Session timeout — no QR or connection within 20s');
                emit('error', { message: 'Session timeout' });
                reject({ success: false, message: 'Session timeout' });
            }
        }, 20000);

        if (sock) {
            try { sock.ev.removeAllListeners(); sock.end(); } catch (_) {}
        }

        sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            browser: ['MultiClient', 'Chrome', '3.0'],
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            retryRequestDelayMs: 5000,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // ── QR Code generated ─────────────────────────────────────────
            if (qr) {
                try {
                    const qrBase64 = await qrcode.toDataURL(qr);
                    log('info', 'QR code generated — waiting for scan');
                    emit('qr', { qrBase64, clientId });

                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        return resolve({
                            success: true,
                            message: 'QR code generated',
                            data: { qrCode: qrBase64 },
                        });
                    }
                } catch (err) {
                    log('error', `Failed to generate QR: ${err.message}`);
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        emit('error', { message: 'Failed to generate QR code' });
                        return reject({ success: false, message: 'Failed to generate QR code' });
                    }
                }
            }

            // ── Connected successfully ────────────────────────────────────
            if (connection === 'open') {
                log('success', `${clientId} connected successfully`);
                currentClientId = clientId;
                emit('connected', { clientId });

                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    return resolve({ success: true, message: 'Connected', data: {} });
                }
            }

            // ── Connection closed ─────────────────────────────────────────
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                log('warn', `Connection closed for ${clientId}. Reason code: ${reason}`);

                sock = null;
                currentClientId = null;
                emit('disconnected', { clientId, reason });

                // Auto-reconnect on restartRequired / streamErrored
                if (
                    [DisconnectReason.restartRequired, DisconnectReason.streamErrored].includes(reason) &&
                    !isReconnecting &&
                    retryCount < MAX_RETRIES
                ) {
                    isReconnecting = true;
                    log('info', `Reconnecting (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
                    emit('reconnecting', { attempt: retryCount + 1, max: MAX_RETRIES });

                    setTimeout(async () => {
                        try {
                            await createSession(clientId, authBasePath, retryCount + 1);
                        } catch (e) {
                            log('error', `Reconnect attempt ${retryCount + 1} failed: ${e.message || e}`);
                        } finally {
                            isReconnecting = false;
                        }
                    }, 3000);
                }

                // Clear session on logout / bad session
                if ([DisconnectReason.loggedOut, DisconnectReason.badSession].includes(reason)) {
                    log('warn', `Session invalidated for ${clientId} — clearing auth files`);
                    const sp = getSessionPath(clientId, authBasePath);
                    await fs.promises.rm(sp, { recursive: true, force: true });
                    emit('session-cleared', { clientId });
                }

                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject({ success: false, message: 'Connection closed' });
                }
            }
        });

        sock.ev.on('error', (err) => {
            log('error', `Socket error: ${err.message}`);
            emit('error', { message: err.message });
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject({ success: false, message: 'Connection error' });
            }
        });
    });
}

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Start the Express server.
 *
 * @param {object} options
 * @param {number}   [options.port]           Listening port (default: env PORT or 5002)
 * @param {string}   [options.authBasePath]   Where to store auth files
 * @param {function} [options.onStatusChange] (event, data) callback
 * @param {function} [options.onLog]          (level, message) callback
 * @returns {{ app, server, stop, connectClient, disconnectClient, restartClient, getStatus }}
 */
function startServer(options = {}) {
    const {
        port = process.env.PORT || 5002,
        authBasePath = path.join(__dirname, '..', 'auth'),
        onStatusChange,
        onLog,
    } = options;

    _onStatusChange = onStatusChange || null;
    _onLog          = onLog || null;

    fs.mkdirSync(authBasePath, { recursive: true });

    const app = express();

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 },
    });

    app.use(express.json());
    app.use(cors({
        origin: '*',
        credentials: true,
        allowedHeaders: ['Authorization', 'Content-Type'],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    }));

    // ── Health route ──────────────────────────────────────────────────────
    app.get('/health', (req, res) => {
        res.json({
            success: true,
            message: 'WhatsApp API is running',
            data: { port, clientId: currentClientId, connected: !!sock },
        });
    });

    // ── WhatsApp Login ────────────────────────────────────────────────────
    app.get('/whats-app/login/:clientId', async (req, res) => {
        const { clientId } = req.params;
        const existingClient = getExistingClient(authBasePath);

        if (existingClient && existingClient !== clientId) {
            return res.status(400).json({
                success: false,
                message: `Another client is already active: ${existingClient}`,
            });
        }

        if (sock && existingClient === clientId) {
            return res.json({
                success: true,
                data: { webWhatsAppStatus: 'ACTIVE' },
                message: 'Already connected',
            });
        }

        try {
            const response = await createSession(clientId, authBasePath);
            res.status(response.success ? 200 : 500).json(response);
        } catch (error) {
            log('error', `Session creation failed: ${error.message || error}`);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to create session',
            });
        }
    });

    // ── WhatsApp Status ───────────────────────────────────────────────────
    app.get('/whats-app/status/:clientId', (req, res) => {
        const { clientId } = req.params;
        const existingClient = getExistingClient(authBasePath);
        if (existingClient === clientId && sock) {
            return res.json({ success: true, data: { webWhatsAppStatus: 'ACTIVE' }, message: 'Client is connected' });
        }
        return res.json({ success: true, data: { webWhatsAppStatus: 'INACTIVE' }, message: 'Client is not connected' });
    });

    // ── WhatsApp Logout ───────────────────────────────────────────────────
    app.get('/whats-app/logout', async (req, res) => {
        try {
            if (sock) {
                sock.ev.removeAllListeners();
                sock.end();
                sock = null;
                currentClientId = null;
            }
            if (fs.existsSync(authBasePath)) {
                await fs.promises.rm(authBasePath, { recursive: true, force: true });
                fs.mkdirSync(authBasePath, { recursive: true });
            }
            log('info', 'Logout successful — session cleared');
            emit('session-cleared', {});
            res.json({ success: true, message: 'Logout successful' });
        } catch (error) {
            log('error', `Logout error: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ── Send Message ──────────────────────────────────────────────────────
    app.post('/whats-app/send/:clientId', upload.single('file'), async (req, res) => {
        const { clientId } = req.params;
        const { numbers, message } = req.body;

        if (getExistingClient(authBasePath) !== clientId) {
            return res.status(400).json({ error: `Client ${clientId} is not active` });
        }

        if (!sock) {
            const existing = getExistingClient(authBasePath);
            if (existing) {
                log('info', `Restoring previous session for ${existing}...`);
                try {
                    await createSession(existing, authBasePath);
                } catch (error) {
                    return res.status(400).json({ error: `Client ${clientId} is not active` });
                }
            }
        }

        if (!numbers) return res.status(400).json({ error: 'Numbers are required' });
        if (!message && !req.file) return res.status(400).json({ error: 'Message or file is required' });

        try {
            const parsedNumbers = JSON.parse(numbers || '[]');
            const failed = [];
            const sentTo = [];

            for (const number of parsedNumbers) {
                const jid = number.endsWith('@s.whatsapp.net')
                    ? number
                    : `${number}@s.whatsapp.net`;

                try {
                    if (req.file) {
                        const mime = req.file.mimetype;
                        const buf  = req.file.buffer;
                        let msg = {};
                        if (mime.startsWith('image/'))      msg = { image: buf, mimetype: mime, caption: message || '' };
                        else if (mime.startsWith('video/')) msg = { video: buf, mimetype: mime, caption: message || '' };
                        else if (mime.startsWith('audio/')) msg = { audio: buf, mimetype: mime };
                        else                                msg = { document: buf, mimetype: mime, fileName: req.file.originalname };
                        await sock.sendMessage(jid, msg);
                    } else {
                        await sock.sendMessage(jid, { text: message });
                    }
                    sentTo.push(number);
                } catch (err) {
                    log('error', `Failed to send to ${number}: ${err.message}`);
                    failed.push(number);
                }
            }
            res.json({ success: true, sentTo, failed });
        } catch (error) {
            log('error', `Send error: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ── Global error handlers ─────────────────────────────────────────────
    process.on('uncaughtException', (err) => {
        log('error', `Uncaught Exception: ${err.message}`);
        emit('error', { message: `Uncaught Exception: ${err.message}` });
    });

    process.on('unhandledRejection', (reason) => {
        log('error', `Unhandled Rejection: ${reason}`);
        emit('error', { message: `Unhandled Rejection: ${reason}` });
    });

    // ── Start listening ───────────────────────────────────────────────────
    const server = app.listen(port, () => {
        log('success', `WhatsApp API running on http://localhost:${port}`);
        emit('server-started', { port });

        // Auto-restore previous session on startup
        const existing = getExistingClient(authBasePath);
        if (existing) {
            currentClientId = existing;
            log('info', `Restoring previous session for ${existing}...`);
            emit('restoring', { clientId: existing });
            createSession(existing, authBasePath).catch((err) => {
                log('warn', `Session restore failed: ${err.message || err}`);
                emit('error', { message: `Session restore failed: ${err.message || err}` });
            });
        }
    });

    // ── Control functions exposed to Electron IPC ─────────────────────────
    function connectClient(clientId) {
        return createSession(clientId, authBasePath);
    }

    async function disconnectClient() {
        if (sock) {
            try { sock.ev.removeAllListeners(); sock.end(); } catch (_) {}
            sock = null;
        }
        const cid = currentClientId;
        currentClientId = null;

        if (cid && fs.existsSync(path.join(authBasePath, cid))) {
            await fs.promises.rm(path.join(authBasePath, cid), { recursive: true, force: true });
        }
        emit('session-cleared', {});
        log('info', 'Session disconnected and cleared');
    }

    function restartClient(clientId) {
        if (sock) {
            try { sock.ev.removeAllListeners(); sock.end(); } catch (_) {}
            sock = null;
            currentClientId = null;
        }
        return createSession(clientId, authBasePath);
    }

    function getStatus() {
        return { connected: !!sock, clientId: currentClientId, isReconnecting };
    }

    function stop() {
        return new Promise((resolve) => {
            if (sock) {
                try { sock.ev.removeAllListeners(); sock.end(); } catch (_) {}
                sock = null;
                currentClientId = null;
            }
            server.close(() => {
                log('info', 'Server stopped');
                resolve();
            });
        });
    }

    return { app, server, stop, connectClient, disconnectClient, restartClient, getStatus };
}

module.exports = { startServer };
