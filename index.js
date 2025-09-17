const express = require('express');
const cors = require('cors');
require('dotenv').config()
// const qrcode = require('qrcode-terminal');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require('@whiskeysockets/baileys');
const { saveToDb, getCredsFromDb, deleteCredsFromDb, initDb, updateWhatsAppStatus } = require('./db');

const multer = require("multer");

const { setTimeout: wait } = require("timers/promises");

const app = express();
const PORT = process.env.PORT;
const maxWorkers = process.env.WORKERS || 10;
app.use(express.json());

// ---------- CORS ----------
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

// ---------- State ----------
const sessions = {};
const messageQueues = {}; // per-client queues

// ---------- Queue Manager ----------
function startQueueProcessor(clientId, sock) {
    if (!messageQueues[clientId]) {
        messageQueues[clientId] = {
            queue: [],
            activeWorkers: 0,
        };
    }
    const clientQueue = messageQueues[clientId];

    async function processQueue() {
        if (clientQueue.activeWorkers >= maxWorkers) return;
        if (clientQueue.queue.length === 0) return;

        clientQueue.activeWorkers++;

        while (clientQueue.queue.length > 0) {
            const task = clientQueue.queue.shift();
            try {
                const delay = Math.floor(Math.random() * (20000 - 5000 + 1)) + 5000;
                await wait(delay);

                if (!sock || sock?.ws?.readyState !== 1) {
                    console.log(`❌ ${clientId} not connected, skipping message.`);
                    task.reject(new Error("Client not connected"));
                    continue;
                }

                await sock.sendMessage(task.jid, task.messageOptions);
                task.resolve({ success: true, jid: task.jid });
            } catch (err) {
                task.reject(err);
            }
        }

        clientQueue.activeWorkers--;
    }

    return processQueue;
}

// ---------- Session Creation ----------
async function createSession(clientId) {
    const sessionPath = `./auth/${clientId}`;
    fs.mkdirSync(sessionPath, { recursive: true });

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    // Load creds from DB if exist
    const credsFromDb = await getCredsFromDb(clientId);
    if (credsFromDb) {
        Object.assign(state.creds, credsFromDb);
    }

    return new Promise((resolve, reject) => {
        const sock = makeWASocket({
            auth: state, version,
            syncFullHistory: false,
            printQRInTerminal: false,
            browser: ['MultiClient', 'Chrome', '3.0'],
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
        });

        sock.ev.removeAllListeners("messages.upsert");
        sock.ev.removeAllListeners("chats.set");
        sock.ev.removeAllListeners("contacts.set");

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            await saveToDb(clientId, state.creds);
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const qrBase64 = await qrcode.toDataURL(qr);
                    // qrcode.generate(qr, {small: true});
                    return resolve({
                        success: true,
                        message: 'QR code generated',
                        data: { qrCode: qrBase64 },
                    });
                } catch (error) {
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

                console.log(`Connection for ${clientId} closed. Reason: ${reason}`);
                if (reason === DisconnectReason.loggedOut) {
                    deleteCredsFromDb(clientId);
                    deleteSessionFiles(`./auth/${clientId}`, true);
                    updateWhatsAppStatus(clientId, "LOGOUT");
                    return reject({ success: false, message: "User logged out. Credentials deleted." });
                }

                if (reason == DisconnectReason.restartRequired) {
                    createSession(clientId).then(resolve).catch(reject);
                }
            }

            if (connection === 'open') {
                console.log(`✅ ${clientId} is connected`);
                sessions[clientId] = sock;
                updateWhatsAppStatus(clientId, "ACTIVE");
                return resolve({ success: true, message: "Connected", data: {} });
            }
        });

        sock.ev.on('connection.error', (error) => {
            console.error('Connection error:', error);
            reject({ success: false, message: "Failed to connect.", data: { error } });
        });
    });
}

// ---------- Routes ----------
app.get('/login/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (sessions[clientId]) {
        return res.json({
            success: true,
            data: [{ webWhatsAppStatus: "ACTIVE" }],
            message: `You are already connected.`
        });
    }
    try {
        const response = await createSession(clientId);
        res.status(response.success ? 200 : 500).json(response);
    } catch (error) {
        console.error("❌ Session creation failed:", error);
        res.status(500).json(error);
    }
    deleteSessionFiles(`./auth/${clientId}`);
});

app.get('/logout/:clientId', async (req, res) => {
    const { clientId } = req.params;
    try {
        deleteCredsFromDb(clientId);
        updateWhatsAppStatus(clientId, "LOGOUT");
        res.status(200).json({ success: true, message: "Logout successfully!" });
    } catch (error) {
        console.error("❌ Logout failed:", error);
        res.status(500).json(error);
    }
    deleteSessionFiles(`./auth/${clientId}`, true);
});

const upload = multer({ storage: multer.memoryStorage() });

app.post('/send/:clientId', upload.single("file"), async (req, res) => {
    const { clientId } = req.params;
    const { numbers, message } = req.body;
    let sock = sessions[clientId];
    try {
        if (!sock || sock?.ws?.readyState !== 1) {
            await createSession(clientId);
            sock = sessions[clientId];
            return res.status(400).json({ success: false, message: `Client ${clientId} is not connected.` });
        }

        if (!numbers) {
            return res.status(400).json({ success: false, message: 'numbers (JSON array) are required' });
        }

        let parsedNumbers;
        try {
            parsedNumbers = JSON.parse(numbers);
        } catch {
            return res.status(400).json({ success: false, message: 'numbers must be a valid JSON array' });
        }
        for (const num of parsedNumbers) {
            if (!isValidNumber(num)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid number detected: ${num}`,
                });
            }
        }


        if (!messageQueues[clientId]) {
            startQueueProcessor(clientId, sock);
        }

        const clientQueue = messageQueues[clientId];
        if (clientQueue.activeWorkers >= maxWorkers) {
            return res.status(429).json({
                success: false,
                message: `Client ${clientId} is busy. Try again later.`
            });
        }

        parsedNumbers.forEach(number => {
            const jid = number.endsWith('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;

            let messageOptions = {};
            if (req.file) {
                const fileMime = req.file.mimetype;
                if (fileMime.startsWith("image/")) {
                    messageOptions = { image: req.file.buffer, mimetype: fileMime, caption: message || "" };
                } else if (fileMime.startsWith("video/")) {
                    messageOptions = { video: req.file.buffer, mimetype: fileMime, caption: message || "" };
                } else if (fileMime.startsWith("audio/")) {
                    messageOptions = { audio: req.file.buffer, mimetype: fileMime, ptt: false };
                } else {
                    messageOptions = {
                        document: req.file.buffer,
                        mimetype: fileMime || 'application/octet-stream',
                        fileName: req.file.originalname,
                        caption: message || "📎 Document"
                    };
                }
            } else {
                messageOptions = { text: message };
            }

            clientQueue.queue.push({
                jid,
                messageOptions,
                resolve: () => console.log(`✅ Queued for ${jid}`),
                reject: (err) => console.error(`❌ Queue failed for ${jid}:`, err)
            });
        });

        // Start worker
        startQueueProcessor(clientId, sock)();

        // ✅ Instant response
        return res.status(200).json({
            success: true,
            message: `Queued ${parsedNumbers.length} message(s) for ${clientId}.`
        });

    } catch (error) {
        return res.status(500).json({ success: false, message: "Failed to send messages.", data: { error } });
    }
});

// ---------- Helpers ----------
function deleteSessionFiles(sessionPath, delCreds = false) {
    if (fs.existsSync(sessionPath)) {
        fs.readdir(sessionPath, (err, files) => {
            if (err) return console.error(`Error reading ${sessionPath}:`, err);
            files.forEach(file => {
                if (!delCreds && file === 'creds.json') return;
                const filePath = path.join(sessionPath, file);
                fs.rm(filePath, { recursive: true, force: true }, (err) => {
                    if (err) console.error(`Failed to delete ${filePath}:`, err);
                });
            });
        });
    }
}

// ---------- Start ----------
app.listen(PORT, () => {
    initDb();
    console.log(`🚀 Multi-client WhatsApp API running on http://localhost:${PORT}`);
});


function isValidNumber(num) {
    return /^[0-9]{8,15}$/.test(num); // basic check: 8–15 digits
}
