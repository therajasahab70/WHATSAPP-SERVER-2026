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
let isCampaignRunning = false;
let isInitializing = false; // Multiple QR code bug ko rokne ke liye lock

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function initWhatsApp() {
    // Agar process pehle se chal rahi hai toh dobara start na kare (Flicker issue fix)
    if (isInitializing) return; 
    isInitializing = true;
    
    console.log("Starting WhatsApp Initialization...");
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "123.0.0.0"],
        printQRInTerminal: false,
        syncFullHistory: false // Connect hone ki speed badhane ke liye
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("🎯 QR Code updated.");
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
            isInitializing = false; // Lock khol dein

            // Sirf tabhi session delete hoga jab aap phone se "Log out" karenge
            if (statusCode === DisconnectReason.loggedOut) {
                console.log("User logged out from phone. Deleting session...");
                try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e) {}
            }
            
            // Automatic reconnect karein
            setTimeout(() => { initWhatsApp(); }, 3000);

        } else if (connection === 'open') {
            console.log("✅ WhatsApp successfully connected!");
            connectionStatus = "Connected";
            latestQr = null; // Screen se QR hata dega
            isInitializing = false;
        }
    });
}

// Start WhatsApp
initWhatsApp();

// Frontend API: QR code check (Bina naya session banaye)
app.get('/get-qr', (req, res) => {
    res.json({
        status: connectionStatus,
        qr: latestQr
    });
});

// Bulk Message & Infinite Loop Logic
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

    // Background Infinite Loop
    (async () => {
        while (isCampaignRunning) {
            console.log("🔄 Starting message campaign round...");
            
            for (let contact of contactList) {
                // Agar phone disconnect ho gaya toh loop ruk jayega
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
                    await delay(waitSeconds); 
                } catch (error) {
                    console.error(`Failed to send to ${contact.name}:`, error);
                }
            }
            
            // Ek round pura hone par 5 second ka aaram, phir se shuru
            if (isCampaignRunning) {
                console.log("Round complete! 5 second baad dobara start hoga...");
                await delay(5000); 
            }
        }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
