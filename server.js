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

// Active connections map
const activeSockets = new Map();

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

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            getMessage: async () => ({})
        });

        activeSockets.set(sessionId, sock);

        sock.ev.on('creds.update', saveCreds);
        
        const formattedNumber = phoneNumber.replace(/[^\d]/g, '');
        const code = await sock.requestPairingCode(formattedNumber);
        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;

        // Handle successful connection
        sock.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                await delay(2000); // Wait for full connection
                
                try {
                    const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                    const userJid = `${formattedNumber}@s.whatsapp.net`;
                    
                    await sock.sendMessage(userJid, { 
                        text: `✅ WhatsApp connection established!\n\nYour Session ID: ${sessionId}\n\nSession String:\n${sessionString}` 
                    });
                    
                    await delay(1000);
                    sock.end(); // Disconnect after sending
                    activeSockets.delete(sessionId);
                } catch (sendError) {
                    console.error('Failed to send confirmation:', sendError);
                }
            }
        });

        res.json({ 
            sessionId,
            pairingCode: formattedCode,
            message: 'Pairing code generated successfully'
        });
    } catch (error) {
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

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            getMessage: async () => ({})
        });

        activeSockets.set(sessionId, sock);

        sock.ev.on('creds.update', saveCreds);
        
        let targetNumber = phoneNumber ? phoneNumber.replace(/[^\d]/g, '') : null;

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection } = update;
            
            if (qr) {
                qrcode.toDataURL(qr, (err, url) => {
                    if (!err) {
                        res.json({ 
                            sessionId,
                            qrCode: url,
                            message: 'QR code generated successfully'
                        });
                    }
                });
            }

            if (connection === 'open' && targetNumber) {
                await delay(2000); // Wait for full connection
                
                try {
                    const sessionString = Buffer.from(JSON.stringify(sock.authState.creds)).toString('base64');
                    const userJid = `${targetNumber}@s.whatsapp.net`;
                    
                    await sock.sendMessage(userJid, { 
                        text: `✅ WhatsApp connection established!\n\nYour Session ID: ${sessionId}\n\nSession String:\n${sessionString}` 
                    });
                    
                    await delay(1000);
                    sock.end(); // Disconnect after sending
                    activeSockets.delete(sessionId);
                } catch (sendError) {
                    console.error('Failed to send confirmation:', sendError);
                }
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Cleanup on server close
process.on('SIGINT', () => {
    activeSockets.forEach((sock, id) => {
        sock.end();
        console.log(`Closed connection for session: ${id}`);
    });
    process.exit();
});

// Start server
app.listen(PORT, () => {
    console.log(`Auth server running on http://localhost:${PORT}`);
});
