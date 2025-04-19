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
        syncFullHistory: false,
        fireInitQueries: true,
        shouldIgnoreJid: jid => false,
        linkPreviewImageThumbnailWidth: 192,
        transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 }
    });
};

const cleanupConnection = (sessionId) => {
    if (connectionManager.has(sessionId)) {
        const { sock, timer } = connectionManager.get(sessionId);
        sock?.end();
        clearTimeout(timer);
        connectionManager.delete(sessionId);
        
        try {
            const sessionPath = path.join(sessionDir, sessionId);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        } catch (err) {
            console.error('Error cleaning up session files:', err);
        }
    }
};

app.post('/api/get-pairing-code', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;
    if (!sessionId || !phoneNumber) return res.status(400).json({ error: 'Session ID and phone number are required.' });
    if (!validatePhoneNumber(phoneNumber)) return res.status(400).json({ error: 'Invalid phone number format.' });

    cleanupConnection(sessionId);

    let responded = false;
    const sendResponse = (status, data) => {
        if (!responded) {
            responded = true;
            return res.status(status).json(data);
        }
    };

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = await createSocket(state, saveCreds);
        const formattedNumber = phoneNumber.replace(/[^\d]/g, '');
        const userJid = `${formattedNumber}@s.whatsapp.net`;

        const timer = setTimeout(() => {
            sendResponse(408, { error: 'Pairing timed out. Try again.' });
            cleanupConnection(sessionId);
        }, 120000); // Increased timeout to 120 seconds

        connectionManager.set(sessionId, { sock, timer });

        sock.ev.on('creds.update', saveCreds);

        let code = null;
        let attempts = 0;
        const maxAttempts = 5; // Increased max attempts
        
        while (attempts < maxAttempts && !code) {
            try {
                code = await sock.requestPairingCode(formattedNumber);
                if (code) break;
            } catch (err) {
                attempts++;
                console.error(`Pairing attempt ${attempts} failed:`, err.message);
                if (attempts >= maxAttempts) {
                    throw new Error('Failed to generate pairing code after multiple attempts. Please try again later.');
                }
                await delay(3000); // Increased delay between attempts
            }
        }

        if (!code) throw new Error('Failed to generate pairing code. Please try again.');

        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, isNewLogin } = update;

            if (connection === 'open') {
                clearTimeout(timer);
                try {
                    // Wait for initial sync to complete
                    await delay(2000);
                    
                    const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                    try {
                        await sock.sendMessage(userJid, {
                            text: `✅ WhatsApp connected!\nSession ID: ${sessionId}\nSession String:\n${sessionString}`
                        });
                    } catch (err) {
                        console.error('Error sending connection message:', err);
                    }
                    
                    sendResponse(200, {
                        sessionId,
                        pairingCode: formattedCode,
                        message: 'Successfully connected and paired.',
                        isNewLogin
                    });
                    
                    await delay(1000);
                    sock.end();
                    connectionManager.delete(sessionId);
                } catch (err) {
                    console.error('Connection open handler error:', err);
                    sendResponse(500, { error: 'Connection established but sync failed.' });
                }
            }

            if (connection === 'close') {
                clearTimeout(timer);
                const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.reason;
                
                if (reason === DisconnectReason.connectionLost) {
                    sendResponse(500, { error: 'Connection lost. Please try again.' });
                } else if (reason === DisconnectReason.restartRequired) {
                    sendResponse(500, { error: 'Session expired. Please generate a new pairing code.' });
                } else if (reason === DisconnectReason.badSession) {
                    sendResponse(500, { error: 'Invalid session. Please start a new session.' });
                } else if (reason === DisconnectReason.invalidSession) {
                    sendResponse(500, { error: 'Session invalid. Please generate a new code.' });
                } else {
                    sendResponse(500, { error: 'Disconnected during pairing. Try again.' });
                }
                connectionManager.delete(sessionId);
            }
        });

        // Initial response with the pairing code
        sendResponse(200, {
            sessionId,
            pairingCode: formattedCode,
            message: 'Pairing code generated. Enter this code in your WhatsApp linked devices section within 2 minutes.'
        });

    } catch (err) {
        cleanupConnection(sessionId);
        console.error('Pairing error:', err);
        const errorMessage = err.message?.toLowerCase();
        let userMessage = err.message;
        
        if (errorMessage.includes('link')) {
            userMessage = 'Device linking failed. Please try again or use QR code method.';
        } else if (errorMessage.includes('timed out')) {
            userMessage = 'Request timed out. Please try again.';
        } else if (errorMessage.includes('attempt')) {
            userMessage = 'Failed after multiple attempts. Please wait a few minutes and try again.';
        } else if (errorMessage.includes('session')) {
            userMessage = 'Session error. Please start a new pairing process.';
        }
        
        sendResponse(500, { 
            error: userMessage,
            suggestion: 'Try using the QR code method if pairing continues to fail.'
        });
    }
});

// QR code endpoint remains the same as in previous version
app.post('/api/get-qr', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;

    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });
    if (phoneNumber && !validatePhoneNumber(phoneNumber)) {
        return res.status(400).json({ error: 'Invalid phone number format.' });
    }

    cleanupConnection(sessionId);

    // Response tracker to prevent multiple responses
    let responded = false;
    const sendResponse = (status, data) => {
        if (!responded) {
            responded = true;
            return res.status(status).json(data);
        }
    };

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = await createSocket(state, saveCreds);
        const targetNumber = phoneNumber?.replace(/[^\d]/g, '');
        const userJid = targetNumber ? `${targetNumber}@s.whatsapp.net` : null;

        const timer = setTimeout(() => {
            sendResponse(408, { error: 'QR code expired. Try again.' });
            cleanupConnection(sessionId);
        }, 90000);

        connectionManager.set(sessionId, { sock, timer });
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection, lastDisconnect } = update;

            if (qr && !responded) {
                try {
                    const url = await qrcode.toDataURL(qr);
                    sendResponse(200, {
                        sessionId,
                        qrCode: url,
                        message: 'QR code generated. Scan within 90 seconds.'
                    });
                } catch (err) {
                    console.error('QR generation error:', err);
                    sendResponse(500, { error: 'Failed to generate QR code.' });
                }
            }

            if (connection === 'open') {
                clearTimeout(timer);
                if (userJid) {
                    const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                    try {
                        await sock.sendMessage(userJid, {
                            text: `✅ WhatsApp connected!\nSession ID: ${sessionId}\nSession String:\n${sessionString}`
                        });
                    } catch (err) {
                        console.error('Error sending connection message:', err);
                    }
                }
                sendResponse(200, {
                    sessionId,
                    message: 'Successfully connected via QR code.'
                });
                await delay(1000);
                sock.end();
                connectionManager.delete(sessionId);
            }

            if (connection === 'close') {
                clearTimeout(timer);
                const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.reason;
                if (reason === DisconnectReason.connectionLost) {
                    sendResponse(500, { error: 'Connection lost. Please try again.' });
                } else if (reason === DisconnectReason.restartRequired) {
                    sendResponse(500, { error: 'Session expired. Please scan a new QR code.' });
                } else {
                    sendResponse(500, { error: 'Disconnected during QR scan. Try again.' });
                }
                connectionManager.delete(sessionId);
            }
        });
    } catch (err) {
        cleanupConnection(sessionId);
        console.error('QR session error:', err);
        sendResponse(500, { error: err.message });
    }
});

// UI routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/qr', (req, res) => res.sendFile(path.join(__dirname, 'public', 'qr.html')));
app.get('/pair', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pair.html')));

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    connectionManager.forEach(({ sock, timer }, id) => {
        sock?.end();
        clearTimeout(timer);
        console.log(`Closed session: ${id}`);
    });
    process.exit();
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
