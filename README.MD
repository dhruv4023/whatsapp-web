# Multi-Client WhatsApp API (Baileys)

A Node.js Express API for managing multi-client WhatsApp sessions
via WhatsApp Web using @whiskeysockets/baileys.

## Features

- ✅ QR code login
- ✅ Persistent sessions stored in DB and disk
- ✅ Sending messages to multiple numbers
- ✅ Multi-client architecture
- ✅ Session cleanup and logout

## How It Works

- **Login:**
    Generates a QR code for WhatsApp Web login.

- **Sessions:**
    Persisted on disk and optionally in a database for reconnects.

- **Messaging:**
    Send text messages to one or multiple WhatsApp numbers.

- **Logout:**
    Deletes session files and credentials.

## Installation

### Clone the repo
    git clone https://github.com/dhruv4023/whatsapp-web

### Move into the project
    cd whatsapp-web

### Install dependencies
    npm install

### Environment Variables (.env)

- PORT=5000
- ORIGIN_URL_LIST=["http://localhost:3000"]

- PORT: Port on which the Express app runs.
- ORIGIN_URL_LIST: JSON array of allowed origins for CORS.