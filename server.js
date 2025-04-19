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

const createSocket = async (state, saveCreds) => {
    return makeWASocket({
        auth: state,
        browser: Browsers.macOS('Safari'),
        printQRInTerminal: false,
        getMessage: async () => ({}),
        markOnlineOnConnect: true,
        emitOwnEvents: true,
        keepAliveIntervalMs: 30_000,
        connectTimeoutMs: 120_000,
        defaultQueryTimeoutMs: 90_000,
    });
};

const cleanupConnection = (sessionId) => {
    if (connectionManager.has(sessionId)) {
        const { sock, timer } = connectionManager.get(sessionId);
        sock?.end();
        clearTimeout(timer);
        connectionManager.delete(sessionId);
    }
};

app.post('/api/get-pairing-code', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;
    if (!sessionId || !phoneNumber) return res.status(400).json({ error: 'Session ID and phone number are required.' });
    if (!validatePhoneNumber(phoneNumber)) return res.status(400).json({ error: 'Invalid phone number format.' });

    cleanupConnection(sessionId);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = await createSocket(state, saveCreds);
        const formattedNumber = phoneNumber.replace(/[^\d]/g, '');
        const userJid = `${formattedNumber}@s.whatsapp.net`;

        let responded = false;

        const timer = setTimeout(() => {
            if (!responded) {
                cleanupConnection(sessionId);
                responded = true;
                return res.status(408).json({ error: 'Pairing timed out. Try again.' });
            }
        }, 90000);

        connectionManager.set(sessionId, { sock, timer });

        sock.ev.on('creds.update', saveCreds);

        let code = null;
        for (let i = 0; i < 3; i++) {
            try {
                code = await sock.requestPairingCode(formattedNumber);
                if (code) break;
            } catch (err) {
                await delay(2000);
            }
        }

        if (!code) throw new Error('Failed to generate pairing code. Please try again.');

        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                clearTimeout(timer);
                if (!responded) {
                    responded = true;
                    const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                    try {
                        await sock.sendMessage(userJid, {
                            text: `✅ WhatsApp connected!\nSession ID: ${sessionId}\nSession String:\n${sessionString}`
                        });
                    } catch {}
                    res.json({
                        sessionId,
                        pairingCode: formattedCode,
                        message: 'Successfully connected and paired.'
                    });
                }
                sock.end();
                connectionManager.delete(sessionId);
            }

            if (connection === 'close') {
                clearTimeout(timer);
                connectionManager.delete(sessionId);
                if (!responded) {
                    const reason = lastDisconnect?.reason;
                    responded = true;
                    if (reason === DisconnectReason.connectionLost) {
                        res.status(500).json({ error: 'Connection lost. Please try again.' });
                    } else {
                        res.status(500).json({ error: 'Disconnected during pairing. Try again.' });
                    }
                }
            }
        });

        if (!responded) {
            res.json({
                sessionId,
                pairingCode: formattedCode,
                message: 'Pairing code generated. Scan within 90 seconds.'
            });
        }

    } catch (err) {
        cleanupConnection(sessionId);
        const isLinkError = err.message?.toLowerCase().includes('link');
        return res.status(500).json({
            error: isLinkError ? 'Device linking failed. Try again or use QR code.' : err.message
        });
    }
});

app.post('/api/get-qr', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;

    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });
    if (phoneNumber && !validatePhoneNumber(phoneNumber)) {
        return res.status(400).json({ error: 'Invalid phone number format.' });
    }

    cleanupConnection(sessionId);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = await createSocket(state, saveCreds);
        const targetNumber = phoneNumber?.replace(/[^\d]/g, '');
        const userJid = targetNumber ? `${targetNumber}@s.whatsapp.net` : null;

        let responded = false;

        const timer = setTimeout(() => {
            if (!responded) {
                cleanupConnection(sessionId);
                responded = true;
                return res.status(408).json({ error: 'QR code expired. Try again.' });
            }
        }, 90000);

        connectionManager.set(sessionId, { sock, timer });
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection, lastDisconnect } = update;

            if (qr && !responded) {
                qrcode.toDataURL(qr, (err, url) => {
                    if (!err && !responded) {
                        responded = true;
                        res.json({
                            sessionId,
                            qrCode: url,
                            message: 'QR code generated. Scan within 90 seconds.'
                        });
                    }
                });
            }

            if (connection === 'open') {
                clearTimeout(timer);
                if (!responded) {
                    responded = true;
                    if (userJid) {
                        const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                        try {
                            await sock.sendMessage(userJid, {
                                text: `✅ WhatsApp connected!\nSession ID: ${sessionId}\nSession String:\n${sessionString}`
                            });
                        } catch {}
                    }
                }
                await delay(1500);
                sock.end();
                connectionManager.delete(sessionId);
            }

            if (connection === 'close') {
                clearTimeout(timer);
                connectionManager.delete(sessionId);
                const reason = lastDisconnect?.reason;
                if (!responded) {
                    responded = true;
                    if (reason === DisconnectReason.connectionLost) {
                        res.status(500).json({ error: 'Connection lost. Please try again.' });
                    } else {
                        res.status(500).json({ error: 'Disconnected during QR scan. Try again.' });
                    }
                }
            }
        });
    } catch (err) {
        cleanupConnection(sessionId);
        res.status(500).json({ error: err.message });
    }
});

// UI routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/qr', (req, res) => res.sendFile(path.join(__dirname, 'public', 'qr.html')));
app.get('/pair', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pair.html')));

// Graceful shutdown
process.on('SIGINT', () => {
    connectionManager.forEach(({ sock, timer }, id) => {
        sock.end();
        clearTimeout(timer);
        console.log(`Closed session: ${id}`);
    });
    process.exit();
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
