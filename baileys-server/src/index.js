const express = require('express');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
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
const CREDENTIALS_URL = process.env.CREDENTIALS_URL || 'https://ewiayikxrcvjvcjqqjvj.supabase.co/functions/v1/baileys-credentials';
const AUTH_FOLDER = './baileys_auth_info';
const SERVER_NAME = process.env.SERVER_NAME || 'default';

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

// ============ PERSISTENCIA EN SUPABASE ============

// Guardar credenciales en Supabase
async function saveCredentialsToSupabase(authState) {
  try {
    console.log('[BAILEYS] Saving credentials to Supabase...');
    
    const response = await fetch(CREDENTIALS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'save',
        server_name: SERVER_NAME,
        auth_state: authState,
        connected_phone: connectedPhone,
      }),
    });

    const data = await response.json();
    
    if (data.success) {
      console.log('[BAILEYS] ✅ Credentials saved to Supabase');
    } else {
      console.error('[BAILEYS] ❌ Failed to save credentials:', data.error);
    }
    
    return data.success;
  } catch (error) {
    console.error('[BAILEYS] ❌ Error saving to Supabase:', error.message);
    return false;
  }
}

// Cargar credenciales desde Supabase
async function loadCredentialsFromSupabase() {
  try {
    console.log('[BAILEYS] Loading credentials from Supabase...');
    
    const response = await fetch(CREDENTIALS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'get',
        server_name: SERVER_NAME,
      }),
    });

    const data = await response.json();
    
    if (data.success && data.exists) {
      console.log('[BAILEYS] ✅ Credentials loaded from Supabase, phone:', data.connected_phone);
      return data.auth_state;
    }
    
    console.log('[BAILEYS] No credentials in Supabase, starting fresh');
    return null;
  } catch (error) {
    console.error('[BAILEYS] ❌ Error loading from Supabase:', error.message);
    return null;
  }
}

// Eliminar credenciales de Supabase
async function deleteCredentialsFromSupabase() {
  try {
    console.log('[BAILEYS] Deleting credentials from Supabase...');
    
    const response = await fetch(CREDENTIALS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'delete',
        server_name: SERVER_NAME,
      }),
    });

    const data = await response.json();
    console.log('[BAILEYS] Credentials deleted:', data.success);
    return data.success;
  } catch (error) {
    console.error('[BAILEYS] ❌ Error deleting from Supabase:', error.message);
    return false;
  }
}

// Auth state híbrido: usa archivos locales + sincroniza con Supabase
async function useHybridAuthState() {
  // Primero intentar cargar desde Supabase
  const supabaseState = await loadCredentialsFromSupabase();
  
  // Si hay estado en Supabase y no hay local, restaurar
  if (supabaseState && !fs.existsSync(AUTH_FOLDER)) {
    console.log('[BAILEYS] Restoring credentials from Supabase to local...');
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    
    // Escribir cada archivo del estado
    for (const [key, value] of Object.entries(supabaseState)) {
      const filePath = path.join(AUTH_FOLDER, `${key}.json`);
      fs.writeFileSync(filePath, JSON.stringify(value, BufferJSON.replacer));
    }
    console.log('[BAILEYS] ✅ Credentials restored from Supabase');
  }
  
  // Usar el auth state de archivos (ahora con datos de Supabase si aplica)
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  
  // Wrapper para guardar también en Supabase
  const saveCredsWithSync = async () => {
    await saveCreds();
    
    // Leer todos los archivos y sincronizar con Supabase
    try {
      const files = fs.readdirSync(AUTH_FOLDER);
      const authState = {};
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const key = file.replace('.json', '');
          const content = fs.readFileSync(path.join(AUTH_FOLDER, file), 'utf-8');
          authState[key] = JSON.parse(content, BufferJSON.reviver);
        }
      }
      
      // Guardar en Supabase de forma async (no bloquear)
      saveCredentialsToSupabase(authState).catch(console.error);
    } catch (err) {
      console.error('[BAILEYS] Error syncing to Supabase:', err.message);
    }
  };
  
  return { state, saveCreds: saveCredsWithSync };
}

// Función para limpiar sesión (local + Supabase)
async function clearSession() {
  try {
    // Limpiar local
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      console.log('[BAILEYS] Local session cleared');
    }
    
    // Limpiar Supabase
    await deleteCredentialsFromSupabase();
  } catch (err) {
    console.error('[BAILEYS] Error clearing session:', err);
  }
}

// ============ PROCESAMIENTO DE MENSAJES ============

async function processIncomingMessage(phone, message, pushName, mediaType = null, mediaUrl = null) {
  console.log(`[BAILEYS] Processing message from ${phone}: ${message} (mediaType: ${mediaType})`);
  console.log(`[BAILEYS] Connected as: ${connectedPhone}`);

  try {
    const response = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        phone, 
        message, 
        pushName, 
        secret: API_SECRET,
        mediaType,
        mediaUrl,
        toPhone: connectedPhone // El número al que llegó el mensaje
      }),
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

// ============ CONEXIÓN WHATSAPP ============

async function connectWhatsApp() {
  if (isConnecting) {
    console.log('[BAILEYS] Already connecting, skipping...');
    return;
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log('[BAILEYS] Max reconnect attempts reached. Clearing session and restarting...');
    await clearSession();
    reconnectAttempts = 0;
  }

  isConnecting = true;
  console.log('[BAILEYS] Starting connection... (attempt', reconnectAttempts + 1, ')');

  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[BAILEYS] Using WA version ${version.join('.')}, isLatest: ${isLatest}`);

    // Usar auth state híbrido (local + Supabase)
    const { state, saveCreds } = await useHybridAuthState();
    console.log('[BAILEYS] Auth state loaded (hybrid mode)');

    sock = makeWASocket({
      auth: state,
      logger,
      version,
      browser: ['Apunta Bot', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      emitOwnEvents: false,
      fireInitQueries: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    // Manejar actualizaciones de conexión
    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        try {
          qrCode = await QRCode.toDataURL(qr);
          connectionStatus = 'waiting_qr';
          reconnectAttempts = 0;
          console.log('[BAILEYS] ✅ QR code generated successfully!');
        } catch (err) {
          console.error('[BAILEYS] Error generating QR image:', err);
        }
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        qrCode = null;
        isConnecting = false;
        reconnectAttempts = 0;
        connectedPhone = sock.user?.id?.split(':')[0] || null;
        console.log('[BAILEYS] ✅ Connected successfully as:', connectedPhone);
        
        // Sincronizar credenciales a Supabase después de conectar
        console.log('[BAILEYS] Syncing credentials to Supabase after connection...');
        setTimeout(() => {
          saveCreds().catch(console.error);
        }, 2000);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason[Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode)] || statusCode;
        
        console.log(`[BAILEYS] ❌ Connection closed. Status: ${statusCode} (${reason})`);
        
        connectionStatus = 'disconnected';
        qrCode = null;
        connectedPhone = null;
        isConnecting = false;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        if (statusCode === 405 || statusCode === 401) {
          console.log('[BAILEYS] ⚠️ Auth error (405/401). Clearing session...');
          await clearSession();
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

    // Guardar credenciales (con sync a Supabase)
    sock.ev.on('creds.update', saveCreds);

    // Manejar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        
        // Get sender phone - handle both @s.whatsapp.net and @lid formats
        let phone = msg.key.remoteJid || '';
        
        // Handle @lid format (WhatsApp Business LinkedIn ID)
        if (phone.includes('@lid')) {
          phone = phone.replace('@lid', '');
          console.log(`[BAILEYS] LID format detected, extracted: ${phone}`);
        } else {
          phone = phone.replace('@s.whatsapp.net', '');
        }
        
        const pushName = msg.pushName || '';

        // Skip group messages
        if (msg.key.remoteJid?.includes('@g.us')) continue;
        
        // Extract message content based on type
        let text = '';
        let mediaType = null;
        let mediaUrl = null;
        
        if (msg.message?.conversation) {
          text = msg.message.conversation;
        } else if (msg.message?.extendedTextMessage?.text) {
          text = msg.message.extendedTextMessage.text;
        } else if (msg.message?.audioMessage) {
          // Audio/voice message
          mediaType = 'audio';
          text = '[🎤 Mensaje de voz]';
          
          // Download audio if needed
          try {
            const buffer = await sock.downloadMediaMessage(msg);
            if (buffer) {
              // Convert to base64 for the edge function
              const base64 = buffer.toString('base64');
              const mimetype = msg.message.audioMessage.mimetype || 'audio/ogg';
              mediaUrl = `data:${mimetype};base64,${base64}`;
            }
          } catch (err) {
            console.error('[BAILEYS] Error downloading audio:', err);
          }
        } else if (msg.message?.imageMessage) {
          // Image message
          mediaType = 'image';
          text = msg.message.imageMessage.caption || '[📷 Imagen]';
          
          try {
            const buffer = await sock.downloadMediaMessage(msg);
            if (buffer) {
              const base64 = buffer.toString('base64');
              const mimetype = msg.message.imageMessage.mimetype || 'image/jpeg';
              mediaUrl = `data:${mimetype};base64,${base64}`;
            }
          } catch (err) {
            console.error('[BAILEYS] Error downloading image:', err);
          }
        } else if (msg.message?.documentMessage) {
          // Document
          mediaType = 'document';
          text = `[📄 ${msg.message.documentMessage.fileName || 'Documento'}]`;
        } else if (msg.message?.videoMessage) {
          // Video
          mediaType = 'video';
          text = msg.message.videoMessage.caption || '[🎥 Video]';
        }

        if ((text || mediaType) && phone) {
          console.log(`[BAILEYS] 📩 Message from ${phone}: ${text} (type: ${mediaType || 'text'})`);
          await processIncomingMessage(phone, text, pushName, mediaType, mediaUrl);
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
    serverName: SERVER_NAME,
    persistenceEnabled: true,
  });
});

app.get('/api/status', authenticate, (req, res) => {
  res.json({
    status: connectionStatus,
    phone: connectedPhone,
    hasQR: !!qrCode,
    persistenceEnabled: true,
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

// Enviar imagen
app.post('/api/send-image', authenticate, async (req, res) => {
  const { phone, imageUrl, caption } = req.body;

  if (!phone || !imageUrl) {
    return res.status(400).json({ error: 'phone and imageUrl required' });
  }

  if (!sock || connectionStatus !== 'connected') {
    return res.status(500).json({ error: 'WhatsApp not connected' });
  }

  try {
    const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    
    await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || ''
    });
    
    console.log(`[BAILEYS] Image sent to ${jid}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[BAILEYS] Error sending image:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/logout', authenticate, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    await clearSession();
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
    
    if (sock) {
      sock.end();
      sock = null;
    }
    
    connectionStatus = 'disconnected';
    qrCode = null;
    isConnecting = false;
    reconnectAttempts = 0;
    
    // Limpiar sesión para forzar nuevo QR
    await clearSession();
    
    setTimeout(connectWhatsApp, 1000);
    
    res.json({ success: true, message: 'Reconnecting with fresh session...' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/clear-session', authenticate, async (req, res) => {
  try {
    if (sock) {
      sock.end();
      sock = null;
    }
    await clearSession();
    connectionStatus = 'disconnected';
    qrCode = null;
    connectedPhone = null;
    isConnecting = false;
    reconnectAttempts = 0;
    res.json({ success: true, message: 'Session cleared (local + Supabase)' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Nueva ruta para forzar sync a Supabase
app.post('/api/sync-credentials', authenticate, async (req, res) => {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) {
      return res.json({ success: false, message: 'No local credentials to sync' });
    }
    
    const files = fs.readdirSync(AUTH_FOLDER);
    const authState = {};
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const key = file.replace('.json', '');
        const content = fs.readFileSync(path.join(AUTH_FOLDER, file), 'utf-8');
        authState[key] = JSON.parse(content, BufferJSON.reviver);
      }
    }
    
    const success = await saveCredentialsToSupabase(authState);
    res.json({ success, message: success ? 'Credentials synced to Supabase' : 'Sync failed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ KEEP-ALIVE SELF-PING ============

// Self-ping para evitar que Render duerma el servidor por inactividad HTTP
function startSelfPing() {
  const SELF_PING_INTERVAL = 10 * 60 * 1000; // 10 minutos
  
  setInterval(async () => {
    try {
      const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      const response = await fetch(`${url}/health`);
      const data = await response.json();
      console.log(`[KEEP-ALIVE] Self-ping OK - WhatsApp: ${data.whatsapp}, Time: ${new Date().toISOString()}`);
    } catch (error) {
      console.error('[KEEP-ALIVE] Self-ping failed:', error.message);
    }
  }, SELF_PING_INTERVAL);
  
  console.log(`[KEEP-ALIVE] Self-ping enabled every ${SELF_PING_INTERVAL / 60000} minutes`);
}

// ============ INICIAR SERVIDOR ============

app.listen(PORT, () => {
  console.log(`[BAILEYS] 🚀 Server running on port ${PORT}`);
  console.log(`[BAILEYS] Node version: ${process.version}`);
  console.log(`[BAILEYS] Server name: ${SERVER_NAME}`);
  console.log(`[BAILEYS] Credentials URL: ${CREDENTIALS_URL}`);
  console.log(`[BAILEYS] Persistence: ENABLED (Supabase)`);
  
  // Iniciar conexión WhatsApp
  connectWhatsApp();
  
  // Iniciar self-ping para mantener el servidor activo
  startSelfPing();
});
