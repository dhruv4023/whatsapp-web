const path = require('path');

const APP_NAME = 'WhatsApp Desktop';
const APP_VERSION = '1.0.0';
const DEFAULT_PORT = process.env.PORT || 5002;
const DEFAULT_CLIENT_ID = process.env.WA_CLIENT_ID || 'default-client';

// In production (packaged Electron), use the user's app data directory.
// In development, use the project root's auth folder.
const IS_ELECTRON_PACKAGED = process.type === 'browser' && require('electron').app.isPackaged;

function getAuthBasePath() {
    if (process.type === 'browser') {
        // Running inside Electron main process
        const { app } = require('electron');
        return path.join(app.getPath('userData'), 'auth');
    }
    // Running in CLI / server context
    return path.join(__dirname, '..', 'auth');
}

module.exports = {
    APP_NAME,
    APP_VERSION,
    DEFAULT_PORT,
    DEFAULT_CLIENT_ID,
    getAuthBasePath,
};
