# Lead Attention Notification API

Esta API permite notificar a los team members cuando leads asignados a ellos requieren atención por haber contactado a través de diferentes canales.

## Endpoint

```
POST /api/notifications/leadAttention
```

## Parámetros de Request

### Requeridos

- **`site_id`** (string, UUID): ID del sitio donde están los leads
- **`names`** (array[string]): Lista de nombres de leads que requieren atención

### Opcionales

- **`user_message`** (string): Mensaje del usuario/lead
- **`system_message`** (string): Mensaje del sistema
- **`channel`** (string): Canal por el cual contactó el lead
  - Valores: `email`, `whatsapp`, `phone`, `chat`, `form`, `other`
  - Default: `other`
- **`priority`** (string): Nivel de prioridad de la notificación
  - Valores: `low`, `normal`, `high`, `urgent`
  - Default: `normal`
- **`contact_info`** (object): Información de contacto adicional
  - **`email`** (string): Email de contacto
  - **`phone`** (string): Teléfono de contacto
  - **`contact_method`** (string): Método de contacto preferido
- **`additional_data`** (object): Datos adicionales del lead o contexto

## Ejemplo de Request

```json
{
  "site_id": "550e8400-e29b-41d4-a716-446655440000",
  "names": ["John Doe", "Jane Smith", "Robert Johnson"],
  "user_message": "I need help with my order, can someone assist me?",
  "system_message": "Lead contacted through contact form",
  "channel": "form",
  "priority": "high",
  "contact_info": {
    "email": "john@example.com",
    "phone": "+1-555-123-4567",
    "contact_method": "Email preferred"
  },
  "additional_data": {
    "source": "Contact form",
    "page": "/contact",
    "utm_source": "google",
    "utm_medium": "cpc",
    "order_id": "ORD-12345"
  }
}
```

## Responses

### Éxito (200)

```json
{
  "success": true,
  "data": {
    "site_id": "550e8400-e29b-41d4-a716-446655440000",
    "names": ["John Doe", "Jane Smith"],
    "channel": "form",
    "priority": "high",
    "notification_sent": true,
    "sent_at": "2024-01-15T10:30:00.000Z",
    "channels_configuration": {
      "has_channels": true,
      "configured_channels": ["email", "whatsapp", "chat"],
      "warning": null
    }
  }
}
```

### Éxito con Warning de Canales (200)

```json
{
  "success": true,
  "data": {
    "site_id": "550e8400-e29b-41d4-a716-446655440000",
    "names": ["John Doe"],
    "channel": "form",
    "priority": "high", 
    "notification_sent": true,
    "sent_at": "2024-01-15T10:30:00.000Z",
    "channels_configuration": {
      "has_channels": false,
      "configured_channels": [],
      "warning": "No channels configured - prospecting will be seriously affected"
    }
  }
}
```

### Error de Validación (400)

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [
      {
        "code": "invalid_type",
        "expected": "string",
        "received": "undefined",
        "path": ["site_id"],
        "message": "Required"
      }
    ]
  }
}
```

### Leads No Encontrados (404)

```json
{
  "success": false,
  "error": {
    "code": "LEADS_NOT_FOUND",
    "message": "No leads found with the provided names"
  }
}
```

### Error de Sistema (500)

```json
{
  "success": false,
  "error": {
    "code": "SYSTEM_ERROR",
    "message": "An internal system error occurred"
  }
}
```

## Códigos de Error

| Código | Descripción |
|--------|-------------|
| `VALIDATION_ERROR` | Error en la validación de parámetros |
| `LEADS_NOT_FOUND` | No se encontraron leads con los nombres proporcionados |
| `SITE_NOT_FOUND` | Sitio no encontrado |
| `SYSTEM_ERROR` | Error interno del sistema |

## Lógica de Negocio

1. **Búsqueda de Leads**: Busca leads por nombres en el sitio especificado que tengan assignee_id asignado
2. **Filtrado**: Solo procesa leads que tengan un team member asignado
3. **Verificación de Canales**: Verifica la configuración de canales del sitio en `settings.channels`
4. **Notificación Individual**: Envía una notificación personalizada a cada team member para sus leads respectivos
5. **Handling de Errores**: Si un lead no tiene assignee o el team member no tiene email, se omite sin fallar el proceso completo
6. **Warning de Prospección**: Si no hay canales configurados, incluye warning sobre impacto en prospección

## Funcionalidades

### 📧 Notificación por Email
- Email HTML personalizado con información del lead
- Diseño responsive y profesional
- Incluye información del canal de contacto
- Botones de acción para ver el lead y responder

### 🎨 Diseño Visual
- Colores diferenciados por prioridad
- Iconos representativos para cada canal
- Layout profesional con branding del sitio
- Compatible con clientes de email

### 🔄 Manejo de Múltiples Leads
- Procesa múltiples leads en una sola llamada
- Agrupa notificaciones por team member
- Envío independiente para cada lead-assignee

### 🛡️ Validación Robusta
- Validación de UUIDs
- Verificación de existencia de leads y team members
- Manejo graceful de errores sin interrumpir otras notificaciones

### 🔍 Verificación de Canales de Prospección
- Análisis automático de configuración de canales en `settings.channels`
- Detección de canales funcionales: email, whatsapp, phone, sms, chat, social
- Warnings críticos cuando no hay canales configurados
- Información detallada de canales disponibles en la respuesta
- Logs de advertencia para administradores del sistema

## Casos de Uso

1. **Notificación de Contacto**: Cuando un lead contacta y necesita respuesta del team member asignado
2. **Seguimiento Urgente**: Para leads de alta prioridad que requieren atención inmediata  
3. **Múltiples Leads**: Cuando varios leads de un sitio requieren atención simultánea
4. **Diferentes Canales**: Notificar sobre contacto vía email, WhatsApp, teléfono, etc.

## Integración

```javascript
// Ejemplo de uso desde frontend
const notifyLeadAttention = async (siteId, leadNames, options = {}) => {
  try {
    const response = await fetch('/api/notifications/leadAttention', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        site_id: siteId,
        names: leadNames,
        channel: options.channel || 'other',
        priority: options.priority || 'normal',
        user_message: options.userMessage,
        system_message: options.systemMessage,
        contact_info: options.contactInfo,
        additional_data: options.additionalData
      })
    });

    const result = await response.json();
    
    if (result.success) {
      console.log('Notifications sent successfully:', result.data);
      
      // Verificar configuración de canales
      if (!result.data.channels_configuration.has_channels) {
        console.warn('⚠️ CRITICAL:', result.data.channels_configuration.warning);
        console.warn('Configure channels in site settings to improve prospecting effectiveness');
      } else {
        console.log('✅ Channels configured:', result.data.channels_configuration.configured_channels.join(', '));
      }
      
      return result.data;
    } else {
      throw new Error(result.error.message);
    }
  } catch (error) {
    console.error('Error sending lead attention notifications:', error);
    throw error;
  }
};

// Uso
await notifyLeadAttention(
  '550e8400-e29b-41d4-a716-446655440000',
  ['John Doe', 'Jane Smith'],
  {
    channel: 'email',
    priority: 'high',
    userMessage: 'I need help with my order',
    contactInfo: {
      email: 'john@example.com',
      phone: '+1-555-123-4567'
    }
  }
);
```

## Notas

- Los emails se envían de forma individual a cada team member
- Si un lead no tiene assignee_id, se omite sin generar error
- La prioridad afecta el estilo visual del email
- Se incluye información del sitio y branding automáticamente
- Las notificaciones son idempotentes por lead
- **IMPORTANTE**: La API verifica automáticamente la configuración de canales del sitio
- Si no hay canales configurados, se registra un warning crítico en logs del servidor
- La respuesta incluye información detallada sobre el estado de configuración de canales
- Canales soportados: email, whatsapp, phone, sms, chat, social
- Sin canales configurados, la prospección automática se verá seriamente afectada 