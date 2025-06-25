# Stripe Integration

Este directorio contiene la integración con Stripe para manejar pagos y checkouts.

## Endpoints Disponibles

### `/api/integrations/stripe/checkout` - Crear Checkout Session
Crea una sesión de checkout de Stripe para pagos de outsourcing.

**POST Request:**
```json
{
  "taskId": "uuid",           // ID de la tarea (opcional)
  "campaignId": "uuid",       // ID de la campaña (opcional)
  "amount": 100.00,           // Monto en la moneda especificada
  "currency": "usd",          // Moneda (default: usd)
  "productName": "string",    // Nombre del producto/servicio
  "productDescription": "string", // Descripción del producto/servicio
  "productImages": ["url1", "url2"], // URLs de imágenes (opcional)
  "siteId": "uuid",          // ID del sitio (requerido)
  "userEmail": "email@example.com" // Email del usuario (requerido)
}
```

**Response:**
```json
{
  "sessionId": "cs_stripe_session_id",
  "url": "https://checkout.stripe.com/..."
}
```

### `/api/integrations/stripe/webhook` - Webhook Handler
Maneja eventos de webhook de Stripe para procesar pagos completados.

**Eventos soportados:**
- `checkout.session.completed` - Cuando se completa un checkout
- `payment_intent.succeeded` - Cuando un pago es exitoso

## Configuración del Webhook en Stripe

Para que el sistema funcione correctamente, debes configurar un webhook en tu dashboard de Stripe:

### 1. Crear Webhook Endpoint

1. Ve a tu Dashboard de Stripe
2. Navega a **Developers > Webhooks**
3. Haz clic en **Add endpoint**
4. Configura la URL del webhook:
   - **Development:** `https://tu-dominio-dev.com/api/integrations/stripe/webhook`
   - **Production:** `https://tu-dominio.com/api/integrations/stripe/webhook`

### 2. Seleccionar Eventos

Selecciona los siguientes eventos para escuchar:
- ✅ `checkout.session.completed`
- ✅ `payment_intent.succeeded`

### 3. Obtener Signing Secret

1. Después de crear el webhook, copia el **Signing secret**
2. Añádelo a tus variables de entorno como `STRIPE_WEBHOOK_SECRET`

### 4. Variables de Entorno Requeridas

```env
STRIPE_SECRET_KEY=sk_test_... # o sk_live_... para producción
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_APP_URL=https://tu-dominio.com
```

## Funcionalidad

### Cuando se completa un checkout:

1. **Se crea un registro de pago** en la tabla `payments` con:
   - `transaction_id`: ID de la sesión de Stripe
   - `transaction_type`: 'task_outsourcing' o 'campaign_outsourcing'
   - `amount`: Monto del pago
   - `currency`: Moneda del pago
   - `status`: 'completed'
   - `details`: Metadata completa del pago

2. **Se actualiza la metadata** en la tabla correspondiente:
   - **Campaigns:** Si `campaignId` está presente, se actualiza `campaigns.metadata`
   - **Requirements:** Si `taskId` está presente, se actualiza `requirements.metadata`

### Estructura de metadata de pago:

```json
{
  "payment_status": {
    "status": "paid",
    "amount_paid": 100.00,
    "currency": "USD",
    "payment_method": "stripe",
    "stripe_payment_intent_id": "pi_...",
    "payment_date": "2024-01-15T10:30:00Z",
    "outsourced": true,
    "outsource_provider": "uncodie",
    "session_metadata": {
      "type": "campaign_outsourcing",
      "campaign_id": "uuid",
      "site_id": "uuid",
      "user_email": "user@example.com"
    }
  }
}
```

## Seguridad

- ✅ **Verificación de firma:** Todos los webhooks son verificados usando el signing secret de Stripe
- ✅ **Middleware bypass:** Los webhooks tienen acceso directo sin autenticación adicional
- ✅ **Validación de datos:** Se valida que todos los campos requeridos estén presentes
- ✅ **Manejo de errores:** Se registran todos los errores para debugging

## Testing

Para probar el webhook localmente:

1. Usa Stripe CLI para reenviar eventos:
```bash
stripe listen --forward-to localhost:3001/api/integrations/stripe/webhook
```

2. Crea un checkout session de prueba y completa el pago

3. Verifica que se hayan creado/actualizado los registros en la base de datos

## Logs

El webhook registra información detallada en consola:
- ✅ Eventos recibidos
- 💰 Pagos procesados  
- ❌ Errores y validaciones fallidas
- 🔍 Metadata actualizada 

# Stripe Integration - Webhook Configuration

## Configuración del Webhook de Stripe

Este directorio contiene la integración completa con Stripe, incluyendo:

- **Checkout**: Creación de sesiones de pago (`/checkout`)
- **Webhook**: Procesamiento de eventos de Stripe con validación de signature (`/webhook`)

## 🔐 Validación de Signature (STRIPE_HANDSHAKE)

El webhook de Stripe está protegido con validación de signature para garantizar que los eventos provienen realmente de Stripe y no de actores maliciosos.

### Variables de Entorno Requeridas

```bash
# Claves de Stripe
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
STRIPE_PUBLISHABLE_KEY=pk_test_your_stripe_publishable_key

# 🔑 CRÍTICO: Secret del webhook para validación de signature
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_from_stripe
```

### Configuración del Webhook en Stripe Dashboard

1. **Ir a Stripe Dashboard** → Developers → Webhooks
2. **Crear nuevo webhook** con la URL: `https://your-domain.com/api/integrations/stripe/webhook`
3. **Seleccionar eventos**:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
4. **Copiar el signing secret** (empieza con `whsec_`) y agregarlo a `STRIPE_WEBHOOK_SECRET`

## 🛡️ Validación de Seguridad

### Signature Verification

El endpoint del webhook implementa validación completa de signature:

```typescript
// Verificar que el webhook secret esté configurado
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  return NextResponse.json({ error: 'Webhook configuration error' }, { status: 500 })
}

// Verificar que el header de signature esté presente
if (!stripeSignature) {
  return NextResponse.json({ error: 'Missing Stripe signature' }, { status: 400 })
}

// Validar signature usando la biblioteca de Stripe
event = stripe.webhooks.constructEvent(
  body,
  stripeSignature,
  process.env.STRIPE_WEBHOOK_SECRET
)
```

### Middleware Protection

El webhook está excluido de validaciones adicionales en el middleware porque Stripe maneja su propia validación:

```javascript
// En middleware.js
const isStripeWebhook = request.nextUrl.pathname === '/api/integrations/stripe/webhook';

if (isStripeWebhook) {
  console.log('[Middleware] Stripe webhook detected - skipping origin/API validation');
  // Permite el webhook sin validaciones adicionales
}
```

## 📋 Eventos Procesados

### `checkout.session.completed`
- Registra el pago en la base de datos
- Actualiza el metadata de campaigns o requirements
- Maneja diferentes tipos de outsourcing

### `payment_intent.succeeded`
- Backup para pagos directos
- Validación adicional de metadata
- Actualización de estado de pago

## 🚨 Seguridad Crítica

⚠️ **NUNCA** exponer o commitear el `STRIPE_WEBHOOK_SECRET`
⚠️ **SIEMPRE** validar la signature antes de procesar eventos
⚠️ **VERIFICAR** que los eventos provienen de Stripe

## 🔍 Debugging

El webhook incluye logging detallado para debugging:

```bash
# Logs exitosos
✅ Stripe webhook signature verified successfully
✅ Payment record created successfully

# Logs de error
❌ STRIPE_WEBHOOK_SECRET not configured
❌ Missing Stripe signature header
❌ Webhook signature verification failed
```

## Endpoints

### POST `/api/integrations/stripe/checkout`
Crea una sesión de checkout de Stripe.

**Parámetros requeridos:**
- `amount`: Monto en unidad base de la moneda
- `productName`: Nombre del producto/servicio
- `siteId`: ID del sitio
- `userEmail`: Email del usuario

**Parámetros opcionales:**
- `taskId`: ID de la tarea (para task outsourcing)
- `campaignId`: ID de la campaña (para campaign outsourcing)
- `currency`: Moneda (default: 'usd')
- `productDescription`: Descripción del producto
- `productImages`: Array de URLs de imágenes

### POST `/api/integrations/stripe/webhook`
Procesa eventos de webhook de Stripe con validación de signature.

**Headers requeridos:**
- `stripe-signature`: Signature de Stripe para validación

**Eventos procesados:**
- `checkout.session.completed`
- `payment_intent.succeeded` 