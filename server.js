const express = require('express');
const multer = require('multer');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;
let latestQr = null;
let connectionStatus = "Initializing...";

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function initWhatsApp() {
    console.log("Starting WhatsApp Initialization...");
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "123.0.0.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("New QR Code Generated!");
            try {
                latestQr = await QRCode.toDataURL(qr);
                connectionStatus = "QR Ready";
            } catch (err) {
                console.error("QR Conversion Error:", err);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("Connection closed due to ", lastDisconnect?.error, ", reconnecting: ", shouldReconnect);
            connectionStatus = "Disconnected";
            latestQr = null;
            if (shouldReconnect) {
                initWhatsApp();
            }
        } else if (connection === 'open') {
            console.log("WhatsApp Successfully Connected!");
            connectionStatus = "Connected";
            latestQr = null;
        }
    });
}

// Initialize on start
initWhatsApp();

app.get('/get-qr', (req, res) => {
    res.json({
        status: connectionStatus,
        qr: latestQr
    });
});

app.post('/send-bulk', upload.single('file'), async (req, res) => {
    const { data, messageTemplate, delayTime } = req.body;
    const file = req.file;

    if (connectionStatus !== "Connected") {
        return res.status(400).json({ error: "Pehle WhatsApp QR Code scan karein." });
    }

    const contactList = JSON.parse(data); 
    const waitSeconds = parseInt(delayTime) * 1000;

    res.json({ status: "Campaign shuru ho gaya hai!" });

    for (let contact of contactList) {
        try {
            let cleanReceiverPhone = contact.phone.replace(/[^0-9]/g, '');
            const formattedPhone = `${cleanReceiverPhone}@s.whatsapp.net`;
            const personalizedMessage = `${contact.name}, ${messageTemplate}`;

            if (file) {
                await sock.sendMessage(formattedPhone, {
                    document: { url: file.path },
                    fileName: file.originalname,
                    caption: personalizedMessage
                });
            } else {
                await sock.sendMessage(formattedPhone, { text: personalizedMessage });
            }
            await delay(waitSeconds);
        } catch (error) {
            console.error(`Failed to send to ${contact.name}:`, error);
        }
    }

    if (file) {
        try { fs.unlinkSync(file.path); } catch(e) {}
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
