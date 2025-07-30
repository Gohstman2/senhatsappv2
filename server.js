const express = require('express');
const { Client, MessageMedia, Buttons, List } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Pour les médias en base64

const REMOTE_SESSION_URL = 'https://sendfiles.pythonanywhere.com/api';
const clients = {}; // number => { client, qr, session, webhook }

async function fetchSession(number) {
  try {
    const res = await fetch(`${REMOTE_SESSION_URL}/getSession?number=${number}`);
    if (!res.ok) throw new Error();
    return await res.json();
  } catch {
    return null;
  }
}

async function saveSession(number, session) {
  try {
    await fetch(`${REMOTE_SESSION_URL}/saveSession?number=${number}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    });
  } catch (err) {
    console.error('❌ Erreur sauvegarde session :', err.message);
  }
}

async function createClient(number, webhook = null) {
  if (clients[number]) return clients[number];

  const session = await fetchSession(number);
  const client = new Client({
    session,
    puppeteer: { headless: true, args: ['--no-sandbox'] },
  });

  clients[number] = { client, qr: null, session, webhook };

  client.on('qr', async (qr) => {
    clients[number].qr = await QRCode.toDataURL(qr);
  });

  client.on('authenticated', async (session) => {
    clients[number].qr = null;
    clients[number].session = session;
    await saveSession(number, session);
  });

  client.on('ready', () => {
    console.log(`✅ Client ${number} prêt`);
  });

  client.on('auth_failure', (msg) => {
    console.error(`❌ Auth échouée ${number}:`, msg);
  });

  client.on('disconnected', () => {
    console.warn(`⚠️ ${number} déconnecté`);
    delete clients[number];
  });

  client.on('message', async (msg) => {
    const webhook = clients[number]?.webhook;
    if (webhook) {
      try {
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            number,
            from: msg.from,
            body: msg.body,
            type: msg.type,
            timestamp: msg.timestamp,
            id: msg.id.id,
          }),
        });
      } catch (err) {
        console.error(`❌ Webhook ${number}:`, err.message);
      }
    }
  });

  client.initialize();
  return clients[number];
}

// === ROUTES ===

// Lancer un client
app.post('/startClient', async (req, res) => {
  const { number, webhook } = req.body;
  if (!number) return res.status(400).json({ error: 'Numéro requis' });

  try {
    await createClient(number, webhook);
    res.json({ status: 'started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// QR code
app.get('/qr/:number', async (req, res) => {
  const number = req.params.number;
  const clientData = clients[number];
  if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });

  res.json(clientData.qr ? { status: 'scan', qr: clientData.qr } : { status: 'authenticated' });
});

// Statut
app.get('/status/:number', (req, res) => {
  const client = clients[req.params.number];
  if (!client) return res.json({ status: 'not_initialized' });
  res.json({ status: client.qr ? 'pending' : 'authenticated' });
});

// Envoyer message texte
app.post('/sendMessage', async (req, res) => {
  const { number, to, message } = req.body;
  const clientData = clients[number];
  if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });

  try {
    await clientData.client.sendMessage(to + '@c.us', message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envoyer média (base64)
app.post('/sendMedia', async (req, res) => {
  const { number, to, mimetype, filename, mediaBase64, caption } = req.body;
  const clientData = clients[number];
  if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });

  try {
    const media = new MessageMedia(mimetype, mediaBase64, filename);
    await clientData.client.sendMessage(to + '@c.us', media, { caption: caption || '' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Répondre à un message
app.post('/replyMessage', async (req, res) => {
  const { number, to, message, quotedId } = req.body;
  const clientData = clients[number];
  if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });

  try {
    await clientData.client.sendMessage(to + '@c.us', message, { quotedMessageId: quotedId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envoyer boutons
app.post('/sendButtons', async (req, res) => {
  const { number, to, text, title, buttons } = req.body;
  const clientData = clients[number];
  if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });

  try {
    const buttonObj = new Buttons(text, buttons, title, '');
    await clientData.client.sendMessage(to + '@c.us', buttonObj);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envoyer liste
app.post('/sendList', async (req, res) => {
  const { number, to, title, body, buttonText, sections } = req.body;
  const clientData = clients[number];
  if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });

  try {
    const list = new List(body, sections, title, buttonText, '');
    await clientData.client.sendMessage(to + '@c.us', list);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Typing, vu, présence
app.post('/presence', async (req, res) => {
  const { number, to, action } = req.body;
  const clientData = clients[number];
  if (!clientData) return res.status(404).json({ error: 'Client non trouvé' });

  const chatId = to + '@c.us';
  try {
    switch (action) {
      case 'typing':
        await clientData.client.sendTyping(chatId);
        break;
      case 'seen':
        await clientData.client.sendSeen(chatId);
        break;
      case 'available':
        await clientData.client.sendPresenceAvailable();
        break;
      default:
        return res.status(400).json({ error: 'Action inconnue' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lancer le serveur
app.listen(port, () => {
  console.log(`🚀 Serveur WhatsApp complet lancé sur http://localhost:${port}`);
});
