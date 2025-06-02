# WhatsApp Send Service

Este servicio maneja el envío de mensajes de WhatsApp utilizando la API de WhatsApp Business Cloud.

## Características

- ✅ Envío de mensajes via WhatsApp Business API
- ✅ Validación de números de teléfono internacionales
- ✅ Normalización automática de números
- ✅ Modo de prueba con números temporales
- ✅ Logging automático de mensajes
- ✅ Configuración flexible (variables de entorno o base de datos)
- ✅ Manejo robusto de errores
- ✅ Formateo automático de mensajes

## Configuración

### Opción 1: Variables de Entorno (Recomendado)

```bash
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_API_TOKEN=your_whatsapp_api_token
```

### Opción 2: Configuración por Sitio

Los settings se almacenan en la tabla `settings` con estructura:

```json
{
  "channels": {
    "whatsapp": {
      "phoneNumberId": "your_phone_number_id",
      "accessToken": "your_whatsapp_api_token"
    }
  }
}
```

## Uso Básico

```typescript
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';

const result = await WhatsAppSendService.sendMessage({
  phone_number: '+1234567890',
  message: 'Hola! ¿Cómo puedo ayudarte?',
  from: 'Equipo de Ventas',
  site_id: 'your-site-id',
  agent_id: 'agent-uuid',
  conversation_id: 'conv-uuid'
});

if (result.success) {
  console.log('Mensaje enviado:', result.message_id);
} else {
  console.error('Error:', result.error);
}
```

## Validación de Números

```typescript
// Números válidos
WhatsAppSendService.isValidPhoneNumber('+1234567890'); // true
WhatsAppSendService.isValidPhoneNumber('+34612345678'); // true
WhatsAppSendService.isValidPhoneNumber('+1 (234) 567-890'); // true

// Números inválidos
WhatsAppSendService.isValidPhoneNumber('1234567890'); // false (sin +)
WhatsAppSendService.isValidPhoneNumber('+123'); // false (muy corto)
```

## Números de Prueba

Para evitar enviar mensajes reales durante desarrollo:

```typescript
const result = await WhatsAppSendService.sendMessage({
  phone_number: 'no-phone-example', // o '+00000000000'
  message: 'Mensaje de prueba',
  site_id: 'test-site-id'
});

// result.status === 'skipped'
// result.reason === 'Temporary phone number - no real message sent'
```

## Respuestas del Servicio

### Éxito

```typescript
{
  success: true,
  message_id: 'wamid.unique_message_id',
  recipient: '+1234567890',
  sender: 'Equipo de Ventas',
  message_preview: 'Hola! ¿Cómo puedo ayudarte?',
  sent_at: '2024-01-15T10:30:00.000Z',
  status: 'sent'
}
```

### Error

```typescript
{
  success: false,
  error: {
    code: 'INVALID_PHONE_NUMBER',
    message: 'Invalid phone number format. Use international format'
  }
}
```

## Códigos de Error

| Código | Descripción |
|--------|-------------|
| `INVALID_PHONE_NUMBER` | Formato de número inválido |
| `WHATSAPP_CONFIG_NOT_FOUND` | Configuración de WhatsApp no encontrada |
| `WHATSAPP_SEND_FAILED` | Error al enviar mensaje |

## Formateo de Mensajes

Los mensajes se formatean automáticamente:

```
{mensaje original}

—
{from || 'Equipo de'} {site_name}
```

Ejemplo:
```
Hola! ¿Cómo puedo ayudarte hoy?

—
Equipo de Ventas Mi Empresa
```

## Logging

Todos los mensajes enviados se guardan automáticamente en la tabla `whatsapp_logs`:

```sql
CREATE TABLE whatsapp_logs (
  id UUID PRIMARY KEY,
  recipient_phone TEXT NOT NULL,
  sender_name TEXT,
  message_content TEXT NOT NULL,
  whatsapp_message_id TEXT,
  agent_id UUID,
  conversation_id UUID,
  lead_id UUID,
  sent_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'sent'
);
```

## Testing

Ejecutar tests:

```bash
npm test WhatsAppSendService.test.ts
```

Los tests cubren:
- Validación de números de teléfono
- Manejo de números temporales
- Configuración de variables de entorno
- Errores de API
- Logging de mensajes

## Integración con API Endpoints

Este servicio es utilizado por:

- `/api/agents/tools/sendWhatsApp` - Herramienta para agentes
- `/api/integrations/whatsapp/send` - Envío directo de WhatsApp

## Consideraciones de WhatsApp Business API

1. **Rate Limits**: WhatsApp tiene límites de velocidad
2. **Números Verificados**: Solo puedes enviar desde números verificados
3. **Templates**: Para ciertos tipos de mensajes necesitas templates aprobados
4. **Opt-in**: Los usuarios deben haber dado permiso para recibir mensajes

## Mantenimiento

- Monitorear logs de errores en `/api/agents/tools/sendWhatsApp`
- Verificar configuración de variables de entorno
- Revisar límites de API de WhatsApp regularmente
- Mantener tokens de acceso actualizados 