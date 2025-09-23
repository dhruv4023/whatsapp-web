const express = require('express');
const cors = require('cors');
require('dotenv').config()
// const qrcode = require('qrcode-terminal');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require('@whiskeysockets/baileys');

const multer = require("multer");

const _EVENTS_ = [
    'messaging-history.set',
    'chats.upsert',
    'chats.update',
    'chats.delete',
    'contacts.upsert',
    'contacts.update',
    'messages.upsert',
    'messages.update',
    'messages.delete',
    'messages.reaction',
    'message-receipt.update',
    'groups.update'
];

const app = express();
const PORT = process.env.PORT;
app.use(express.json());

const corsOptions = {
    origin: function (origin, callback) {
        const allowedOrigins = JSON.parse(process.env.ORIGIN_URL_LIST);
        if (allowedOrigins.includes(origin) || !origin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
};

app.use(cors(corsOptions));


const sessions = {};       // { clientId: sock }
const lruList = [];   // keeps insertion order
const MAX_SESSIONS = 3;

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
                    deleteSessionFiles(`./auth/${clientId}`, false);
                } catch (error) {
                    deleteSessionFiles(`./auth/${clientId}`, false);
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
                    sessions[clientId] = null;

                    let message = "Connection closed";
                    console.log(`❌ Connection closed for ${clientId}. Reason: ${reason}`);
                    if (reason === DisconnectReason.restartRequired || reason === DisconnectReason.streamErrored) {
                        console.log(`🔄 Stream errored. Restarting session for ${clientId}...`);
                        (async () => {
                            sessions[clientId]?.ev.removeAllListeners();
                            sessions[clientId]?.end();
                            sessions[clientId] = null;
                            await createSession(clientId);
                        })();
                    } else if (reason === DisconnectReason.loggedOut) {
                        sessions[clientId]?.ev.removeAllListeners();
                        sessions[clientId]?.end();
                        sessions[clientId] = null;
                        deleteSessionFiles(`./auth/${clientId}`, true);
                        message = "User logged out. Credentials deleted.";
                    } else if (reason === DisconnectReason.connectionLost) {
                        message = "Connection lost. Please try reconnecting.";
                        sessions[clientId]?.ev.removeAllListeners();
                        sessions[clientId]?.end();
                        sessions[clientId] = null;
                        deleteSessionFiles(`./auth/${clientId}`, true);
                    } else if (reason === DisconnectReason.timedOut) {
                        message = "Connection timed out.";
                        sessions[clientId]?.ev.removeAllListeners();
                        sessions[clientId]?.end();
                        sessions[clientId] = null;
                        deleteSessionFiles(`./auth/${clientId}`, true);
                    }

                    settled = true;
                    return reject({ success: false, message, data: {} });
                }

                if (!settled && connection === 'open') {
                    console.log(`✅ ${clientId} is connected`);
                    sessions[clientId] = sock; // store the session
                    touchSession(clientId);     // mark as recently used
                    enforceMaxSessions();       // evict if over limit
                    settled = true;
                    // updateWhatsAppStatus(clientId, "ACTIVE");
                    deleteSessionFiles(`./auth/${clientId}`, false);
                    return resolve({ success: true, message: "Connected", data: {} });
                }
            });

            sock.ev.on('connection.error', (error) => {
                sessions[clientId]?.ev.removeAllListeners();
                sessions[clientId]?.end();
                sessions[clientId] = null;
                deleteSessionFiles(`./auth/${clientId}`, true);
                if (!settled) {
                    settled = true;
                    console.error('Connection error:', error);
                    reject({ success: false, message: "Failed to connect.", data: { error } });
                }
            });
        });
    } catch (error) {
        console.error(error);
    }
}



// 👤 Login route to initiate QR for a client
app.get('/login/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (sessions[clientId]) {
        return res.json({
            success: true, data: [
                {
                    "webWhatsAppStatus": "ACTIVE"
                }
            ], message: `You are already connected.`
        });
    }
    try {
        const response = await createSession(clientId);
        res.status(response.success ? 200 : 500).json(response);
    } catch (error) {
        console.error("❌ Session creation failed:", error);
        res.status(500).json(error);
        sessions[clientId]?.ev.removeAllListeners();
        sessions[clientId]?.end();
        sessions[clientId] = null;
        deleteSessionFiles(`./auth/${clientId}`, true);
    }
});

app.get('/logout/:clientId', async (req, res) => {
    const { clientId } = req.params;
    try {
        sessions[clientId]?.ev.removeAllListeners();
        sessions[clientId]?.end();
        sessions[clientId] = null;
        deleteSessionFiles(`./auth/${clientId}`, true)
        res.status(200).json({ success: true, message: "Logout successfully!", data: {} });
    } catch (error) {
        console.error("❌ Session creation failed:", error);
        res.status(500).json(error);
    }
});

const upload = multer({ storage: multer.memoryStorage() });

// Universal file send (PDF, Image, Video, Audio, etc.)
app.post('/send/:clientId', upload.single("file"), async (req, res) => {
    const { clientId } = req.params;
    const { numbers, message } = req.body;
    try {
        let sock = sessions[clientId];
        if (!sock) {
            const { success } = await createSession(clientId)
            if (!success) {
                return res.status(400).json({ error: `Client ${clientId} not connected.` });
            }
            sock = sessions[clientId];
            touchSession(clientId);
        }

        if (!numbers) {
            return res.status(400).json({ error: 'numbers (JSON array) are required' });
        }

        let parsedNumbers;
        try {
            parsedNumbers = JSON.parse(numbers);
        } catch (err) {
            return res.status(400).json({ error: 'numbers must be a valid JSON array' });
        }

        const failed = [];
        const sentTo = [];

        for (const number of parsedNumbers) {
            const jid = number.endsWith('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
            await new Promise(r => setTimeout(r, 100));
            try {
                let messageOptions = {};
                if (req.file) {
                    const fileMime = req.file.mimetype;

                    if (fileMime.startsWith("image/")) {
                        messageOptions = {
                            image: req.file.buffer,
                            mimetype: fileMime,
                            caption: message || ""
                        };
                    } else if (fileMime.startsWith("video/")) {
                        messageOptions = {
                            video: req.file.buffer,
                            mimetype: fileMime,
                            caption: message || ""
                        };
                    } else if (fileMime.startsWith("audio/")) {
                        messageOptions = {
                            audio: req.file.buffer,
                            mimetype: fileMime,
                            ptt: false // set true if you want it as voice note
                        };
                    } else {
                        // default: send as document (PDF, DOCX, ZIP, etc.)
                        messageOptions = {
                            document: req.file.buffer,
                            mimetype: fileMime || 'application/octet-stream',
                            fileName: req.file.originalname,
                            caption: message || "📎 Document"
                        };
                    }
                    await sock.sendMessage(jid, messageOptions);
                    sentTo.push(number);
                } else {
                    await sock.sendMessage(jid, { text: message });
                    sentTo.push(number)
                }
            } catch (err) {
                console.error(err)
                console.error(`Failed to send file to ${number}:`, err.message);
                failed.push(number);
            }
        }
        deleteSessionFiles(`./auth/${clientId}`, false);
        res.status(200).json({
            status: true,
            message: `File sent successfully to ${sentTo.length} & failed for ${failed.length}`,
            data: {
                succeedNumbers: sentTo,
                failedNumbers: failed,
            }
        });

    } catch (error) {
        console.error("❌ Sending file failed:", error);
        res.status(500).json({ success: false, message: "Failed to send file.", data: { error } });
    }
});

async function deleteSessionFiles(sessionPath, delCreds = false) {
    if (!fs.existsSync(sessionPath)) return;
    const files = await fs.promises.readdir(sessionPath);

    for (const file of files) {
        try {
            if (!delCreds && file === 'creds.json') continue;
            await fs.promises.rm(path.join(sessionPath, file), { recursive: true, force: true });
            console.log(`Deleted ${file} from ${sessionPath}`);
        } catch (err) {
            console.error(`Failed to delete ${file}:`, err);
        }
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Multi-client WhatsApp API running on http://localhost:${PORT}`);
});

function touchSession(clientId) {
    const index = lruList.indexOf(clientId);
    if (index !== -1) lruList.splice(index, 1); // remove old position
    lruList.push(clientId); // mark as recently used
}

function enforceMaxSessions() {
    while (lruList.length > MAX_SESSIONS) {
        const oldestClientId = lruList.shift(); // remove least recently used
        const sock = sessions[oldestClientId];
        if (sock) {
            sock.ev.removeAllListeners();
            sock.end();
            delete sessions[oldestClientId];
            deleteSessionFiles(`./auth/${oldestClientId}`, false); // keep creds
            console.log(`🗑️ Evicted LRU session: ${oldestClientId}`);
        }
    }
}
