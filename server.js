const express = require('express');
const multer = require('multer');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Pair Code Generator Route
app.get('/get-pair-code', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: "Phone number jaroori hai." });

    // Number ko bilkul clean karein (no spaces, no +)
    phone = phone.replace(/[^0-9]/g, '');

    // Agar pehle se koi connection chal raha hai toh use close karein
    if (sock) {
        try { sock.logout(); } catch(e){}
    }

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

    // Jab tak credentials register na ho, thoda ruk kar code generate karein
    setTimeout(async () => {
        try {
            if (!sock.authState.creds.registered) {
                let code = await sock.requestPairingCode(phone);
                res.json({ code: code });
            } else {
                res.json({ message: "Device already connected!" });
            }
        } catch (err) {
            console.error("Pairing Error:", err);
            res.status(500).json({ error: "Code generate nahi ho paya. Refresh karke try karein." });
        }
    }, 4000); // 4 seconds ka wait taaki socket stable ho jaye
});

// 2. Bulk Message Sender
app.post('/send-bulk', upload.single('file'), async (req, res) => {
    const { data, messageTemplate, delayTime } = req.body;
    const file = req.file;

    if (!sock) return res.status(400).json({ error: "Pehle WhatsApp device link karein." });

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
