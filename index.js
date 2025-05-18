const express = require('express');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require('@whiskeysockets/baileys');
const { saveToDb, getCredsFromDb, deleteCredsFromDb } = require('./db');


const app = express();
const PORT = 3000;
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

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`QR for ${clientId}:`);
                qrcode.generate(qr, { small: true });
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
    if (response.success) {
        res.status(200).json({ message: `QR Code shown in terminal for client ${clientId}.` });
    } else {
        res.status(500).json({ message: response.message });
    }
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
        fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
            if (err) {
                console.error(`Failed to delete session files at ${sessionPath}:`, err);
            } else {
                console.log(`Deleted session files at ${sessionPath}`);
            }
        });
    } else {
        console.log(`Session path ${sessionPath} does not exist.`);
    }
}


app.listen(PORT, () => {
    console.log(`🚀 Multi-client WhatsApp API running on http://localhost:${PORT}`);
});
