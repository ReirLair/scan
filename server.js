const fs = require('fs');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode');
const { Boom } = require('@hapi/boom');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    delay
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const sessionDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

const connectionManager = new Map();

const validatePhoneNumber = (number) => {
    const cleaned = number.replace(/[^\d]/g, '');
    return cleaned.length >= 10 && cleaned.length <= 15;
};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

app.get('/pair', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pair.html'));
});

app.post('/api/generate-session', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID is required' });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (update) => {
            if (update.connection === 'open') {
                const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                res.json({ sessionId, sessionString, message: 'Session generated successfully' });
                sock.end();
            } else if (update.connection === 'close') {
                const { reason } = update.lastDisconnect || {};
                if (reason === DisconnectReason.connectionLost) {
                    res.status(500).json({ error: 'Connection lost. Please try again.' });
                }
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/get-pairing-code', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;

    if (!sessionId || !phoneNumber) {
        return res.status(400).json({ error: 'Session ID and phone number are required' });
    }

    if (!validatePhoneNumber(phoneNumber)) {
        return res.status(400).json({ error: 'Invalid phone number format. Use format like 2347087243475' });
    }

    if (connectionManager.has(sessionId)) {
        const existing = connectionManager.get(sessionId);
        existing.sock.end();
        clearTimeout(existing.timer);
        connectionManager.delete(sessionId);
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            getMessage: async () => ({}),
            connectTimeoutMs: 60000
        });

        const formattedNumber = phoneNumber.replace(/[^\d]/g, '');
        const userJid = `${formattedNumber}@s.whatsapp.net`;

        const connectionInfo = {
            sock,
            connected: false,
            timer: setTimeout(() => {
                if (!connectionInfo.connected) {
                    sock.end();
                    connectionManager.delete(sessionId);
                    res.status(408).json({ error: 'Connection timed out. Please try again.' });
                }
            }, 60000)
        };
        connectionManager.set(sessionId, connectionInfo);

        sock.ev.on('creds.update', saveCreds);

        let code;
        try {
            code = await sock.requestPairingCode(formattedNumber);
        } catch (err) {
            await delay(2000);
            code = await sock.requestPairingCode(formattedNumber);
        }

        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                connectionInfo.connected = true;
                clearTimeout(connectionInfo.timer);
                const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                try {
                    await sock.sendMessage(userJid, {
                        text: `✅ WhatsApp connection established!\n\nSession ID: ${sessionId}\nSession String:\n${sessionString}`
                    });
                } catch (err) {}
                await delay(1000);
                sock.end();
                connectionManager.delete(sessionId);
            } else if (connection === 'close') {
                clearTimeout(connectionInfo.timer);
                connectionManager.delete(sessionId);
                const { reason } = lastDisconnect || {};
                if (reason === DisconnectReason.connectionLost) {
                    res.status(500).json({ error: 'Connection lost. Please try again.' });
                }
            }
        });

        res.json({
            sessionId,
            pairingCode: formattedCode,
            message: 'Pairing code generated successfully. You have 60 seconds to connect.'
        });

    } catch (error) {
        if (connectionManager.has(sessionId)) {
            const existing = connectionManager.get(sessionId);
            existing.sock.end();
            clearTimeout(existing.timer);
            connectionManager.delete(sessionId);
        }

        let message = error.message.includes('could not link device')
            ? 'Device linking failed. Please try again or use QR code.'
            : error.message;

        res.status(500).json({ error: message });
    }
});

app.post('/api/get-qr', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;

    if (!sessionId) return res.status(400).json({ error: 'Session ID is required' });

    if (phoneNumber && !validatePhoneNumber(phoneNumber)) {
        return res.status(400).json({ error: 'Invalid phone number format. Use format like 2347087243475' });
    }

    if (connectionManager.has(sessionId)) {
        const existing = connectionManager.get(sessionId);
        existing.sock.end();
        clearTimeout(existing.timer);
        connectionManager.delete(sessionId);
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            getMessage: async () => ({}),
            connectTimeoutMs: 60000
        });

        const targetNumber = phoneNumber ? phoneNumber.replace(/[^\d]/g, '') : null;
        const userJid = targetNumber ? `${targetNumber}@s.whatsapp.net` : null;

        const connectionInfo = {
            sock,
            connected: false,
            timer: setTimeout(() => {
                if (!connectionInfo.connected) {
                    sock.end();
                    connectionManager.delete(sessionId);
                    res.status(408).json({ error: 'QR code expired. Please try again.' });
                }
            }, 60000)
        };
        connectionManager.set(sessionId, connectionInfo);

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection, lastDisconnect } = update;

            if (qr) {
                qrcode.toDataURL(qr, (err, url) => {
                    if (!err) {
                        res.json({
                            sessionId,
                            qrCode: url,
                            message: 'QR code generated successfully. Scan within 60 seconds.'
                        });
                    }
                });
            }

            if (connection === 'open') {
                connectionInfo.connected = true;
                clearTimeout(connectionInfo.timer);

                if (userJid) {
                    try {
                        const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                        await sock.sendMessage(userJid, {
                            text: `✅ WhatsApp connection established!\n\nSession ID: ${sessionId}\nSession String:\n${sessionString}`
                        });
                    } catch (err) {}
                }

                await delay(1000);
                sock.end();
                connectionManager.delete(sessionId);
            } else if (connection === 'close') {
                clearTimeout(connectionInfo.timer);
                connectionManager.delete(sessionId);
                const { reason } = lastDisconnect || {};
                if (reason === DisconnectReason.connectionLost) {
                    res.status(500).json({ error: 'Connection lost. Please try again.' });
                }
            }
        });
    } catch (error) {
        if (connectionManager.has(sessionId)) {
            const existing = connectionManager.get(sessionId);
            existing.sock.end();
            clearTimeout(existing.timer);
            connectionManager.delete(sessionId);
        }

        res.status(500).json({ error: error.message });
    }
});

process.on('SIGINT', () => {
    connectionManager.forEach((info, id) => {
        info.sock.end();
        clearTimeout(info.timer);
        console.log(`Closed session: ${id}`);
    });
    process.exit();
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
