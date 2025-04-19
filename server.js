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

// Configure Express
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session storage
const sessionDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}

// Connection manager
const connectionManager = new Map();

// Validate phone number format (e.g., 2347087243475)
const validatePhoneNumber = (number) => {
    const cleaned = number.replace(/[^\d]/g, '');
    return cleaned.length >= 10 && cleaned.length <= 15;
};

// HTML Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

app.get('/pair', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pair.html'));
});

// API Endpoints
app.post('/api/generate-session', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome')
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (update) => {
            if (update.connection === 'open') {
                const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                res.json({ 
                    sessionId,
                    sessionString,
                    message: 'Session generated successfully'
                });
                sock.end();
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

    // Check for existing connection
    if (connectionManager.has(sessionId)) {
        const existing = connectionManager.get(sessionId);
        if (existing.connected) {
            return res.status(400).json({ error: 'Session already connected' });
        }
        existing.sock.end(); // Clean up previous connection
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            getMessage: async () => ({}),
            connectTimeoutMs: 60000 // Wait up to 60 seconds for connection
        });

        const formattedNumber = phoneNumber.replace(/[^\d]/g, '');
        const userJid = `${formattedNumber}@s.whatsapp.net`;

        // Store connection info
        const connectionInfo = {
            sock,
            connected: false,
            timer: setTimeout(() => {
                if (!connectionInfo.connected) {
                    sock.end();
                    connectionManager.delete(sessionId);
                }
            }, 60000) // 60 second timeout
        };
        connectionManager.set(sessionId, connectionInfo);

        sock.ev.on('creds.update', saveCreds);
        
        // Generate pairing code
        const code = await sock.requestPairingCode(formattedNumber);
        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;

        // Handle connection events
        sock.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                connectionInfo.connected = true;
                clearTimeout(connectionInfo.timer);
                
                try {
                    const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                    
                    await sock.sendMessage(userJid, { 
                        text: `✅ WhatsApp connection established!\n\nYour Session ID: ${sessionId}\n\nSession String:\n${sessionString}` 
                    });
                    
                    await delay(1000);
                    sock.end();
                    connectionManager.delete(sessionId);
                } catch (sendError) {
                    console.error('Failed to send confirmation:', sendError);
                }
            } else if (update.connection === 'close') {
                clearTimeout(connectionInfo.timer);
                connectionManager.delete(sessionId);
            }
        });

        res.json({ 
            sessionId,
            pairingCode: formattedCode,
            message: 'Pairing code generated successfully. You have 60 seconds to connect.'
        });

    } catch (error) {
        console.error('Pairing error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/get-qr', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
    }

    if (phoneNumber && !validatePhoneNumber(phoneNumber)) {
        return res.status(400).json({ error: 'Invalid phone number format. Use format like 2347087243475' });
    }

    // Check for existing connection
    if (connectionManager.has(sessionId)) {
        const existing = connectionManager.get(sessionId);
        if (existing.connected) {
            return res.status(400).json({ error: 'Session already connected' });
        }
        existing.sock.end(); // Clean up previous connection
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            getMessage: async () => ({}),
            connectTimeoutMs: 60000 // Wait up to 60 seconds for connection
        });

        const targetNumber = phoneNumber ? phoneNumber.replace(/[^\d]/g, '') : null;
        const userJid = targetNumber ? `${targetNumber}@s.whatsapp.net` : null;

        // Store connection info
        const connectionInfo = {
            sock,
            connected: false,
            timer: setTimeout(() => {
                if (!connectionInfo.connected) {
                    sock.end();
                    connectionManager.delete(sessionId);
                }
            }, 60000) // 60 second timeout
        };
        connectionManager.set(sessionId, connectionInfo);

        sock.ev.on('creds.update', saveCreds);

        // Handle connection events
        sock.ev.on('connection.update', async (update) => {
            const { qr, connection } = update;
            
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
                            text: `✅ WhatsApp connection established!\n\nYour Session ID: ${sessionId}\n\nSession String:\n${sessionString}` 
                        });
                    } catch (sendError) {
                        console.error('Failed to send confirmation:', sendError);
                    }
                }
                
                await delay(1000);
                sock.end();
                connectionManager.delete(sessionId);
            } else if (connection === 'close') {
                clearTimeout(connectionInfo.timer);
                connectionManager.delete(sessionId);
            }
        });
    } catch (error) {
        console.error('QR generation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Cleanup on server close
process.on('SIGINT', () => {
    connectionManager.forEach((info, id) => {
        info.sock.end();
        clearTimeout(info.timer);
        console.log(`Closed connection for session: ${id}`);
    });
    process.exit();
});

// Start server
app.listen(PORT, () => {
    console.log(`Auth server running on http://localhost:${PORT}`);
});
