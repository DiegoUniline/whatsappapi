# Servidor Baileys para Apunta

Este servidor permite conectar WhatsApp directamente a tu aplicación usando [Baileys](https://github.com/WhiskeySockets/Baileys).

## 🚀 Despliegue Rápido en Render

### 1. Crear nuevo repositorio en GitHub

1. Crea un nuevo repositorio vacío en GitHub (ej: `apunta-whatsapp-server`)
2. Sube el contenido de esta carpeta `baileys-server/` a ese repositorio

### 2. Desplegar en Render

1. Ve a [render.com](https://render.com) y crea una cuenta gratis
2. Click en "New +" → "Web Service"
3. Conecta tu repositorio de GitHub
4. Configura:
   - **Name**: `apunta-whatsapp`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (o $7/mes para siempre activo)

### 3. Variables de Entorno en Render

Agrega estas variables en la sección "Environment":

```
SUPABASE_URL=https://ewiayikxrcvjvcjqqjvj.supabase.co
SUPABASE_SERVICE_KEY=tu_service_role_key
LOVABLE_API_KEY=tu_lovable_api_key
API_SECRET=crea_una_clave_secreta_aleatoria
```

### 4. Conectar desde Apunta

Una vez desplegado, copia la URL de Render (ej: `https://apunta-whatsapp.onrender.com`) y pégala en la configuración de tu app Apunta.

## 📡 Endpoints

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/status` | GET | Estado de conexión |
| `/api/qr` | GET | Obtiene QR para escanear |
| `/api/send` | POST | Envía un mensaje |
| `/api/logout` | POST | Cierra sesión |
| `/health` | GET | Health check |

## ⚠️ Notas Importantes

- **Sesión Persistente**: La sesión se guarda en `./baileys_auth_info/`
- **Render Free Tier**: Se duerme después de 15 min de inactividad. El plan de $7/mes mantiene activo 24/7.
- **Backup de sesión**: Considera guardar la carpeta de autenticación en un storage persistente para Render.

## 🔧 Desarrollo Local

```bash
cd baileys-server
npm install
npm run dev
```

Luego abre http://localhost:3001
