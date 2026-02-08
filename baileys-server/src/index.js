const express = require('express');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Configuración - SOLO necesitas API_SECRET y EDGE_FUNCTION_URL
const API_SECRET = process.env.API_SECRET || 'dev-secret-key';
const EDGE_FUNCTION_URL = process.env.EDGE_FUNCTION_URL || 'https://ewiayikxrcvjvcjqqjvj.supabase.co/functions/v1/baileys-process-message';

// Estado de la conexión
let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let connectedPhone = null;
let isConnecting = false;

// Logger para Baileys (level info para ver más detalles)
const logger = pino({ level: 'warn' });

// Middleware de autenticación simple
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Función para procesar mensaje entrante via Edge Function
async function processIncomingMessage(phone, message, pushName) {
  console.log(`[BAILEYS] Processing message from ${phone}: ${message}`);

  try {
    const response = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        phone, 
        message, 
        pushName,
        secret: API_SECRET 
      }),
    });

    const data = await response.json();
    console.log('[BAILEYS] Edge function response:', data);

    // Si hay respuesta, enviarla al usuario
    if (data.success && data.reply) {
      await sendMessage(phone, data.reply);
    }

    return data;
  } catch (error) {
    console.error('[BAILEYS] Error calling edge function:', error);
    return { success: false, error: error.message };
  }
}

// Función para enviar mensaje
async function sendMessage(phone, text) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp not connected');
  }

  const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
  
  await sock.sendMessage(jid, { text });
  console.log(`[BAILEYS] Message sent to ${jid}`);
}

// Conectar a WhatsApp
async function connectWhatsApp() {
  if (isConnecting) {
    console.log('[BAILEYS] Already connecting, skipping...');
    return;
  }
  
  isConnecting = true;
  console.log('[BAILEYS] Starting connection...');
  
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth_info');
    console.log('[BAILEYS] Auth state loaded');

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true, // También imprimir en terminal
      logger,
      browser: ['Apunta', 'Chrome', '120.0.0'],
    });

    // Manejar actualizaciones de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      console.log('[BAILEYS] Connection update:', { connection, hasQR: !!qr, lastDisconnect: lastDisconnect?.error?.message });

      if (qr) {
        try {
          qrCode = await QRCode.toDataURL(qr);
          connectionStatus = 'waiting_qr';
          console.log('[BAILEYS] QR code generated successfully');
        } catch (err) {
          console.error('[BAILEYS] Error generating QR:', err);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('[BAILEYS] Connection closed. Status code:', statusCode, 'Reconnecting:', shouldReconnect);
        
        connectionStatus = 'disconnected';
        qrCode = null;
        connectedPhone = null;
        isConnecting = false;
        
        if (shouldReconnect) {
          console.log('[BAILEYS] Will reconnect in 5 seconds...');
          setTimeout(connectWhatsApp, 5000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        qrCode = null;
        isConnecting = false;
        connectedPhone = sock.user?.id?.split(':')[0] || null;
        console.log('[BAILEYS] Connected successfully as:', connectedPhone);
      }
    });

    // Guardar credenciales
    sock.ev.on('creds.update', saveCreds);

    // Manejar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue; // Ignorar mensajes propios
        
        const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || 
                     '';
        const pushName = msg.pushName || '';

        if (text && phone && !phone.includes('@g.us')) { // Ignorar grupos
          console.log(`[BAILEYS] Message from ${phone}: ${text}`);
          await processIncomingMessage(phone, text, pushName);
        }
      }
    });
  } catch (error) {
    console.error('[BAILEYS] Error in connectWhatsApp:', error);
    isConnecting = false;
    connectionStatus = 'disconnected';
    // Retry after error
    setTimeout(connectWhatsApp, 10000);
  }
}

// Rutas
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    whatsapp: connectionStatus,
    node: process.version
  });
});

app.get('/api/status', authenticate, (req, res) => {
  res.json({
    status: connectionStatus,
    phone: connectedPhone,
    hasQR: !!qrCode,
  });
});

app.get('/api/qr', authenticate, (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ status: 'already_connected', phone: connectedPhone });
  }
  
  if (!qrCode) {
    return res.json({ status: 'waiting', message: 'QR not ready yet, try again in a few seconds' });
  }

  res.json({ status: 'qr_ready', qr: qrCode });
});

app.post('/api/send', authenticate, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message required' });
  }

  try {
    await sendMessage(phone, message);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/logout', authenticate, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    connectionStatus = 'disconnected';
    qrCode = null;
    connectedPhone = null;
    isConnecting = false;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reconnect', authenticate, async (req, res) => {
  try {
    if (sock) {
      sock.end();
    }
    connectionStatus = 'disconnected';
    qrCode = null;
    isConnecting = false;
    setTimeout(connectWhatsApp, 1000);
    res.json({ success: true, message: 'Reconnecting...' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`[BAILEYS] Server running on port ${PORT}`);
  console.log(`[BAILEYS] Node version: ${process.version}`);
  console.log(`[BAILEYS] Edge function URL: ${EDGE_FUNCTION_URL}`);
  connectWhatsApp();
});
