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

// ✅ Create WhatsApp Session
async function createSession(clientId) {
    try {
        const sessionPath = `./auth/${clientId}`;
        const existingClient = getExistingClient();

        if (existingClient && existingClient !== clientId) {
            throw new Error(`Another client already exists: ${existingClient}`);
        }

        fs.mkdirSync(sessionPath, { recursive: true });

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        return new Promise((resolve, reject) => {
            let settled = false;

            const waSocket = makeWASocket({
                auth: state,
                version,
                shouldSyncHistoryMessage: () => false,
                printQRInTerminal: false,
                browser: ['MultiClient', 'Chrome', '3.0'],
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
            });

            waSocket.ev.on('creds.update', async () => {
                try {
                    await saveCreds();
                } catch (error) {
                    console.error("Error saving creds:", error);
                }
            });

            waSocket.ev.on('connection.update', async (update) => {
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

                    sock?.ev.removeAllListeners();
                    sock?.end();

                    if (reason === DisconnectReason.restartRequired || reason === DisconnectReason.streamErrored) {
                        console.log(`🔄 Restarting session for ${clientId}...`);
                        setTimeout(() => createSession(clientId), 2000);
                    }

                    settled = true;
                    return reject({ success: false, message: "Connection closed", data: {} });
                }

                if (!settled && connection === 'open') {
                    console.log(`✅ ${clientId} connected`);
                    if (sock) {
                        try {
                            sock.ev.removeAllListeners();
                            sock.end();
                        } catch { }
                    }
                    sock = waSocket;
                    settled = true;
                    return resolve({ success: true, message: "Connected", data: {} });
                }
            });

            waSocket.ev.on('connection.error', (error) => {
                console.error('Connection error:', error);
                sock?.ev.removeAllListeners();
                sock?.end();
                sock = null;
                if (!settled) reject({ success: false, message: "Failed to connect", data: { error } });
            });
        });
    } catch (error) {
        console.error("Error in createSession:", error);
        throw error;
    }
}

// ✅ Routes
app.get('/login/:clientId', async (req, res) => {
    const { clientId } = req.params;
    const existingClient = getExistingClient();
    if (existingClient && existingClient !== clientId) {
        return res.status(400).json({
            success: false,
            message: `Already connected with another client (${existingClient})`
        });
    }

    if (sock) {
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
    const existingClient = getExistingClient();
    try {
        if (existingClient === clientId) {
            return res.status(200).json({ success: true, data: [{ webWhatsAppStatus: "ACTIVE" }], message: "Client is connected" });
        } else {
            return res.status(400).json({ success: true, data: [{ webWhatsAppStatus: "INACTIVE" }], message: "Client is not connected" });
        }
    } catch (error) {
        console.error("❌ Status check failed:", error);
        res.status(500).json({ success: false, error });
    }
});


app.get('/logout', async (req, res) => {
    try {
        sock?.ev.removeAllListeners();
        sock?.end();
        sock = null;

        const authPath = path.join(__dirname, 'auth');

        if (fs.existsSync(authPath)) {
            await fs.promises.rm(authPath, {
                recursive: true,
                force: true
            });
        }

        res.json({ success: true, message: "Logout successful" });
    } catch (error) {
        res.status(500).json({ success: false, error });
    }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.post('/send/:clientId', upload.single("file"), async (req, res) => {
    const { clientId } = req.params;
    const { numbers, message } = req.body;
    try {
        const existingClient = getExistingClient();

        if (!sock || existingClient !== clientId) {
            return res.status(400).json({
                error: `Client ${clientId} not active`
            });
        }

        if (!numbers) return res.status(400).json({ error: "Numbers are required" });
        if (!message && !req.file) return res.status(400).json({ error: "Message or file is required" });

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
        res.status(500).json({ success: false, message: error.message || "Internal server error" });
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
    sock?.ev.removeAllListeners();
    sock?.end();
    process.exit(0);
});

function restartService() {
    console.log('♻️ Restarting service due to critical failure...');
    try {
        sock?.ev.removeAllListeners();
        sock?.end();
    } catch { }
    setTimeout(() => process.exit(1), 1000); // will restart if using PM2 or wrapper
}

app.listen(PORT, () => {
    const clientId = getExistingClient()
    if (clientId) {
        createSession(clientId);
    }
    console.log(`🚀 Multi-client WhatsApp API running on http://localhost:${PORT}`);
});

function getExistingClient() {
    const dirPath = path.join(__dirname, 'auth');

    if (!fs.existsSync(dirPath)) return null;

    const folders = fs.readdirSync(dirPath, { withFileTypes: true })
        .filter(item => item.isDirectory())
        .map(item => item.name);

    return folders.length > 0 ? folders[0] : null;
}

