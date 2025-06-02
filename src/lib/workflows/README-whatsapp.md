# Workflows de WhatsApp con Temporal

Este archivo contiene los workflows específicos para el procesamiento de mensajes de WhatsApp utilizando Temporal.io.

## Workflows Disponibles

### 1. `answerWhatsappMessageWorkflow`

Workflow principal para procesar y responder mensajes de WhatsApp de forma automática.

#### Parámetros

```typescript
interface WhatsAppMessageWorkflowArgs {
  phoneNumber: string;        // Número de teléfono del remitente
  messageContent: string;     // Contenido del mensaje
  businessAccountId: string;  // ID de la cuenta de negocio (Twilio/WhatsApp)
  messageId: string;          // ID único del mensaje
  conversationId: string;     // ID de la conversación
  agentId: string;           // ID del agente que procesará el mensaje
  siteId: string;            // ID del sitio
  visitorId?: string;        // ID del visitante (opcional)
  leadId?: string;           // ID del lead (opcional)
}
```

#### Actividades Incluidas

1. **Análisis de Contexto**: Analiza el contenido y contexto del mensaje
2. **Búsqueda en Base de Conocimiento**: Busca información relevante
3. **Lookup de Información de Contacto**: Obtiene datos del contacto
4. **Generación de Respuesta**: Usa el agente IA para generar respuesta
5. **Envío de Respuesta**: Envía la respuesta por WhatsApp
6. **Guardado en Base de Datos**: Almacena la respuesta
7. **Actualización de Métricas**: Actualiza estadísticas de conversación

#### Ejemplo de Uso

```typescript
import { WorkflowService } from '@/lib/services/workflow-service';

const workflowService = WorkflowService.getInstance();

const result = await workflowService.answerWhatsappMessage({
  phoneNumber: '+1234567890',
  messageContent: 'Hola, necesito ayuda con mi pedido',
  businessAccountId: 'twilio-account-123',
  messageId: 'msg_abc123',
  conversationId: 'conv_def456',
  agentId: 'agent-whatsapp-789',
  siteId: 'site-test-123',
  visitorId: 'visitor_xyz789'
});

if (result.success) {
  console.log(`Workflow iniciado: ${result.workflowId}`);
} else {
  console.error('Error:', result.error);
}
```

### 2. `analyzeWhatsappMessagesWorkflow`

Workflow para analizar múltiples mensajes de WhatsApp y extraer insights.

#### Parámetros

```typescript
interface AnalyzeWhatsAppMessagesArgs {
  messageIds: string[];      // IDs de los mensajes a analizar
  phoneNumber: string;       // Número de teléfono asociado
  conversationId: string;    // ID de la conversación
  agentId: string;          // ID del agente analizador
  siteId: string;           // ID del sitio
  teamMemberId?: string;    // ID del miembro del equipo (opcional)
  analysisType?: string;    // Tipo de análisis (opcional)
  leadId?: string;          // ID del lead (opcional)
}
```

#### Actividades Incluidas

1. **Obtención de Mensajes**: Extrae mensajes de la base de datos
2. **Análisis de Sentimiento**: Analiza el sentimiento de los mensajes
3. **Extracción de Leads**: Identifica información de leads potenciales
4. **Identificación de Oportunidades**: Detecta oportunidades comerciales
5. **Generación de Reporte**: Crea reporte de análisis completo
6. **Actualización de Lead**: Actualiza información del lead si existe

## Integración con Twilio

### Webhook Configuration

La ruta `/api/agents/whatsapp/route.ts` está configurada para recibir webhooks de Twilio WhatsApp.

#### URL del Webhook

```
POST /api/agents/whatsapp?site_id={SITE_ID}&agent_id={AGENT_ID}
```

#### Parámetros Requeridos

- `site_id`: ID del sitio (UUID)
- `agent_id`: ID del agente que procesará los mensajes (UUID)

#### Formato de Datos de Twilio

Twilio envía datos como `application/x-www-form-urlencoded`:

```
MessageSid: "SM1234567890abcdef1234567890abcdef"
AccountSid: "AC1234567890abcdef1234567890abcdef"
From: "whatsapp:+1234567890"
To: "whatsapp:+0987654321"
Body: "Hola, necesito ayuda"
WaId: "1234567890"
ProfileName: "Juan Pérez"
```

### Configuración en Twilio Console

1. Ve a la consola de Twilio
2. Navega a Messaging > Services > WhatsApp senders
3. Configura el webhook URL apuntando a tu endpoint
4. Asegúrate de incluir los parámetros `site_id` y `agent_id`

## Variables de Entorno

### Temporal Configuration

```bash
TEMPORAL_SERVER_URL=localhost:7233
TEMPORAL_NAMESPACE=default
WORKFLOW_TASK_QUEUE=default

# Para Temporal Cloud
TEMPORAL_CLOUD_API_KEY=your-api-key
```

### Twilio Configuration

```bash
TWILIO_ACCOUNT_SID=your-account-sid
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_WHATSAPP_NUMBER=whatsapp:+1234567890
```

## Worker Configuration

Para que los workflows funcionen, necesitas configurar un worker de Temporal:

```typescript
// worker.ts
import { Worker } from '@temporalio/worker';

async function runWorker() {
  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows/whatsapp-workflows'),
    activitiesPath: require.resolve('./activities/whatsapp-activities'),
    taskQueue: 'whatsapp-task-queue',
  });
  
  await worker.run();
}

runWorker().catch(console.error);
```

## Actividades Requeridas

Debes implementar las siguientes actividades en tu worker:

### Análisis y Contexto
- `analyzeMessageContextActivity`
- `searchKnowledgeBaseActivity`
- `lookupContactInformationActivity`

### Generación de Respuesta
- `generateAgentResponseActivity`
- `sendWhatsAppMessageActivity`
- `saveAgentResponseActivity`

### Métricas y Logging
- `updateConversationMetricsActivity`
- `logWhatsAppErrorActivity`

### Análisis de Múltiples Mensajes
- `getMessagesActivity`
- `analyzeSentimentActivity`
- `extractLeadInformationActivity`
- `identifyCommercialOpportunitiesActivity`
- `generateAnalysisReportActivity`
- `updateLeadActivity`

## Estructura de Respuesta

### Workflow Success Response

```typescript
{
  success: true,
  messageId: "wa_response_1234567890",
  phoneNumber: "+1234567890",
  conversationId: "conv_def456",
  agentId: "agent-whatsapp-789",
  timestamp: "2024-01-15T10:30:00.000Z"
}
```

### Error Handling

Los workflows están diseñados para manejar errores de forma robusta:

- Reintentos automáticos en caso de fallas temporales
- Logging detallado de errores
- Respuestas de fallback en caso de falla del agente
- Notificaciones al equipo en caso de errores críticos

## Testing

Ejecuta los tests con:

```bash
npm test src/__tests__/services/workflow-service.test.ts
```

Los tests incluyen:
- Validación de parámetros requeridos
- Configuración personalizada de workflows
- Manejo de errores de conexión
- Argumentos opcionales

## Troubleshooting

### Problemas Comunes

1. **Error de conexión a Temporal**
   - Verifica que el servidor de Temporal esté ejecutándose
   - Revisa las variables de entorno `TEMPORAL_SERVER_URL` y `TEMPORAL_NAMESPACE`

2. **Webhook no recibe datos**
   - Verifica la configuración en Twilio Console
   - Revisa que la URL del webhook sea accesible públicamente
   - Confirma que los parámetros `site_id` y `agent_id` sean válidos

3. **Worker no procesa workflows**
   - Asegúrate de que el worker esté ejecutándose
   - Verifica que el `taskQueue` coincida entre el cliente y el worker
   - Revisa los logs del worker para errores de actividades

4. **Respuestas no se envían**
   - Verifica la configuración de WhatsApp API
   - Revisa los permisos de la aplicación de WhatsApp Business
   - Confirma que el número de teléfono esté verificado 