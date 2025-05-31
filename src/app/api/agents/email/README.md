# Email Analysis API with Customer Support Scheduling

Este endpoint analiza emails entrantes y automáticamente programa workflows de customer support basados en los resultados del análisis.

## Funcionalidad

### 1. Análisis de Emails
- Obtiene emails desde la configuración del sitio
- Analiza el contenido usando IA para determinar:
  - Sentimiento (positivo, negativo, neutral)
  - Prioridad (alta, media, baja)
  - Oportunidades comerciales
  - Información de contacto
  - Intención del cliente

### 2. Programación Automática de Customer Support
- Después del análisis, automáticamente programa un workflow de Temporal
- El workflow incluye:
  - Todos los datos de análisis
  - ID del sitio
  - ID del usuario
  - Información para crear tareas de seguimiento
  - Programación de notificaciones según prioridad

## Endpoint

```
POST /api/agents/email
```

### Parámetros

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `site_id` | string | Sí | ID del sitio |
| `limit` | number | No | Límite de emails a procesar (default: 10) |
| `user_id` | string | No | ID del usuario |
| `team_member_id` | string | No | ID del miembro del equipo |
| `agentId` | string | No | ID del agente (se busca automáticamente si no se proporciona) |
| `analysis_type` | string | No | Tipo de análisis específico |
| `since_date` | string | No | Fecha desde la cual obtener emails (ISO format) |

### Ejemplo de Request

```json
{
  "site_id": "12345678-1234-1234-1234-123456789012",
  "limit": 20,
  "user_id": "87654321-4321-4321-4321-210987654321",
  "analysis_type": "commercial_opportunity"
}
```

### Ejemplo de Response

```json
{
  "success": true,
  "data": {
    "commandId": "cmd_12345",
    "status": "processing",
    "message": "Comando creado con éxito",
    "emailCount": 15
  }
}
```

## Flujo de Trabajo

1. **Validación**: Se validan los parámetros de entrada
2. **Configuración**: Se obtiene la configuración de email del sitio
3. **Obtención**: Se descargan los emails según los criterios
4. **Análisis**: Se crea un comando para analizar los emails
5. **Procesamiento Asíncrono**: 
   - El comando se procesa en background
   - Se espera la finalización del análisis
   - Se extraen los datos de análisis
   - Se programa automáticamente el workflow de customer support en Temporal

## Integración con Temporal

### Workflow Programado
- **Nombre**: `scheduleCustomerSupport`
- **Parámetros**: `ScheduleCustomerSupportParams`
  - `analysisArray`: Array de datos de análisis
  - `site_id`: ID del sitio
  - `userId`: ID del usuario (requerido)

### Datos de Análisis Incluidos

Cada análisis incluye:

```typescript
interface AnalysisData {
  summary: string;
  insights: string[];
  sentiment: "positive" | "negative" | "neutral";
  priority: "high" | "medium" | "low";
  action_items: string[];
  response: string[];
  lead_extraction: {
    contact_info: {
      name: string | null;
      email: string | null;
      phone: string | null;
      company: string | null;
    };
    intent: "inquiry" | "complaint" | "purchase" | "support" | "partnership" | "demo_request";
    requirements: string[];
    budget_indication: string | null;
    timeline: string | null;
    decision_maker: "yes" | "no" | "unknown";
    source: "website" | "referral" | "social_media" | "advertising" | "cold_outreach";
  };
  commercial_opportunity: {
    requires_response: boolean;
    response_type: "commercial" | "support" | "informational" | "follow_up";
    priority_level: "high" | "medium" | "low";
    suggested_actions: string[];
    potential_value: "high" | "medium" | "low" | "unknown";
    next_steps: string[];
  };
}
```

## Configuración Requerida

### Variables de Entorno
```bash
# Temporal Configuration
TEMPORAL_SERVER_URL=localhost:7233
TEMPORAL_NAMESPACE=default
WORKFLOW_TASK_QUEUE=default

# Para Temporal Cloud
TEMPORAL_CLOUD_API_KEY=your_api_key
```

### Servicios Dependientes
1. **EmailConfigService**: Para obtener configuración SMTP del sitio
2. **EmailService**: Para descargar emails
3. **WorkflowService**: Para programar workflows en Temporal
4. **CommandService**: Para gestionar comandos de análisis

## Manejo de Errores

El endpoint maneja varios tipos de errores:

- `INVALID_REQUEST`: Parámetros inválidos
- `EMAIL_CONFIG_NOT_FOUND`: No se encontró configuración de email
- `EMAIL_FETCH_ERROR`: Error al obtener emails
- `AGENT_NOT_FOUND`: No se encontró agente de soporte
- `SYSTEM_ERROR`: Error interno del sistema

## Notas Importantes

1. **Ejecución Asíncrona**: La programación de customer support se ejecuta en background para no bloquear la respuesta del API
2. **Timeout**: El proceso de espera del comando tiene un timeout de 5 minutos
3. **Logging**: Se registra toda la actividad para debugging y monitoreo
4. **Validación de UUID**: Todos los IDs se validan antes de usar
5. **Fallbacks**: Se usan valores por defecto cuando no se proporcionan ciertos parámetros 