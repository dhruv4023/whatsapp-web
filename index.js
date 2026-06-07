/**
 * index.js — CLI / PM2 / headless entry point
 *
 * This file preserves backward compatibility for `npm run dev`,
 * `pm2 start ecosystem.config.js`, and any direct `node index.js` usage.
 *
 * All business logic now lives in server/index.js.
 */

require('dotenv').config();
const { startServer } = require('./server');

const PORT = process.env.PORT || 5002;

const { stop } = startServer({ port: PORT });

process.on('SIGINT', async () => {
    console.log('🛑 Shutting down...');
    await stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, shutting down...');
    await stop();
    process.exit(0);
});
