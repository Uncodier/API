# WhatsApp Lead Service

Este servicio maneja específicamente la gestión de leads y conversaciones para mensajes que llegan desde WhatsApp.

## Características

- ✅ Búsqueda de leads por número de teléfono
- ✅ Creación automática de leads para WhatsApp
- ✅ Búsqueda de conversaciones recientes de WhatsApp (últimos 15 días)
- ✅ Reutilización de conversaciones existentes
- ✅ Manejo robusto de errores con fallback

## Flujo de Trabajo

### Cuando llega un mensaje de WhatsApp:

1. **Detecta origen WhatsApp**: `origin: "whatsapp"`
2. **Busca lead existente**: Por número de teléfono + site_id
3. **Crea lead si no existe**: Con origen "whatsapp" y datos del remitente
4. **Busca conversación reciente**: Conversaciones de WhatsApp de los últimos 15 días
5. **Reutiliza conversación**: Si existe una conversación reciente, la usa
6. **Permite nueva conversación**: Si no hay conversación reciente

## Uso

```typescript
import { WhatsAppLeadService } from '@/lib/services/whatsapp/WhatsAppLeadService';

const result = await WhatsAppLeadService.findOrCreateLeadAndConversation({
  phoneNumber: '+5214661076083',
  senderName: 'Rolando Rodríguez Gallard',
  siteId: '9be0a6a2-5567-41bf-ad06-cb4014f0faf2',
  userId: '541396e1-a904-4a81-8cbf-0ca4e3b8b2b4',
  businessAccountId: 'AC33ea5f1f199268060327c120507dd223'
});

// Resultado:
// {
//   leadId: 'uuid-del-lead',
//   conversationId: 'uuid-de-conversacion-existente-o-null',
//   isNewLead: false,
//   isNewConversation: true
// }
```

## Integración con customerSupport/message

Cuando el `origin` es "whatsapp", el endpoint `/api/agents/customerSupport/message` automáticamente:

1. Usa `WhatsAppLeadService` en lugar del servicio estándar
2. Busca/crea el lead por número de teléfono
3. Busca conversación reciente de WhatsApp
4. Pasa la conversación existente al agente para mantener contexto
5. Guarda todo con las referencias correctas

## Beneficios

- **Continuidad**: Las conversaciones de WhatsApp se mantienen unificadas
- **Contexto**: El agente tiene acceso al historial completo
- **Eficiencia**: Reutiliza conversaciones existentes en lugar de crear nuevas
- **Trazabilidad**: Mantiene el origen "whatsapp" en todos los registros

## Ejemplo de Datos de Entrada (WhatsApp)

```json
{
  "phoneNumber": "+5214661076083",
  "messageContent": "Hola Sergio en 5 minutos llego ala central",
  "businessAccountId": "AC33ea5f1f199268060327c120507dd223",
  "messageId": "SM09ea50d7c540a6a2b3aaae520e2b7218",
  "conversationId": null,
  "agentId": "937e88db-d4b2-4dde-8d74-c582927ddae4",
  "siteId": "9be0a6a2-5567-41bf-ad06-cb4014f0faf2",
  "userId": "541396e1-a904-4a81-8cbf-0ca4e3b8b2b4",
  "senderName": "Rolando Rodríguez Gallard",
  "origin": "whatsapp"
}
```

## Búsqueda de Conversaciones

El servicio busca conversaciones de WhatsApp usando múltiples campos:

- `custom_data.channel = "whatsapp"`
- `channel = "whatsapp"`
- `custom_data.source = "whatsapp"` (formato anterior)

Solo incluye conversaciones de los últimos 15 días para mantener relevancia. 