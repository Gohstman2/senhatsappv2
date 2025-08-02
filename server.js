const express = require('express');
const { Client } = require('whatsapp-web.js');
const { Buttons } = require('whatsapp-web.js'); 
const QRCode = require('qrcode');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

let qrCodeBase64 = null;
let authenticated = false;
let client;

// 🌍 Ton serveur Python distant
const REMOTE_SESSION_URL = 'https://sendfiles.pythonanywhere.com/api';
// 🔗 URL de ton webhook
const WEBHOOK_URL = 'https://webhookwhastsappv2-1.onrender.com/whatsapp';

// 📥 Récupérer session distante
async function fetchSessionFromRemote() {
  try {
    const res = await fetch(`${REMOTE_SESSION_URL}/getSession`);
    if (!res.ok) throw new Error('Session non trouvée');
    const session = await res.json();
    return session;
  } catch (error) {
    console.warn('⚠️ Aucune session trouvée sur le serveur distant');
    return null;
  }
}

// 🚀 Démarrer le client WhatsApp
async function initClient() {
  const session = await fetchSessionFromRemote();

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

    try {
      await fetch(`${REMOTE_SESSION_URL}/saveSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
      });
      console.log('☁️ Session sauvegardée sur le serveur distant');
    } catch (err) {
      console.error('❌ Erreur lors de la sauvegarde distante', err.message);
    }
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
client.on('message', async (msg) => {
  console.log(`📩 Nouveau message de ${msg.from}: ${msg.body || '[média]'}`);

  const payload = {
    from: msg.from,
    body: msg.body || '', // S'il n'y a pas de texte
    timestamp: msg.timestamp,
    type: msg.type,
    isGroupMsg: msg.from.includes('@g.us'),
  };

  // Si le message contient un média (image, audio, vidéo, etc.)
  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      if (media) {
        payload.media = {
          mimetype: media.mimetype,
          data: media.data, // base64
          filename: media.filename || `media.${media.mimetype.split('/')[1] || 'bin'}`
        };
      }
    } catch (err) {
      console.error('❌ Erreur lors du téléchargement du média :', err.message);
    }
  }

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log('✅ Message (avec ou sans média) relayé au webhook');
  } catch (err) {
    console.error('❌ Erreur en envoyant au webhook :', err.message);
  }
});

  client.initialize();
  
 
}

initClient();

// === ROUTES ===

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

  if (!authenticated) {
    return res.status(401).json({ error: 'Client non authentifié' });
  }

  if (!number || !message) {
    return res.status(400).json({ error: 'Numéro et message requis' });
  }

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

  if (!authenticated) {
    return res.status(401).json({ error: 'Client non authentifié' });
  }

  if (!number || !media || !media.data || !media.mimetype) {
    return res.status(400).json({ error: 'Champs requis manquants' });
  }

  const formatted = number.replace('+', '') + '@c.us';

  try {
    const { MessageMedia } = require('whatsapp-web.js');
    const mediaMsg = new MessageMedia(media.mimetype, media.data, media.filename || 'fichier');

    await client.sendMessage(formatted, mediaMsg);
    res.json({ success: true, message: 'Média envoyé avec succès' });
  } catch (err) {
    console.error('❌ Erreur lors de l’envoi du média :', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.post('/sendButtons', async (req, res) => {
  const { number, text, buttons, title = '', footer = '' } = req.body;

  if (!authenticated) {
    return res.status(401).json({ error: 'Client non authentifié' });
  }

  if (!number || !text || !Array.isArray(buttons) || buttons.length === 0) {
    return res.status(400).json({ error: 'Champs requis : number, text, buttons[]' });
  }

  const formattedNumber = number.replace('+', '') + '@c.us';

  try {
    const buttonMsg = new Buttons(text, buttons, title, footer);
    await client.sendMessage(formattedNumber, buttonMsg);
    res.json({ success: true, message: 'Boutons envoyés' });
  } catch (err) {
    console.error('❌ Erreur en envoyant les boutons :', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.listen(port, () => {
  console.log(`🚀 Serveur WhatsApp en ligne sur http://localhost:${port}`);
});
