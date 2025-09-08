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
const { saveToDb, getCredsFromDb, deleteCredsFromDb, initDb, updateWhatsAppStatus } = require('./db');

const multer = require("multer");


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


const sessions = {};

async function createSession(clientId) {
    try {
        const sessionPath = `./auth/${clientId}`;
        fs.mkdirSync(sessionPath, { recursive: true });

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        // Optionally load previously saved creds from DB and patch into state
        const credsFromDb = await getCredsFromDb(clientId);
        if (credsFromDb) {
            Object.assign(state.creds, credsFromDb); // patch only the creds if available
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

            sock.ev.removeAllListeners("messages.upsert")
            sock.ev.removeAllListeners("chats.set")
            sock.ev.removeAllListeners("contacts.set")

            sock.ev.on('creds.update', async () => {
                await saveCreds();
                await saveToDb(clientId, state.creds); // save only state.creds, not full state
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

                    console.log(`Connection for ${clientId} closed. Reason: ${reason === DisconnectReason.loggedOut ? "Logout" : "Other"}`);
                    if (reason === DisconnectReason.connectionClosed) {
                        return reject({ success: false, message: "Connection closed by server.", data: {} });
                    }

                    if (reason === DisconnectReason.connectionLost) {
                        return reject({ success: false, message: "Connection lost. Please try reconnecting.", data: {} });
                    }

                    if (reason === DisconnectReason.unavailableService) {
                        return reject({ success: false, message: "Service unavailable. Please try again later.", data: {} });
                    }
                    if (reason === DisconnectReason.loggedOut) {
                        deleteCredsFromDb(clientId);
                        deleteSessionFiles(`./auth/${clientId}`, true);
                        updateWhatsAppStatus(clientId, "LOGOUT");
                        return reject({ success: false, message: "User logged out. Credentials deleted.", data: {} });
                    }

                    if (reason === DisconnectReason.timedOut) {
                        return reject({ success: false, message: "Connection timed out.", data: {} });
                    }

                    if (reason == DisconnectReason.restartRequired) {
                        createSession(clientId).then(resolve).catch(reject);
                    }
                }

                if (connection === 'open') {
                    console.log(`✅ ${clientId} is connected`);
                    sessions[clientId] = sock;

                    const payload = { success: true, message: "Connected", data: {} };
                    updateWhatsAppStatus(clientId, "ACTIVE");
                    return resolve(payload);
                }
            });

            sock.ev.on('connection.error', (error) => {
                console.error('Connection error:', error);
                const payload = { success: false, message: "Failed to connect.", data: { error }, };
                reject(payload);
            });
        });
    } catch (error) {
        console.error(error)
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
    }
    deleteSessionFiles(`./auth/${clientId}`)
});

// app.post('/send/:clientId', async (req, res) => {
//     const { clientId } = req.params;
//     const { numbers, message } = req.body;

//     const sock = sessions[clientId];
//     if (!sock) {
//         return res.status(400).json({ error: `Client ${clientId} not connected.` });
//     }

//     if (!Array.isArray(numbers) || !message) {
//         return res.status(400).json({ error: 'numbers (array) and message are required' });
//     }

//     const failed = [];
//     const sentTo = []

//     for (const number of numbers) {
//         const jid = number.endsWith('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
//         try {
//             await sock.sendMessage(jid, { text: message });
//             sentTo.push(number)
//         } catch (err) {
//             console.error(`Failed to send to ${number}:`, err.message);
//             failed.push(number);
//         }
//     }

//     res.status(200).json({
//         status: true,
//         message: `sent successfully to ${sentTo.length} & failed for ${failed.length}`,
//         data: {
//             succeedNumbers: sentTo,
//             failedNumbers: failed,
//         }
//     });
// });


app.get('/logout/:clientId', async (req, res) => {
    const { clientId } = req.params;
    try {
        deleteCredsFromDb(clientId);
        updateWhatsAppStatus(clientId, "LOGOUT");
        res.status(200).json({ success: true, message: "Logout successfully!", data: {} });
    } catch (error) {
        console.error("❌ Session creation failed:", error);
        res.status(500).json(error);
    }
    deleteSessionFiles(`./auth/${clientId}`, true)
});

const upload = multer({ storage: multer.memoryStorage() });

// Universal file send (PDF, Image, Video, Audio, etc.)
app.post('/send/:clientId', upload.single("file"), async (req, res) => {
    const { clientId } = req.params;
    const { numbers, message } = req.body;

    try {
        
    const sock = sessions[clientId];
    if (!sock) {
        return res.status(400).json({ error: `Client ${clientId} not connected.` });
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

function deleteSessionFiles(sessionPath, delCreds = false) {
    if (fs.existsSync(sessionPath)) {
        fs.readdir(sessionPath, (err, files) => {
            if (err) {
                console.error(`Error reading directory ${sessionPath}:`, err);
                return;
            }

            files.forEach(file => {
                if (!delCreds && file === 'creds.json') return;

                const filePath = path.join(sessionPath, file);

                fs.rm(filePath, { recursive: true, force: true }, (err) => {
                    if (err) {
                        console.error(`Failed to delete ${filePath}:`, err);
                    }
                });
            });
        });
    } else {
        console.log(`Session path ${sessionPath} does not exist.`);
    }
}

app.listen(PORT, () => {
    initDb()
    console.log(`🚀 Multi-client WhatsApp API running on http://localhost:${PORT}`);
});
