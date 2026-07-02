const express = require('express');
const multer = require('multer');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const app = express();
const upload = multer({ dest: 'uploads/' });
const logEmitter = new EventEmitter();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;
let latestQr = null;
let connectionStatus = "Initializing...";
let isCampaignRunning = false;
let isInitializing = false;

// 🔥 Live screen par message bhejne ka function
function sendLog(msg) {
    console.log(msg);
    logEmitter.emit('log', msg);
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 🔥 Live Screen route
app.get('/live-logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const listener = (msg) => { res.write(`data: ${msg}\n\n`); };
    logEmitter.on('log', listener);
    req.on('close', () => { logEmitter.removeListener('log', listener); });
});

async function initWhatsApp() {
    if (isInitializing) return; 
    isInitializing = true;
    
    sendLog("⚙️ Starting WhatsApp Initialization...");
    
    // Auth info folder jisme session save hota hai
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["GadarServer", "Chrome", "1.0.0"], // Browser name fixed to avoid block
        printQRInTerminal: false,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            sendLog("🎯 QR Code Generate ho gaya hai. Kripya Scan karein.");
            try {
                latestQr = await QRCode.toDataURL(qr);
                connectionStatus = "QR Ready";
            } catch (err) { sendLog("QR Error: " + err); }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            sendLog(`⚠️ Connection closed (Code: ${statusCode}). Reconnecting...`);
            
            connectionStatus = "Disconnected";
            isInitializing = false;

            // 🔥 FIX: Sirf tabhi session delete hoga jab aap phone se khud "Log out" karenge
            if (statusCode === DisconnectReason.loggedOut) {
                sendLog("❌ User ne phone se log out kiya hai. Naya QR code laa rahe hain...");
                latestQr = null;
                try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e) {}
            }
            
            // Connection close hone par automatic reconnect kare bina naya QR banaye (agar logged out nahi hai)
            setTimeout(() => { initWhatsApp(); }, 4000);

        } else if (connection === 'open') {
            sendLog("✅ WhatsApp Link Ho Gaya Hai! Ready for messages.");
            connectionStatus = "Connected";
            latestQr = null; // Connect hote hi screen se QR hata do
            isInitializing = false;
        }
    });
}

initWhatsApp();

app.get('/get-qr', (req, res) => {
    res.json({ status: connectionStatus, qr: latestQr });
});

app.post('/send-bulk', upload.single('file'), async (req, res) => {
    const { data, messageTemplate, delayTime } = req.body;
    const file = req.file;

    if (connectionStatus !== "Connected") {
        return res.status(400).json({ error: "Pehle WhatsApp QR Code scan karein." });
    }

    // TXT File read logic
    let extraTextFromFile = "";
    if (file) {
        try {
            extraTextFromFile = fs.readFileSync(file.path, 'utf-8');
            sendLog("📄 TXT File ka data padh liya gaya hai.");
            fs.unlinkSync(file.path); 
        } catch (err) {
            sendLog("❌ File ko padhne me error aayi.");
        }
    }

    const contactList = JSON.parse(data); 
    const waitSeconds = parseInt(delayTime) * 1000;

    res.json({ status: "Campaign Start! Niche Live Screen par dekhein." });
    isCampaignRunning = true;

    // 🔥 Infinite Loop System
    (async () => {
        let roundNumber = 1;
        while (isCampaignRunning) {
            sendLog(`\n🔄 --- ROUND ${roundNumber} SHURU ---`);
            
            for (let contact of contactList) {
                if (connectionStatus !== "Connected") {
                    sendLog("❌ WhatsApp Disconnected. Loop rok diya gaya hai.");
                    isCampaignRunning = false;
                    break;
                }

                try {
                    let cleanReceiverPhone = contact.phone.replace(/[^0-9]/g, '');
                    
                    // 🔥 FIX 1: Agar number 10 digit ka hai, toh India ka code '91' jodein
                    if (cleanReceiverPhone.length === 10) {
                        cleanReceiverPhone = "91" + cleanReceiverPhone;
                    }

                    const formattedPhone = `${cleanReceiverPhone}@s.whatsapp.net`;
                    
                    let personalizedMessage = "";
                    if (messageTemplate.trim()) personalizedMessage += `${contact.name}, ${messageTemplate}\n\n`;
                    if (extraTextFromFile.trim()) personalizedMessage += extraTextFromFile;

                    // Message bhejna
                    await sock.sendMessage(formattedPhone, { text: personalizedMessage });
                    
                    sendLog(`📩 Message bheja gaya: ${contact.name} (${cleanReceiverPhone}) ko.`);
                    await delay(waitSeconds); 
                } catch (error) {
                    // 🔥 FIX 2: Asli error log karna taaki asli wajah pata chale
                    sendLog(`❌ ERROR: ${contact.name} ko fail. Detail: ${error.message || "Unknown error"}`);
                }
            }
            
            if (isCampaignRunning) {
                sendLog(`✅ ROUND ${roundNumber} PURA HUA! 5 Second baad dubara shuru hoga...`);
                roundNumber++;
                await delay(5000); 
            }
        }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
