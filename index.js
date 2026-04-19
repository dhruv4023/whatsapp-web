const express = require('express');
const cors = require('cors');
require('dotenv').config();
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const multer = require("multer");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const corsOptions = {
    origin: "*",
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
};
app.use(cors(corsOptions));

let sock = null;
let currentClientId = null;   // Track current active client


const MAX_RETRIES = 5;
let isReconnecting = false;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const getSessionPath = (clientId) => path.join(__dirname, 'auth', clientId);

function getExistingClient() {
    if (currentClientId)
        return currentClientId;

    const dirPath = path.join(__dirname, 'auth');
    if (!fs.existsSync(dirPath + "/creds.json")) return null;

    const folders = fs.readdirSync(dirPath, { withFileTypes: true })
        .filter(item => item.isDirectory())
        .map(item => item.name);

    return folders.length > 0 ? folders[0] : null;
}

// ✅ Fixed & Stable Session Creator
async function createSession(clientId, retryCount = 0) {
    if (sock && getExistingClient() === clientId) {
        return { success: true, message: "Already connected", data: {} };
    }

    const sessionPath = getSessionPath(clientId);
    fs.mkdirSync(sessionPath, { recursive: true });

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject({ success: false, message: "Session timeout" });
            }
        }, 20000);

        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end();
            } catch { }
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

            if (qr && !settled) {
                try {
                    const qrBase64 = await qrcode.toDataURL(qr);
                    settled = true;
                    clearTimeout(timeout);
                    return resolve({
                        success: true,
                        message: 'QR code generated',
                        data: { qrCode: qrBase64 }
                    });
                } catch (error) {
                    settled = true;
                    clearTimeout(timeout);
                    return reject({ success: false, message: 'Failed to generate QR code' });
                }
            }

            // Connected Successfully
            if (connection === 'open' && !settled) {
                console.log(`✅ ${clientId} connected successfully`);
                settled = true;
                currentClientId = clientId;
                clearTimeout(timeout);
                return resolve({ success: true, message: "Connected", data: {} });
            }

            // Connection Closed
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ Connection closed for ${clientId}. Reason: ${reason}`);

                sock = null;
                currentClientId = null;


                if ([DisconnectReason.restartRequired, DisconnectReason.streamErrored].includes(reason)) {
                    if (!isReconnecting && retryCount < MAX_RETRIES) {
                        isReconnecting = true;

                        setTimeout(async () => {
                            try {
                                await createSession(clientId, retryCount + 1);
                            } finally {
                                isReconnecting = false;
                            }
                        }, 3000);
                    }
                }

                if ([DisconnectReason.loggedOut, DisconnectReason.badSession].includes(reason)) {
                    const sessionPath = getSessionPath(clientId);
                    await fs.promises.rm(sessionPath, { recursive: true, force: true });
                }

                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject({ success: false, message: "Connection closed" });
                }
            }
        });

        sock.ev.on('error', (err) => {
            console.error('Socket Error:', err);
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject({ success: false, message: "Connection error" });
            }
        });
    });
}

// ====================== ROUTES ======================

app.get('/whats-app/login/:clientId', async (req, res) => {
    const { clientId } = req.params;

    const existingClient = getExistingClient();
    if (existingClient && existingClient !== clientId) {
        return res.status(400).json({
            success: false,
            message: `Another client is already active: ${existingClient}`
        });
    }

    if (sock && existingClient === clientId) {
        return res.json({ success: true, data: { webWhatsAppStatus: "ACTIVE" }, message: "Already connected" });
    }

    try {
        const response = await createSession(clientId);
        res.status(response.success ? 200 : 500).json(response);
    } catch (error) {
        console.error("Session creation failed:", error);
        res.status(500).json({ success: false, message: error.message || "Failed to create session" });
    }
});

app.get('/whats-app/status/:clientId', (req, res) => {
    const { clientId } = req.params;
    const existingClient = getExistingClient();

    if (existingClient === clientId && sock) {
        return res.json({ success: true, data: { webWhatsAppStatus: "ACTIVE" }, message: "Client is connected" });
    } else {
        return res.json({ success: true, data: { webWhatsAppStatus: "INACTIVE" }, message: "Client is not connected" });
    }
});

app.get('/whats-app/logout', async (req, res) => {
    try {
        if (sock) {
            sock.ev.removeAllListeners();
            sock.end();
            sock = null;
            currentClientId = null;
        }

        const authPath = path.join(__dirname, 'auth');
        if (fs.existsSync(authPath)) {
            await fs.promises.rm(authPath, { recursive: true, force: true });
        }

        res.json({ success: true, message: "Logout successful" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/whats-app/send/:clientId', upload.single("file"), async (req, res) => {
    const { clientId } = req.params;
    const { numbers, message } = req.body;

    if (getExistingClient() !== clientId) {
        return res.status(400).json({ error: `Client ${clientId} is not active` });
    }

    if (!sock) {
        const existing = getExistingClient();
        if (existing) {
            console.log(`♻️ Restoring previous session for ${existing}...`);
            try {
                await createSession(existing);
            } catch (error) {
                return res.status(400).json({ error: `Client ${clientId} is not active` });
            }
        }
    }

    if (!numbers) return res.status(400).json({ error: "Numbers are required" });
    if (!message && !req.file) return res.status(400).json({ error: "Message or file is required" });

    try {
        const parsedNumbers = JSON.parse(numbers || '[]');
        const failed = [];
        const sentTo = [];

        for (const number of parsedNumbers) {
            const jid = number.endsWith('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

            try {
                if (req.file) {
                    const mime = req.file.mimetype;
                    const buf = req.file.buffer;
                    let msg = {};

                    if (mime.startsWith("image/")) msg = { image: buf, mimetype: mime, caption: message || "" };
                    else if (mime.startsWith("video/")) msg = { video: buf, mimetype: mime, caption: message || "" };
                    else if (mime.startsWith("audio/")) msg = { audio: buf, mimetype: mime };
                    else msg = { document: buf, mimetype: mime, fileName: req.file.originalname };

                    await sock.sendMessage(jid, msg);
                } else {
                    await sock.sendMessage(jid, { text: message });
                }
                sentTo.push(number);
            } catch (err) {
                console.error(`Failed to send to ${number}:`, err.message);
                failed.push(number);
            }
        }

        res.json({ success: true, sentTo, failed });
    } catch (error) {
        console.error("Sending failed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('🔥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('🔥 Unhandled Rejection:', reason);
});

process.on('SIGINT', () => {
    console.log("🛑 Shutting down...");
    if (sock) sock.end();
    process.exit(0);
});

app.listen(PORT, () => {
    const existing = getExistingClient();
    if (existing) {
        currentClientId = existing;
        console.log(`♻️ Restoring previous session for ${existing}...`);
        createSession(existing).catch(console.error);
    }
    console.log(`🚀 WhatsApp API running on http://localhost:${PORT}`);
});
