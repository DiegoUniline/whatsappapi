const express = require('express');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Configuración
const API_SECRET = process.env.API_SECRET || 'dev-secret-key';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;

// Estado de la conexión
let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let connectedPhone = null;

// Logger silencioso para Baileys
const logger = pino({ level: 'silent' });

// Supabase client
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY 
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// Middleware de autenticación simple
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Función para procesar mensaje entrante con IA
async function processIncomingMessage(phone, message, pushName) {
  if (!supabase || !LOVABLE_API_KEY) {
    console.log('[BAILEYS] No Supabase/AI config, skipping processing');
    return;
  }

  console.log(`[BAILEYS] Processing message from ${phone}: ${message}`);

  try {
    // Buscar empresa por teléfono (últimos 10 dígitos)
    const cleanPhone = phone.replace(/\D/g, '');
    const last10 = cleanPhone.slice(-10);

    const { data: empresa } = await supabase
      .from('empresas')
      .select('numero')
      .or(`telefono.ilike.%${last10}`)
      .limit(1)
      .single();

    if (!empresa) {
      console.log(`[BAILEYS] No empresa found for phone ${phone}`);
      return;
    }

    // Usar IA para interpretar el gasto
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: [
          {
            role: 'system',
            content: `Eres un asistente que interpreta mensajes de gastos en español mexicano. 
            Extrae: monto (número), concepto (texto corto), tipo (gasto o ingreso).
            Responde SOLO en JSON: {"monto": 100, "concepto": "café", "tipo": "gasto", "es_transaccion": true}
            Si no es un gasto/ingreso válido, responde: {"es_transaccion": false}`
          },
          { role: 'user', content: message }
        ],
      }),
    });

    const aiData = await aiResponse.json();
    const content = aiData.choices?.[0]?.message?.content || '';
    
    // Extraer JSON de la respuesta
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('[BAILEYS] No valid JSON from AI');
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    if (!parsed.es_transaccion || !parsed.monto) {
      console.log('[BAILEYS] Not a valid transaction');
      return;
    }

    // Insertar gasto en Supabase
    const { data: gasto, error } = await supabase
      .from('gastos')
      .insert({
        empresa_numero: empresa.numero,
        monto: parsed.monto,
        concepto: parsed.concepto || 'Sin concepto',
        tipo: parsed.tipo === 'ingreso' ? 'ingreso' : 'gasto',
        telefono_origen: phone,
        nombre_contacto: pushName || null,
        mensaje_original: message,
        tipo_mensaje: 'texto',
      })
      .select()
      .single();

    if (error) {
      console.error('[BAILEYS] Error inserting gasto:', error);
    } else {
      console.log('[BAILEYS] Gasto created:', gasto.id);
      
      // Opcional: Enviar confirmación
      await sendMessage(phone, `✅ Registrado: $${parsed.monto} - ${parsed.concepto}`);
    }

  } catch (error) {
    console.error('[BAILEYS] Error processing message:', error);
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
  console.log('[BAILEYS] Starting connection...');
  
  const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth_info');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger,
  });

  // Manejar actualizaciones de conexión
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = await QRCode.toDataURL(qr);
      connectionStatus = 'waiting_qr';
      console.log('[BAILEYS] QR code generated');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[BAILEYS] Connection closed, reconnecting:', shouldReconnect);
      connectionStatus = 'disconnected';
      qrCode = null;
      connectedPhone = null;
      
      if (shouldReconnect) {
        setTimeout(connectWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      qrCode = null;
      connectedPhone = sock.user?.id?.split(':')[0] || null;
      console.log('[BAILEYS] Connected as:', connectedPhone);
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

      if (text) {
        console.log(`[BAILEYS] Message from ${phone}: ${text}`);
        await processIncomingMessage(phone, text, pushName);
      }
    }
  });
}

// Rutas
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    setTimeout(connectWhatsApp, 1000);
    res.json({ success: true, message: 'Reconnecting...' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`[BAILEYS] Server running on port ${PORT}`);
  connectWhatsApp();
});
