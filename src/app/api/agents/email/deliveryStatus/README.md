# Email Delivery Status API

## Descripción

Esta API procesa correos de "Mail Delivery Subsystem" (emails rebotados) para identificar leads con emails inválidos y tomar acciones automáticas de limpieza.

## Endpoint

**POST** `/api/agents/email/deliveryStatus`

## Funcionalidad

1. **Busca emails de bounce**: Identifica correos de "Mail Delivery Subsystem" en la bandeja de entrada
2. **Extrae email original**: Analiza el mensaje de bounce para extraer el email que rebotó
3. **Encuentra el lead**: Busca el lead asociado al email rebotado
4. **Llama workflow de invalidación**: Ejecuta `leadInvalidationWorkflow` en Temporal
5. **Elimina emails**: Borra tanto el email de bounce como el email original enviado

## Parámetros de Request

```json
{
  "site_id": "string (requerido)",
  "limit": "number (opcional, default: 50)",
  "since_date": "string (opcional, formato ISO)"
}
```

### Parámetros

- **site_id**: ID del sitio para procesar emails
- **limit**: Número máximo de emails a procesar (máximo recomendado: 100)
- **since_date**: Fecha desde la cual buscar emails (formato ISO: "2024-01-01T00:00:00.000Z")

## Respuesta Exitosa

```json
{
  "success": true,
  "message": "Procesamiento de delivery status completado",
  "totalEmails": 25,
  "bounceEmails": 3,
  "processedBounces": 3,
  "workflowsTriggered": 2,
  "emailsDeleted": 4,
  "results": [
    {
      "bounceEmailId": "12345",
      "originalEmail": "invalid@example.com",
      "leadId": "lead-uuid-123",
      "workflowTriggered": true,
      "workflowId": "lead-invalidation-xxx",
      "bounceEmailDeleted": true,
      "originalEmailDeleted": true,
      "success": true
    }
  ]
}
```

## Respuesta de Error

```json
{
  "success": false,
  "error": {
    "code": "EMAIL_CONFIG_NOT_FOUND",
    "message": "Configuración de email no encontrada para el sitio"
  }
}
```

## Códigos de Error

| Código | Descripción |
|--------|-------------|
| `INVALID_REQUEST` | Parámetros de solicitud inválidos |
| `EMAIL_CONFIG_NOT_FOUND` | No se encontró configuración de email para el sitio |
| `EMAIL_FETCH_ERROR` | Error al obtener emails del servidor |
| `WORKFLOW_ERROR` | Error ejecutando el workflow de invalidación |
| `EMAIL_DELETE_ERROR` | Error eliminando emails del servidor |
| `SYSTEM_ERROR` | Error interno del sistema |

## Workflow de Invalidación de Leads

### leadInvalidationWorkflow

Cuando se detecta un email rebotado, se ejecuta automáticamente el workflow `leadInvalidationWorkflow` que:

1. **Marca el email como inválido** en la base de datos
2. **Actualiza el status del lead** a 'invalid_email'
3. **Registra evento** en el historial del lead
4. **Cancela emails programados** para ese lead
5. **Notifica al equipo** sobre el bounce
6. **Actualiza métricas** de calidad de leads
7. **Limpia datos relacionados** con el bounce
8. **Busca leads duplicados** con el mismo email inválido

### Parámetros del Workflow

```typescript
{
  lead_id: string;
  email: string;
  site_id: string;
  reason: 'email_bounce' | 'invalid_email' | 'manual_invalidation';
  bounce_details?: {
    bounce_email_id: string;
    bounce_subject?: string;
    bounce_from?: string;
    bounce_date?: string;
    bounce_message?: string;
  };
}
```

## Detección de Emails de Bounce

### Patrones Detectados

#### Remitentes (From):
- mail delivery subsystem
- postmaster
- mailer-daemon
- mail delivery system
- delivery status notification
- undelivered mail returned
- bounce
- delivery failure
- mail administrator

#### Asuntos (Subject):
- undelivered mail returned
- delivery status notification
- failure notice
- mail delivery failed
- returned mail
- delivery failure
- bounce
- undeliverable
- permanent failure
- delivery report

#### Contenido del mensaje:
- permanent failure
- delivery failed
- user unknown
- mailbox not found
- recipient address rejected
- does not exist
- mailbox unavailable
- delivery to the following recipient failed
- the following addresses had permanent fatal errors
- host unknown

## Eliminación de Emails

### Funcionalidad de Eliminación

La API elimina automáticamente:

1. **Email de bounce**: El mensaje de "Mail Delivery Subsystem" recibido
2. **Email original enviado**: El email que fue enviado al lead y rebotó (si se encuentra)

### Proceso de Eliminación

1. **Marca emails para eliminación** usando flags IMAP
2. **Confirma eliminación permanente** mediante expunge
3. **Detecta carpetas inteligentemente** (INBOX para recibidos, carpeta de enviados para enviados)
4. **Procesa en lotes** para evitar sobrecargar el servidor

## Ejemplo de Uso

```bash
curl -X POST http://localhost:3000/api/agents/email/deliveryStatus \
  -H "Content-Type: application/json" \
  -d '{
    "site_id": "your-site-uuid",
    "limit": 25,
    "since_date": "2024-01-01T00:00:00.000Z"
  }'
```

## Configuración Requerida

### Variables de Entorno

```bash
# Temporal Configuration
TEMPORAL_SERVER_URL=localhost:7233
TEMPORAL_NAMESPACE=default
WORKFLOW_TASK_QUEUE=default

# Para Temporal Cloud
TEMPORAL_CLOUD_API_KEY=your-api-key
```

### Configuración de Email

El sitio debe tener configuración de email válida con:
- Credenciales IMAP para lectura/escritura
- Configuración SMTP para envío
- Tokens de autenticación almacenados

## Consideraciones de Seguridad

1. **Validación estricta** de emails de bounce para evitar falsos positivos
2. **Eliminación irreversible** de emails - usar con precaución
3. **Logs detallados** para auditoría y debugging
4. **Timeouts** en conexiones IMAP para evitar bloqueos
5. **Límites de procesamiento** para evitar sobrecarga del servidor

## Monitoreo y Logs

### Logs Importantes

- `[DELIVERY_STATUS]` - Procesamiento general
- `[EmailService]` - Operaciones IMAP (fetch/delete)
- `🚫 Iniciando invalidación de lead` - Workflow execution
- `🗑️ Email eliminado permanentemente` - Confirmación de eliminación

### Métricas Recomendadas

- Número de bounces procesados por día
- Tasa de éxito de eliminación de emails
- Tiempo de procesamiento de workflows
- Leads invalidados por bounce vs total

## Troubleshooting

### Problemas Comunes

1. **"Email configuration not found"**
   - Verificar que el sitio tenga configuración de email
   - Confirmar que los tokens están almacenados correctamente

2. **"Connection refused IMAP"**
   - Verificar configuración de servidor IMAP
   - Confirmar puertos y configuraciones de TLS

3. **"Workflow execution failed"**
   - Verificar que Temporal esté ejecutándose
   - Confirmar que el worker tenga el workflow registrado

4. **"Email not found for deletion"**
   - Normal si el email ya fue eliminado manualmente
   - Verificar UIDs en logs para debugging

### Debugging

Activar logs detallados en desarrollo:

```bash
DEBUG=email:*,temporal:*,workflow:* npm run dev
``` 