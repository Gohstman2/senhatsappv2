// === DEPENDANCES ===
require('dotenv').config();
const express = require('express');
const { Client, Buttons, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const { Pool } = require('pg');

// === CONFIG EXPRESS ===
const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());

// === VARIABLES ===
let qrCodeBase64 = null;
let authenticated = false;
let client;

// === CONFIG POSTGRES ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false
});

// === FONCTIONS BASE DE DONNÉES ===
async function fetchSessionFromDB() {
  try {
    const res = await pool.query('SELECT session_data FROM whatsapp_session ORDER BY id DESC LIMIT 1');
    if (res.rows.length > 0) {
      console.log('📦 Session récupérée depuis PostgreSQL');
      return JSON.parse(res.rows[0].session_data);
    }
    console.log('⚠️ Aucune session trouvée en base');
    return null;
  } catch (err) {
    console.error('❌ Erreur récupération session DB', err);
    return null;
  }
}

async function saveSessionToDB(session) {
  try {
    await pool.query('INSERT INTO whatsapp_session (session_data) VALUES ($1)', [JSON.stringify(session)]);
    console.log('☁️ Session sauvegardée dans PostgreSQL');
  } catch (err) {
    console.error('❌ Erreur sauvegarde session DB', err);
  }
}

// === INITIALISATION CLIENT WHATSAPP ===
async function initClient() {
  const session = await fetchSessionFromDB();

  client = new Client({
    session,
    puppeteer: { headless: true, args: ['--no-sandbox'] },
  });

  client.on('qr', async (qr) => {
    console.log('📲 QR généré');
    qrCodeBase64 = await QRCode.toDataURL(qr);
    authenticated = false;
  });

  client.on('authenticated', async (session) => {
    console.log('✅ Authentifié');
    authenticated = true;
    qrCodeBase64 = null;
    await saveSessionToDB(session);
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Authentification échouée :', msg);
    authenticated = false;
  });

  client.on('ready', () => {
    console.log('🤖 Client prêt');
    authenticated = true;
    qrCodeBase64 = null;
  });

  // === ECOUTE DES MESSAGES ENTRANTS ===
  client.on('message', async (msg) => {
    console.log(`📩 Nouveau message de ${msg.from}: ${msg.body || '[média]'}`);

    const payload = {
      from: msg.from,
      body: msg.body || '',
      timestamp: msg.timestamp,
      type: msg.type,
      isGroupMsg: msg.from.includes('@g.us'),
    };

    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          payload.media = {
            mimetype: media.mimetype,
            data: media.data,
            filename: media.filename || `media.${media.mimetype.split('/')[1] || 'bin'}`
          };
        }
      } catch (err) {
        console.error('❌ Erreur téléchargement média :', err.message);
      }
    }

    // Ici, tu peux envoyer `payload` à ton webhook si besoin
  });

  client.initialize();
}

initClient();

// === ROUTES API ===
app.get('/auth', (req, res) => {
  if (authenticated) {
    return res.json({ status: 'authenticated' });
  } else if (qrCodeBase64) {
    return res.json({ status: 'scan me', qr: qrCodeBase64 });
  } else {
    return res.json({ status: 'waiting for qr...' });
  }
});

app.get('/checkAuth', (req, res) => {
  res.json({ status: authenticated ? 'authenticated' : 'not authenticated' });
});

app.post('/sendMessage', async (req, res) => {
  const { number, message } = req.body;
  if (!authenticated) return res.status(401).json({ error: 'Client non authentifié' });
  if (!number || !message) return res.status(400).json({ error: 'Numéro et message requis' });

  const formatted = number.replace('+', '') + '@c.us';
  try {
    await client.sendMessage(formatted, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sendMedia', async (req, res) => {
  const { number, media } = req.body;
  if (!authenticated) return res.status(401).json({ error: 'Client non authentifié' });
  if (!number || !media?.data || !media?.mimetype) {
    return res.status(400).json({ error: 'Champs requis manquants' });
  }

  const formatted = number.replace('+', '') + '@c.us';
  try {
    const mediaMsg = new MessageMedia(media.mimetype, media.data, media.filename || 'fichier');
    await client.sendMessage(formatted, mediaMsg);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sendMediaV2', async (req, res) => {
  const { number, media, caption = '' } = req.body;
  if (!authenticated) return res.status(401).json({ error: 'Client non authentifié' });
  if (!number || !media?.data || !media?.mimetype) {
    return res.status(400).json({ error: 'Champs requis : number, media.data, media.mimetype' });
  }

  const formatted = number.replace('+', '') + '@c.us';
  try {
    const mediaMsg = new MessageMedia(media.mimetype, media.data, media.filename || 'fichier');
    await client.sendMessage(formatted, mediaMsg, { caption: caption || undefined });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sendButtons', async (req, res) => {
  const { number, text, buttons, title = '', footer = '' } = req.body;
  if (!authenticated) return res.status(401).json({ error: 'Client non authentifié' });
  if (!number || !text || !Array.isArray(buttons) || buttons.length === 0) {
    return res.status(400).json({ error: 'Champs requis : number, text, buttons[]' });
  }

  const formattedNumber = number.replace('+', '').replace(/\s+/g, '') + '@c.us';
  try {
    const parsedButtons = buttons.map(b => typeof b === 'string' ? { body: b } : b);
    const buttonMsg = new Buttons(text, parsedButtons, title, footer);
    await client.sendMessage(formattedNumber, buttonMsg);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === DEMARRAGE SERVEUR ===
app.listen(port, () => {
  console.log(`🚀 Serveur WhatsApp en ligne sur http://localhost:${port}`);
});
