const express = require('express');
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
const { saveToDb, getCredsFromDb, deleteCredsFromDb, initDb } = require('./db');


const app = express();
const PORT = process.env.PORT;
app.use(express.json());

const sessions = {};

async function createSession(clientId) {
    const sessionPath = `./auth/${clientId}`;
    fs.mkdirSync(sessionPath, { recursive: true });

    const { version } = await fetchLatestBaileysVersion();
    const credsFromDb = await getCredsFromDb(clientId);
    let state;
    let saveCreds;

    if (credsFromDb) {
        state = credsFromDb;
        saveCreds = async () => { };
    } else {
        const auth = await useMultiFileAuthState(sessionPath);
        state = auth.state;
        saveCreds = async () => {
            auth.saveCreds();
            await saveToDb(clientId, auth.state.creds);
        };
    }

    return new Promise((resolve, reject) => {
        const sock = makeWASocket({ auth: state, version });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const qrBase64 = await qrcode.toDataURL(qr);
                    return resolve({
                        success: true,
                        message: 'QR code generated',
                        qrCode: qrBase64,
                    });
                } catch (err) {
                    return reject({
                        success: false,
                        message: 'Failed to generate QR code',
                        error: err.message,
                    });
                }
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                sessions[clientId] = null;

                console.log(`Connection for ${clientId} closed. Reason: ${reason === DisconnectReason.loggedOut ? "Logout" : "Other"
                    }`);

                if (reason === DisconnectReason.loggedOut) {
                    deleteCredsFromDb(clientId);
                    return reject({ success: false, message: "User logged out. Credentials deleted." });
                }

                if (reason === DisconnectReason.timedOut) {
                    return reject({ success: false, message: "Connection timed out." });
                }

                // Any other case: try reconnecting
                createSession(clientId).then(resolve).catch(reject);
            }

            if (connection === 'open') {
                console.log(`✅ ${clientId} is connected`);
                sessions[clientId] = sock;
                return resolve({ success: true, message: "Connected", clientId });
            }
        });

        sock.ev.on('connection.error', (err) => {
            console.error('Connection error:', err);
            reject({ success: false, message: "Failed to connect.", error: err });
        });
    });
}



// 👤 Login route to initiate QR for a client
app.get('/login/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (sessions[clientId]) {
        return res.json({ message: `Client ${clientId} is already connected.` });
    }
    const response = await createSession(clientId)
    res.status(response.success ? 200 : 500).json(response);
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

function deleteSessionFiles(sessionPath) {
    if (fs.existsSync(sessionPath)) {
        fs.readdir(sessionPath, (err, files) => {
            if (err) {
                console.error(`Error reading directory ${sessionPath}:`, err);
                return;
            }

            files.forEach(file => {
                if (file === 'creds.json') return;

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
