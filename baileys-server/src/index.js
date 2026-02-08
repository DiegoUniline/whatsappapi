const express = require('express');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Configuración
const API_SECRET = process.env.API_SECRET || 'dev-secret-key';
const EDGE_FUNCTION_URL = process.env.EDGE_FUNCTION_URL || 'https://ewiayikxrcvjvcjqqjvj.supabase.co/functions/v1/baileys-process-message';
const AUTH_FOLDER = './baileys_auth_info';

// Estado de la conexión
let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let connectedPhone = null;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Logger para Baileys
const logger = pino({ level: 'warn' });

// Middleware de autenticación
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Función para limpiar sesión
function clearSession() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      console.log('[BAILEYS] Session cleared');
    }
  } catch (err) {
    console.error('[BAILEYS] Error clearing session:', err);
  }
}

// Función para procesar mensaje entrante
async function processIncomingMessage(phone, message, pushName) {
  console.log(`[BAILEYS] Processing message from ${phone}: ${message}`);

  try {
    const response = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message, pushName, secret: API_SECRET }),
    });

    const data = await response.json();
    console.log('[BAILEYS] Edge function response:', data);

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

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log('[BAILEYS] Max reconnect attempts reached. Clearing session and restarting...');
    clearSession();
    reconnectAttempts = 0;
  }

  isConnecting = true;
  console.log('[BAILEYS] Starting connection... (attempt', reconnectAttempts + 1, ')');

  try {
    // Obtener la última versión de Baileys
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[BAILEYS] Using WA version ${version.join('.')}, isLatest: ${isLatest}`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    console.log('[BAILEYS] Auth state loaded');

    sock = makeWASocket({
      auth: state,
      logger,
      version,
      browser: ['Apunta Bot', 'Chrome', '120.0.0'],
      // NO usar printQRInTerminal (deprecado)
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      emitOwnEvents: false,
      fireInitQueries: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    // Manejar actualizaciones de conexión (IMPORTANTE: aquí se maneja el QR)
    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update;

      // QR disponible - generar imagen
      if (qr) {
        try {
          qrCode = await QRCode.toDataURL(qr);
          connectionStatus = 'waiting_qr';
          reconnectAttempts = 0; // Reset en QR exitoso
          console.log('[BAILEYS] ✅ QR code generated successfully!');
        } catch (err) {
          console.error('[BAILEYS] Error generating QR image:', err);
        }
      }

      // Conexión abierta
      if (connection === 'open') {
        connectionStatus = 'connected';
        qrCode = null;
        isConnecting = false;
        reconnectAttempts = 0;
        connectedPhone = sock.user?.id?.split(':')[0] || null;
        console.log('[BAILEYS] ✅ Connected successfully as:', connectedPhone);
      }

      // Conexión cerrada
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason[Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode)] || statusCode;
        
        console.log(`[BAILEYS] ❌ Connection closed. Status: ${statusCode} (${reason})`);
        
        connectionStatus = 'disconnected';
        qrCode = null;
        connectedPhone = null;
        isConnecting = false;

        // Determinar si reconectar
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        if (statusCode === 405 || statusCode === 401) {
          console.log('[BAILEYS] ⚠️ Auth error (405/401). Clearing session...');
          clearSession();
          reconnectAttempts = 0;
        }

        if (shouldReconnect) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          console.log(`[BAILEYS] Will reconnect in ${delay/1000}s...`);
          setTimeout(connectWhatsApp, delay);
        } else {
          console.log('[BAILEYS] Logged out. Manual reconnect required.');
        }
      }
    });

    // Guardar credenciales
    sock.ev.on('creds.update', saveCreds);

    // Manejar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        
        const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || 
                     '';
        const pushName = msg.pushName || '';

        if (text && phone && !phone.includes('@g.us')) {
          console.log(`[BAILEYS] 📩 Message from ${phone}: ${text}`);
          await processIncomingMessage(phone, text, pushName);
        }
      }
    });

  } catch (error) {
    console.error('[BAILEYS] Error in connectWhatsApp:', error);
    isConnecting = false;
    connectionStatus = 'disconnected';
    reconnectAttempts++;
    
    const delay = Math.min(5000 * reconnectAttempts, 30000);
    console.log(`[BAILEYS] Will retry in ${delay/1000}s...`);
    setTimeout(connectWhatsApp, delay);
  }
}

// ============ RUTAS ============

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    whatsapp: connectionStatus,
    node: process.version,
    reconnectAttempts,
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
    clearSession();
    connectionStatus = 'disconnected';
    qrCode = null;
    connectedPhone = null;
    isConnecting = false;
    reconnectAttempts = 0;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reconnect', authenticate, async (req, res) => {
  try {
    console.log('[BAILEYS] Manual reconnect requested');
    
    // Cerrar conexión actual
    if (sock) {
      sock.end();
      sock = null;
    }
    
    // Limpiar estado
    connectionStatus = 'disconnected';
    qrCode = null;
    isConnecting = false;
    reconnectAttempts = 0;
    
    // Limpiar sesión para forzar nuevo QR
    clearSession();
    
    // Reconectar
    setTimeout(connectWhatsApp, 1000);
    
    res.json({ success: true, message: 'Reconnecting with fresh session...' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ruta para limpiar sesión manualmente
app.post('/api/clear-session', authenticate, (req, res) => {
  try {
    if (sock) {
      sock.end();
      sock = null;
    }
    clearSession();
    connectionStatus = 'disconnected';
    qrCode = null;
    connectedPhone = null;
    isConnecting = false;
    reconnectAttempts = 0;
    res.json({ success: true, message: 'Session cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ INICIAR SERVIDOR ============

app.listen(PORT, () => {
  console.log(`[BAILEYS] 🚀 Server running on port ${PORT}`);
  console.log(`[BAILEYS] Node version: ${process.version}`);
  console.log(`[BAILEYS] Edge function URL: ${EDGE_FUNCTION_URL}`);
  connectWhatsApp();
});
