import express from 'express';
import pkg from 'whatsapp-web.js';
// import qrcode from 'qrcode';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
const { Client, LocalAuth } = pkg;

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json());

// Store active clients by studioId
const clients = new Map();

// Initialize WhatsApp client
app.post('/init/:studioId', async (req, res) => {
    const { studioId } = req.params;

    if (clients.has(studioId)) {
        return res.status(400).json({ error: 'Client already initialized for this studioId' });
    }

    try {
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: studioId }),
            puppeteer: { headless: true, args: ['--no-sandbox'] },
        });

        let qrCodeGenerated = false;

        client.on('qr', (qr) => {
            if (!qrCodeGenerated) {
                qrCodeGenerated = true;
                console.log(`QR Code for ${studioId}:`);
                qrcode.generate(qr, { small: true });
                // Do not send res here, keep it simple for now
            }
        });

        client.on('ready', () => {
            console.log(`${studioId} - WhatsApp client ready`);
            clients.set(studioId, client);
        });

        client.on('disconnected', (reason) => {
            console.log(`${studioId} - Disconnected: ${reason}`);
            clients.delete(studioId);
        });

        await client.initialize();

        res.status(200).json({ message: 'Client initialization started. Scan the QR code in terminal.' });

    } catch (error) {
        console.error(`Client initialization failed for ${studioId}:`, error);
        res.status(500).json({ error: 'Failed to initialize client' });
    }
});


// Send message
app.post('/send', async (req, res) => {
    const { number, message, studioId } = req.body;
    console.log(clients)

    // Validate input
    if (!number || !message || !studioId) {
        return res.status(400).json({ error: 'Missing required fields: number, message, or studioId' });
    }

    const client = clients.get(studioId);
    if (!client) {
        return res.status(400).json({ error: 'Client not initialized for this studioId' });
    }

    try {
        // Ensure client is ready
        const isReady = await client.getState() === 'CONNECTED';
        if (!isReady) {
            return res.status(400).json({ error: 'Client not ready. Please authenticate first.' });
        }

        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        await client.sendMessage(chatId, message);
        res.json({ success: true });
    } catch (error) {
        console.error(`Message sending failed for ${studioId}:`, error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Cleanup on server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    for (const [studioId, client] of clients) {
        await client.destroy();
        console.log(`${studioId} - Client destroyed`);
    }
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp sender server started on port ${PORT}`));