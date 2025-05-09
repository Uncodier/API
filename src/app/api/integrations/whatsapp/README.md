# WhatsApp Business API Integration

Esta integración permite conectar el sistema de agentes con la API de WhatsApp Business para recibir y enviar mensajes a usuarios a través de WhatsApp.

## Estructura

- `webhook/route.ts`: Endpoint para recibir eventos de WhatsApp (mensajes entrantes, confirmaciones de entrega, etc.)
- `send/route.ts`: Endpoint para enviar mensajes a través de WhatsApp
- `agent/route.ts`: Endpoint para procesar mensajes de WhatsApp utilizando los agentes

## Requisitos

Para utilizar esta integración, necesitas:

1. Una cuenta de Meta for Developers
2. Una aplicación de WhatsApp Business configurada
3. Un número de teléfono de WhatsApp Business registrado
4. Variables de entorno configuradas

## Variables de Entorno

Añade estas variables a tu archivo `.env`:

```
WHATSAPP_APP_ID=tu_app_id_de_meta
WHATSAPP_APP_SECRET=tu_app_secret_de_meta
WHATSAPP_PHONE_NUMBER_ID=tu_phone_number_id
WHATSAPP_API_TOKEN=tu_token_permanente_de_whatsapp
WHATSAPP_WEBHOOK_VERIFY_TOKEN=un_token_de_verificacion_secreto
WHATSAPP_WEBHOOK_URL=https://tu-dominio.com/api/integrations/whatsapp/webhook
```

## Configuración

### 1. Registrar el Webhook

Puedes registrar el webhook manualmente en el Dashboard de Meta for Developers, o utilizar el script provisto:

```bash
node scripts/register-whatsapp-webhook.js
```

### 2. Configurar el número de teléfono

Asegúrate de que tu número de teléfono de WhatsApp Business esté correctamente configurado y verificado en el Meta Dashboard.

## Flujo de funcionamiento

1. **Recepción de mensajes**:
   - WhatsApp envía notificaciones de mensajes entrantes a tu webhook
   - El webhook procesa el mensaje y lo guarda en la base de datos
   - Se crea automáticamente un visitante y una conversación si no existen
   - Se solicita una respuesta al agente configurado

2. **Envío de mensajes**:
   - El agente genera una respuesta
   - La respuesta se guarda en la base de datos
   - Se envía la respuesta a través de la API de WhatsApp

## Uso del API

### Enviar mensaje directo

Puedes enviar un mensaje directamente a un número de WhatsApp:

```http
POST /api/integrations/whatsapp/send
Content-Type: application/json

{
  "phone_number": "1234567890",
  "message": "¡Hola! Este es un mensaje de prueba",
  "business_account_id": "tu_business_account_id" (opcional)
}
```

### Procesar un mensaje con un agente

Para procesar un mensaje ya guardado con un agente:

```http
POST /api/integrations/whatsapp/agent
Content-Type: application/json

{
  "conversation_id": "uuid_de_conversacion",
  "message_id": "uuid_de_mensaje"
}
```

## Tipos de mensajes soportados

La integración actual soporta los siguientes tipos de mensajes entrantes:

- Texto
- Imágenes (con o sin leyenda)
- Audio
- Video
- Documentos
- Stickers
- Reacciones
- Ubicaciones
- Contactos

## Depuración

Para depurar la integración, puedes revisar los logs del servidor donde encontrarás mensajes detallados sobre el procesamiento de mensajes de WhatsApp.

## Limitaciones

- La cuenta de WhatsApp Business API tiene sus propias limitaciones de envío que debes consultar con Meta.
- El procesamiento asíncrono de mensajes puede generar un pequeño retraso entre la recepción del mensaje y la respuesta del agente.

## Expansión futura

Algunas mejoras que podrían implementarse:

- Soporte para plantillas de mensajes de WhatsApp
- Procesamiento de botones y acciones interactivas
- Cola de mensajes con reintentos
- Interfaz de usuario para monitorear conversaciones de WhatsApp 