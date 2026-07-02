const express = require('express');
const multer = require('multer');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
let isCampaignRunning = false; // Campaign status track karne ke liye

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function initWhatsApp() {
    console.log("Starting WhatsApp Initialization...");
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "123.0.0.0"],
        printQRInTerminal: false,
        mobile: false,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("🎯 Live QR Code Generated!");
            try {
                latestQr = await QRCode.toDataURL(qr);
                connectionStatus = "QR Ready";
            } catch (err) {
                console.error("QR Error:", err);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed (Status: ${statusCode})`);
            
            connectionStatus = "Disconnected";
            latestQr = null;
            isCampaignRunning = false;

            // 🔥 FIX: Agar logged out ya bad session hai, toh files delete karke fresh QR laayein
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 405) {
                console.log("Session cleared. Generating fresh QR...");
                try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e) {}
            }
            
            setTimeout(() => { initWhatsApp(); }, 3000); // Auto restart socket
        } else if (connection === 'open') {
            console.log("✅ WhatsApp successfully connected!");
            connectionStatus = "Connected";
            latestQr = null; // Connect hone ke baad QR clean
        }
    });
}

// Start WhatsApp on App Start
initWhatsApp();

// Frontend status polling route
app.get('/get-qr', (req, res) => {
    // 🔥 FIX: Agar user page refresh kare aur status connected na ho, toh purana session flush karke naya QR trigger ho
    if (connectionStatus === "Disconnected" || (!latestQr && connectionStatus !== "Connected")) {
        try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e) {}
        connectionStatus = "Initializing...";
        initWhatsApp();
    }
    res.json({
        status: connectionStatus,
        qr: latestQr
    });
});

// Bulk Message Sender with Infinite Repeat Loop
app.post('/send-bulk', upload.single('file'), async (req, res) => {
    const { data, messageTemplate, delayTime } = req.body;
    const file = req.file;

    if (connectionStatus !== "Connected") {
        return res.status(400).json({ error: "Pehle WhatsApp QR Code scan karein." });
    }

    const contactList = JSON.parse(data); 
    const waitSeconds = parseInt(delayTime) * 1000;

    res.json({ status: "Campaign shuru ho gaya hai! Yeh loop me lagatar chalta rahega." });
    
    isCampaignRunning = true;

    // 🔥 LOOP SYSTEM: Infinite loop jab tak aap server stop na karein
    while (isCampaignRunning) {
        console.log("🔄 Starting message campaign loop...");
        
        for (let contact of contactList) {
            // Agar beech me WhatsApp disconnect ho jaye toh loop break ho jaye
            if (connectionStatus !== "Connected") {
                console.log("WhatsApp disconnected. Stopping loop.");
                isCampaignRunning = false;
                break;
            }

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

                console.log(`[Loop Active] Message sent to ${contact.name}`);
                await delay(waitSeconds); // User defined delay
            } catch (error) {
                console.error(`Failed to send to ${contact.name}:`, error);
            }
        }
        
        // Ek round khatam hone par 5 second ka pause lekar agla round shuru karega
        await delay(5000); 
    }

    if (file) {
        try { fs.unlinkSync(file.path); } catch(e) {}
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
