/**
 * desktop/preload.js
 *
 * Runs in a sandboxed context with access to both the DOM and Node/Electron IPC.
 * Exposes a safe, typed API to the renderer (UI) via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // ── Actions ────────────────────────────────────────────────────────────
    connect:      (clientId) => ipcRenderer.invoke('whatsapp:connect', clientId),
    disconnect:   ()         => ipcRenderer.invoke('whatsapp:disconnect'),
    restart:      (clientId) => ipcRenderer.invoke('whatsapp:restart', clientId),
    clearSession: ()         => ipcRenderer.invoke('whatsapp:clear-session'),

    // ── Queries ────────────────────────────────────────────────────────────
    getStatus:    ()         => ipcRenderer.invoke('get-status'),
    getPort:      ()         => ipcRenderer.invoke('get-port'),
    getClientId:  ()         => ipcRenderer.invoke('get-client-id'),
    setClientId:  (id)       => ipcRenderer.invoke('set-client-id', id),

    // ── Server-push event listeners ────────────────────────────────────────
    onWAStatus:   (cb) => ipcRenderer.on('wa:status',   (_, data) => cb(data)),
    onWAQR:       (cb) => ipcRenderer.on('wa:qr',       (_, data) => cb(data)),
    onLog:        (cb) => ipcRenderer.on('wa:log',       (_, data) => cb(data)),

    // ── Cleanup helpers ────────────────────────────────────────────────────
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
