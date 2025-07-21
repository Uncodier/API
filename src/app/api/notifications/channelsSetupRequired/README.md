# Channels Setup Required Notification API

API endpoint para notificar a los team members cuando se requiere configurar canales de comunicación para habilitar la prospección automática.

## Endpoint

```
POST /api/notifications/channelsSetupRequired
```

## Descripción

Este endpoint verifica la configuración de canales de comunicación de un sitio y envía notificaciones por email a todos los team members cuando no tienen al menos uno de los canales requeridos (Email o WhatsApp) configurados.

La prospección automática requiere que el sitio tenga configurado al menos:
- **Canal de Email**: Para envío de campañas, seguimientos y secuencias de nurturing
- **Canal de WhatsApp**: Para mensajería instantánea y comunicación personalizada

## Parámetros

### Body (JSON)
```json
{
  "site_id": "uuid (required) - ID del sitio a verificar"
}
```

## Validaciones

- `site_id` debe ser un UUID válido
- El sitio debe existir en la base de datos
- Se verifica la configuración actual de canales

## Comportamiento

### 1. Verificación de Canales
El endpoint verifica la configuración de canales en la tabla `settings`:

**Email configurado si:**
- `channels.email.email` tiene un valor válido, O
- `channels.email.aliases` tiene al menos un alias

**WhatsApp configurado si:**
- `channels.whatsapp.phone_number` tiene un valor válido

### 2. Lógica de Notificación
- Si **ambos** canales están configurados: No se envía notificación
- Si **falta algún canal**: Se envía notificación a todos los team members

### 3. Obtención de Team Members
Se obtienen de dos tablas:
- `site_ownership`: Propietarios del sitio (rol 'owner')
- `site_members`: Miembros activos del sitio

Se respetan las preferencias de notificación por email de cada usuario.

## Respuestas

### Éxito - Canales ya configurados (200)
```json
{
  "success": true,
  "message": "Site already has required channels configured",
  "data": {
    "site_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "channels_configured": true,
    "configured_channels": ["email", "whatsapp"],
    "notification_sent": false
  }
}
```

### Éxito - Notificaciones enviadas (200)
```json
{
  "success": true,
  "data": {
    "site_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "channels_configured": false,
    "missing_channels": ["whatsapp"],
    "configured_channels": ["email"],
    "notification_sent": true,
    "team_members_notified": 3,
    "total_team_members": 3,
    "emails_sent": 3,
    "email_errors": 0,
    "sent_at": "2024-03-15T10:30:00Z"
  }
}
```

### Éxito - Sin team members (200)
```json
{
  "success": true,
  "message": "No team members with email notifications enabled found",
  "data": {
    "site_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "channels_configured": false,
    "missing_channels": ["email", "whatsapp"],
    "notification_sent": false,
    "team_members_found": 0
  }
}
```

### Error - Datos inválidos (400)
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [
      {
        "code": "invalid_string",
        "expected": "string",
        "received": "undefined",
        "path": ["site_id"],
        "message": "Required"
      }
    ]
  }
}
```

### Error - Sitio no encontrado (404)
```json
{
  "success": false,
  "error": {
    "code": "SITE_NOT_FOUND",
    "message": "Site not found"
  }
}
```

## Ejemplo de Uso

### cURL
```bash
curl -X POST http://localhost:3000/api/notifications/channelsSetupRequired \
  -H "Content-Type: application/json" \
  -d '{
    "site_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  }'
```

### JavaScript/TypeScript
```javascript
const response = await fetch('/api/notifications/channelsSetupRequired', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    site_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  })
});

const result = await response.json();
console.log(result);
```

## Contenido del Email

El email enviado incluye:

### Header
- Logo del sitio (si disponible)
- Título: "Channel Setup Required"
- Subtítulo: "Configure channels to enable automatic prospecting"

### Contenido Principal
- Saludo personalizado al team member
- Explicación de la necesidad de configurar canales
- Lista de canales faltantes
- Información detallada sobre cada canal requerido
- Beneficios de configurar los canales
- Botón de acción para ir a configuración

### Información de Canales
**Canal de Email:**
- Configurar dirección de email
- Envío de campañas automatizadas
- Secuencias de follow-up
- Nurturing de leads

**Canal de WhatsApp:**
- Integración con WhatsApp Business
- Mensajería instantánea
- Respuestas automatizadas
- Comunicación personalizada

### Call to Action
- Botón directo a la configuración del sitio
- URL: `{base_url}/sites/{site_id}/settings`

## Categorías de Email (SendGrid)

- `channels-setup`
- `team-notification` 
- `configuration-required`

## Argumentos Personalizados (SendGrid)

```json
{
  "siteId": "site_id",
  "teamMemberId": "user_id", 
  "missingChannels": "email,whatsapp",
  "notificationType": "channels_setup_required"
}
```

## Logs y Monitoreo

El endpoint genera logs detallados con prefijo `[ChannelsSetup]`:

- 🔍 Búsqueda de team members
- ⚙️ Verificación de configuración
- 📧 Envío de notificaciones
- ✅ Éxitos y ❌ errores

## Casos de Uso

### 1. Verificación Automática
Llamar este endpoint periódicamente para verificar que los sitios tengan canales configurados.

### 2. Onboarding
Incluir en el proceso de configuración inicial de sitios.

### 3. Recordatorios
Enviar recordatorios a sitios que no han completado la configuración.

### 4. Auditoría
Verificar el estado de configuración de canales en múltiples sitios.

## Mejores Prácticas

1. **Frecuencia**: No enviar más de una notificación por día por sitio
2. **Segmentación**: Verificar preferencias de notificación de usuarios
3. **Seguimiento**: Registrar cuando se envían notificaciones para evitar spam
4. **Contextualización**: Personalizar el mensaje según el tipo de negocio

## Dependencias

- `@/lib/database/supabase-client`: Cliente de Supabase
- `@/lib/services/sendgrid-service`: Servicio de SendGrid
- `zod`: Validación de esquemas
- Tablas: `sites`, `settings`, `site_ownership`, `site_members`, `profiles` 