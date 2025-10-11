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

// ✅ Secure, controlled CORS setup
const corsOptions = {
    origin: function (origin, callback) {
        const allowedOrigins = JSON.parse(process.env.ORIGIN_URL_LIST || '["http://localhost:3000"]');
        if (allowedOrigins.includes(origin) || !origin) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
};
app.use(cors(corsOptions));

// ✅ Globals
const sessions = {};
const lruList = [];
const MAX_SESSIONS = 3;
const sessionTimers = {};
const SESSION_IDLE_TIME = 1 * 60 * 1000;

// ✅ Helper functions
function touchSession(clientId) {
    const index = lruList.indexOf(clientId);
    if (index !== -1) lruList.splice(index, 1);
    lruList.push(clientId);
}

function enforceMaxSessions() {
    while (lruList.length > MAX_SESSIONS) {
        const oldestClientId = lruList.shift();
        const sock = sessions[oldestClientId];
        if (sock) {
            sock.ev.removeAllListeners();
            sock.end();
            delete sessions[oldestClientId];
            deleteSessionFiles(`./auth/${oldestClientId}`, false);
            console.log(`🗑️ Evicted LRU session: ${oldestClientId}`);
        }
    }
}

function scheduleSessionCleanup(clientId) {
    try {
        if (sessionTimers[clientId]) clearTimeout(sessionTimers[clientId]);
        sessionTimers[clientId] = setTimeout(() => {
            const sock = sessions[clientId];
            if (sock) {
                console.log(`🗑️ Closing idle session: ${clientId}`);
                sock.ev.removeAllListeners();
                sock.end();
                delete sessions[clientId];
                deleteSessionFiles(`./auth/${clientId}`, false);
            }
            delete sessionTimers[clientId];
        }, SESSION_IDLE_TIME);
    } catch (error) {
        console.error("Error in scheduleSessionCleanup", error);
    }
}

async function deleteSessionFiles(sessionPath, delCreds = false) {
    try {
        if (!fs.existsSync(sessionPath)) return;
        const files = await fs.promises.readdir(sessionPath);
        for (const file of files) {
            if (!delCreds && file === 'creds.json') continue;
            await fs.promises.rm(path.join(sessionPath, file), { recursive: true, force: true });
            console.log(`Deleted ${file} from ${sessionPath}`);
        }
    } catch (err) {
        console.error(`Failed to delete session files in ${sessionPath}:`, err);
    }
}

// ✅ Create WhatsApp Session
async function createSession(clientId) {
    try {
        const sessionPath = `./auth/${clientId}`;
        fs.mkdirSync(sessionPath, { recursive: true });

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        return new Promise((resolve, reject) => {
            let settled = false;

            const sock = makeWASocket({
                auth: state,
                version,
                shouldSyncHistoryMessage: () => false,
                printQRInTerminal: false,
                browser: ['MultiClient', 'Chrome', '3.0'],
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
            });

            sock.ev.on('creds.update', async () => {
                try {
                    await saveCreds();
                    deleteSessionFiles(sessionPath, false);
                } catch (error) {
                    console.error("Error saving creds:", error);
                }
            });

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (!settled && qr) {
                    try {
                        const qrBase64 = await qrcode.toDataURL(qr);
                        settled = true;
                        return resolve({
                            success: true,
                            message: 'QR code generated',
                            data: { qrCode: qrBase64 },
                        });
                    } catch (error) {
                        settled = true;
                        return reject({
                            success: false,
                            message: 'Failed to generate QR code',
                            data: { error },
                        });
                    }
                }

                if (connection === 'close') {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    console.log(`❌ Connection closed for ${clientId}. Reason: ${reason}`);

                    sessions[clientId]?.ev.removeAllListeners();
                    sessions[clientId]?.end();
                    sessions[clientId] = null;

                    if (reason === DisconnectReason.restartRequired || reason === DisconnectReason.streamErrored) {
                        console.log(`🔄 Restarting session for ${clientId}...`);
                        await createSession(clientId);
                    } else {
                        deleteSessionFiles(sessionPath, true);
                    }

                    settled = true;
                    return reject({ success: false, message: "Connection closed", data: {} });
                }

                if (!settled && connection === 'open') {
                    console.log(`✅ ${clientId} connected`);
                    sessions[clientId] = sock;
                    touchSession(clientId);
                    enforceMaxSessions();
                    deleteSessionFiles(sessionPath, false);
                    settled = true;
                    return resolve({ success: true, message: "Connected", data: {} });
                }
            });

            sock.ev.on('connection.error', (error) => {
                console.error('Connection error:', error);
                sessions[clientId]?.ev.removeAllListeners();
                sessions[clientId]?.end();
                sessions[clientId] = null;
                deleteSessionFiles(sessionPath, true);
                if (!settled) reject({ success: false, message: "Failed to connect", data: { error } });
            });
        });
    } catch (error) {
        console.error("Error in createSession:", error);
    }
}

// ✅ Routes
app.get('/login/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (sessions[clientId]) {
        return res.json({ success: true, data: [{ webWhatsAppStatus: "ACTIVE" }], message: "Already connected" });
    }
    try {
        const response = await createSession(clientId);
        res.status(response.success ? 200 : 500).json(response);
    } catch (error) {
        console.error("❌ Session creation failed:", error);
        res.status(500).json(error);
    }
});

app.get('/status/:clientId', async (req, res) => {
    const { clientId } = req.params;
    try {
        const sock = sessions[clientId];
        if (sock) {
            touchSession(clientId);
            scheduleSessionCleanup(clientId);
            return res.status(200).json({ success: true, data: [{ webWhatsAppStatus: "ACTIVE" }], message: "Client is connected" });
        } else {
            return res.status(400).json({ success: true, data: [{ webWhatsAppStatus: "INACTIVE" }], message: "Client is not connected" });
        }
    } catch (error) {
        console.error("❌ Status check failed:", error);
        res.status(500).json({ success: false, error });
    }
});


app.get('/logout/:clientId', async (req, res) => {
    const { clientId } = req.params;
    try {
        sessions[clientId]?.ev.removeAllListeners();
        sessions[clientId]?.end();
        sessions[clientId] = null;
        deleteSessionFiles(`./auth/${clientId}`, true);
        res.json({ success: true, message: "Logout successful" });
    } catch (error) {
        console.error("Logout failed:", error);
        res.status(500).json({ success: false, error });
    }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.post('/send/:clientId', upload.single("file"), async (req, res) => {
    const { clientId } = req.params;
    const { numbers, message } = req.body;
    try {
        let sock = sessions[clientId];
        if (!sock) {
            const { success } = await createSession(clientId);
            if (!success) return res.status(400).json({ error: `Client ${clientId} not connected.` });
            sock = sessions[clientId];
        }

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
                } else await sock.sendMessage(jid, { text: message });
                sentTo.push(number);
            } catch (err) {
                console.error(`Failed to send to ${number}:`, err.message);
                failed.push(number);
            }
        }

        res.json({ success: true, sentTo, failed });
    } catch (error) {
        console.error("❌ Sending failed:", error);
        res.status(500).json({ success: false, error });
    } finally {
        scheduleSessionCleanup(clientId);
    }
});

// ✅ Robust Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('🔥 Uncaught Exception:', err);
    restartService();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 Unhandled Rejection:', reason);
    restartService();
});

process.on('SIGINT', () => {
    console.log("🛑 Gracefully shutting down...");
    Object.keys(sessions).forEach(id => {
        sessions[id]?.ev.removeAllListeners();
        sessions[id]?.end();
    });
    process.exit(0);
});

function restartService() {
    console.log('♻️ Restarting service due to critical failure...');
    Object.keys(sessions).forEach(id => {
        try {
            sessions[id]?.ev.removeAllListeners();
            sessions[id]?.end();
        } catch (_) { }
    });
    setTimeout(() => process.exit(1), 1000); // will restart if using PM2 or wrapper
}

app.listen(PORT, () => {
    console.log(`🚀 Multi-client WhatsApp API running on http://localhost:${PORT}`);
});
