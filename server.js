const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const Pino = require('pino');
const {
    default: ToxxicTechConnect,
    useMultiFileAuthState,
    DisconnectReason,
    makeInMemoryStore,
    BufferJSON,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Enhanced logger with colors and timestamps
const log = (message) => {
    console.log(`\x1b[36m[${new Date().toISOString()}]\x1b[0m \x1b[32m[LEVI-MD]\x1b[0m → ${message}`);
};
const errorLog = (message) => {
    console.error(`\x1b[36m[${new Date().toISOString()}]\x1b[0m \x1b[31m[LEVI-MD]\x1b[0m → ❌ ${message}`);
};

// Session storage
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    log(`Created sessions directory.`);
}

// Store active connections
const activeConnections = new Map();
const store = makeInMemoryStore({
    logger: Pino().child({ level: 'silent', stream: 'store' }),
});

// Generate random session ID
function generateSessionId() {
    const prefix = 'levi';
    const randomChars = () => Math.random().toString(36).substring(2, 10);
    return `${prefix}${Math.floor(Math.random() * 1000000)}${randomChars()}`.toLowerCase();
}

// Create zip from session folder
function createZip(sessionId, res) {
    const sessionPath = path.join(sessionsDir, sessionId);
    const zipPath = path.join(sessionsDir, `${sessionId}.zip`);
    
    if (!fs.existsSync(sessionPath)) {
        return res.status(404).send('Session not found');
    }

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
        res.download(zipPath, `${sessionId}.zip`, (err) => {
            if (err) errorLog(`Download error: ${err}`);
            fs.unlinkSync(zipPath);
        });
    });
    
    archive.on('error', (err) => {
        errorLog(`Archive error: ${err}`);
        res.status(500).send('Error creating zip file');
    });
    
    archive.pipe(output);
    archive.directory(sessionPath, false);
    archive.finalize();
}

// Initialize WhatsApp connection
async function createWhatsAppConnection(sessionId, number) {
    const sessionPath = path.join(sessionsDir, sessionId);
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const sock = ToxxicTechConnect({
        logger: Pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        fireInitQueries: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: true,
        markOnlineOnConnect: true,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        getMessage: async () => ({}),
    });

    store.bind(sock.ev);
    
    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Track if message has been sent
    let messageSent = false;

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            errorLog(`Connection closed for ${sessionId}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect && !messageSent) {
                setTimeout(() => createWhatsAppConnection(sessionId, number), 2000);
            } else {
                activeConnections.delete(sessionId);
            }
        } else if (connection === 'open' && !messageSent) {
            log(`Successfully connected ${sessionId}`);
            
            // Mark message as sent to prevent duplicates
            messageSent = true;
            
            // Send confirmation message to the provided number
            try {
                const cleanNumber = number.replace(/[^\d]/g, '');
                const normalizedJid = jidNormalizedUser(cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`);
                
                if (normalizedJid) {
                    const beautifulMessage = {
                        text: `✨ *LEVI MD CONNECTION SUCCESSFUL* ✨\n\n` +
                              `✅ Your session is now ready to use!\n\n` +
                              `🔑 *Session ID:* ${sessionId.toUpperCase()}\n` +
                              `📅 *Created at:* ${new Date().toLocaleString()}\n\n` +
                              `_Deploy Guide https://github.com/ReirLair/Levi-Md_`,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true
                        }
                    };
                    
                    await sock.sendMessage(normalizedJid, beautifulMessage);
                    log(`Successfully sent confirmation to ${normalizedJid}`);
                }
            } catch (err) {
                errorLog(`Error sending confirmation: ${err}`);
            } finally {
                // Close connection after sending message
                log(`Closing connection for ${sessionId} after confirmation`);
                try {
                    sock.ws.close();
                } catch (e) {
                    errorLog(`Error closing connection: ${e}`);
                }
                activeConnections.delete(sessionId);
            }
        }
    });

    return sock;
}

// Pairing endpoint
app.post('/pair', async (req, res) => {
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Phone number required' });

    const sessionId = generateSessionId();
    
    try {
        const sock = await createWhatsAppConnection(sessionId, number);
        
        // Add delay to ensure connection is ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const cleanNumber = number.replace(/[^\d]/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        if (!code) throw new Error('Failed to get pairing code');
        
        // Format the code as XXXX-XXXX
        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
        
        // Store the active connection
        activeConnections.set(sessionId, { 
            sock, 
            number: cleanNumber,
            createdAt: Date.now() 
        });

        // Set timeout to clean up if connection stalls
        setTimeout(() => {
            if (activeConnections.has(sessionId)) {
                log(`Cleaning up stalled connection for ${sessionId}`);
                try {
                    activeConnections.get(sessionId)?.sock?.ws?.close();
                } catch (err) {
                    errorLog(`Cleanup error: ${err}`);
                }
                activeConnections.delete(sessionId);
            }
        }, 1200000); // 5 minutes timeout

        res.json({ 
            sessionId,
            code: formattedCode,
            message: 'Check your WhatsApp for connection confirmation'
        });
        
    } catch (error) {
        errorLog(`Pairing error: ${error.message}`);
        
        // Clean up if error occurs (but keep session folder)
        try {
            activeConnections.get(sessionId)?.sock?.ws?.close();
            activeConnections.delete(sessionId);
        } catch (err) {
            errorLog(`Cleanup error: ${err}`);
        }
        
        res.status(500).json({ error: error.message });
    }
});

// Download endpoint
app.get('/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    createZip(sessionId, res);
});

// Cleanup interval for stale connections (without deleting session folders)
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, conn] of activeConnections) {
        if (now - conn.createdAt > 3600000) { // 1 hour
            log(`Cleaning up stale connection for ${sessionId}`);
            try {
                conn.sock?.ws?.close();
            } catch (err) {
                errorLog(`Cleanup error: ${err}`);
            }
            activeConnections.delete(sessionId);
        }
    }
}, 60000); // Check every minute

// Start server
app.listen(PORT, () => {
    log(`Server running on http://localhost:${PORT}`);
});
