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
        const sock = makeWASocket({ auth: state, version });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            await saveToDb(clientId, state.creds); // save only state.creds, not full state
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const qrBase64 = await qrcode.toDataURL(qr);
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

                if (reason === DisconnectReason.loggedOut) {
                    deleteCredsFromDb(clientId);
                    deleteSessionFiles(`./auth/${clientId}`, true);
                    updateWhatsAppStatus(clientId, "LOGOUT");
                    return reject({ success: false, message: "User logged out. Credentials deleted.", data: {} });
                }

                if (reason === DisconnectReason.timedOut) {
                    return reject({ success: false, message: "Connection timed out.", data: {} });
                }

                // Any other case: try reconnecting
                createSession(clientId).then(resolve).catch(reject);
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
}



// 👤 Login route to initiate QR for a client
app.get('/login/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (sessions[clientId]) {
        return res.json({ message: `Client ${clientId} is already connected.` });
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

app.post('/send/:clientId', async (req, res) => {
    const { clientId } = req.params;
    const { numbers, message } = req.body;

    const sock = sessions[clientId];
    if (!sock) {
        return res.status(400).json({ error: `Client ${clientId} not connected.` });
    }

    if (!Array.isArray(numbers) || !message) {
        return res.status(400).json({ error: 'numbers (array) and message are required' });
    }

    const failed = [];

    for (const number of numbers) {
        const jid = number.endsWith('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        try {
            await sock.sendMessage(jid, { text: message });
            console.log(`Sent to ${number}`);
        } catch (err) {
            console.log(`Failed to send to ${number}:`, err.message);
            failed.push(number);
        }
    }

    res.json({
        status: 'done',
        failedNumbers: failed,
        successCount: numbers.length - failed.length,
    });
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

// async function notifyWebhook(payload) {
//     const webhookUrl = process.env.WEBHOOK_URL;
//     if (!webhookUrl) return;

//     try {
//         const res = await fetch(webhookUrl, {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify(payload),
//         });

//         if (!res.ok) {
//             console.error(`❌ Webhook response error: ${res.status} ${res.statusText}`);
//         } else {
//             console.log(`🔔 Webhook notified:`, payload);
//         }
//     } catch (err) {
//         console.error(`❌ Failed to notify webhook:`, err.message);
//     }
// }

// const clients = {};

// app.get('/events/:clientId', (req, res) => {
//     const { clientId } = req.params;

//     // Set headers for SSE
//     res.setHeader('Content-Type', 'text/event-stream');
//     res.setHeader('Cache-Control', 'no-cache');
//     res.setHeader('Connection', 'keep-alive');

//     // Send an initial event to confirm connection
//     res.write(`data: Connected to SSE for client ${clientId}\n\n`);

//     // Save connection for later use
//     clients[clientId] = res;

//     // Cleanup on client disconnect
//     req.on('close', () => {
//         delete clients[clientId];
//     });
// });

// function sendSseToFrontend(clientId, data) {
//     const client = clients[clientId];
//     if (client) {
//         client.write(`data: ${JSON.stringify(data)}\n\n`);
//     } else {
//         console.log(`No active SSE connection for client ${clientId}`);
//     }
// }



app.listen(PORT, () => {
    initDb()
    console.log(`🚀 Multi-client WhatsApp API running on http://localhost:${PORT}`);
});
