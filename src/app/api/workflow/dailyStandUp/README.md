# Daily Standup Workflow API

API endpoint para ejecutar el workflow completo de daily standup del CMO que analiza múltiples aspectos del negocio y genera un resumen ejecutivo consolidado.

## Endpoint

```
POST /api/workflow/dailyStandUp
```

## Descripción

Este workflow ejecuta un análisis completo diario que incluye:

1. **System Analysis** - Configuración del sitio, estado de billing y métricas básicas del sistema
2. **Sales Analysis** - Nuevos leads, comandos de ventas activos y conversaciones de ventas 
3. **Support Analysis** - Tareas abiertas, conversaciones de soporte y requerimientos pendientes
4. **Growth Analysis** - Contenido reciente, experimentos activos y campañas en ejecución
5. **Executive Summary** - Consolidación de todos los análisis con plan de acción

## Parámetros de Entrada

### Body (JSON)

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `site_id` | string (UUID) | ✅ | ID del sitio para el cual ejecutar el daily standup |

### Ejemplo de Request

```bash
curl -X POST https://api.example.com/api/workflow/dailyStandUp \
  -H "Content-Type: application/json" \
  -d '{
    "site_id": "12345678-1234-1234-1234-123456789012"
  }'
```

## Respuesta

### Respuesta Exitosa (200)

```json
{
  "success": true,
  "data": {
    "site_id": "12345678-1234-1234-1234-123456789012",
    "workflowId": "daily-standup-12345678-1234-1234-1234-123456789012-1703123456789-abc123",
    "executionId": "run-id-12345",
    "runId": "run-id-12345",
    "status": "completed",
    "total_duration": 45000,
    "analyses": {
      "system": {
        "command_id": "uuid-system-command",
        "summary": "System is healthy. 95% uptime, billing current, 1,250 active sessions.",
        "success": true
      },
      "sales": {
        "command_id": "uuid-sales-command", 
        "summary": "15 new leads, 8 active sales conversations, $45K pipeline value.",
        "success": true
      },
      "support": {
        "command_id": "uuid-support-command",
        "summary": "12 open tasks, avg response time 2.5h, 3 escalated issues.",
        "success": true
      },
      "growth": {
        "command_id": "uuid-growth-command",
        "summary": "5 content pieces published, 3 experiments running, 12% conversion rate improvement.",
        "success": true
      }
    },
    "executive_summary": {
      "command_id": "uuid-executive-command",
      "summary": "Strong performance across all departments. Focus on support escalations and sales pipeline acceleration.",
      "action_plan": {
        "immediate": ["Review escalated support issues", "Accelerate high-value sales opportunities"],
        "this_week": ["Implement support process improvements", "Launch additional growth experiments"],
        "strategic": ["Scale successful growth initiatives", "Optimize support workflows"]
      },
      "key_insights": {
        "opportunities": ["Growth experiments showing strong results", "Sales pipeline healthy"],
        "concerns": ["Support response times increasing", "3 escalated issues require attention"],
        "metrics": {"overall_health": "85%", "growth_trajectory": "positive"}
      },
      "coverage_score": "100% - All departments analyzed",
      "success": true
    },
    "errors": [],
    "completion_rate": "4/4 analyses completed"
  }
}
```

### Respuesta de Error (400/500)

```json
{
  "success": false,
  "error": {
    "code": "INVALID_SITE_ID",
    "message": "site_id es requerido y debe ser una cadena válida"
  }
}
```

## Códigos de Error

| Código | Descripción |
|--------|-------------|
| `INVALID_SITE_ID` | El site_id no fue proporcionado o no es válido |
| `INVALID_UUID_FORMAT` | El site_id no tiene formato de UUID válido |
| `WORKFLOW_EXECUTION_ERROR` | Error durante la ejecución del workflow en Temporal |
| `INTERNAL_SERVER_ERROR` | Error interno del servidor |

## Detalles del Workflow

### Temporal Workflow

El workflow se ejecuta en Temporal con las siguientes características:

- **Workflow Name**: `dailyStandupWorkflow`
- **Task Queue**: Configurable via `WORKFLOW_TASK_QUEUE` (default: "default")
- **Priority**: High (análisis ejecutivo diario)
- **Retry Policy**: 2 intentos máximo
- **Execution Mode**: Síncrono (espera resultado completo)

### Pasos del Workflow

1. **Análisis del Sistema** (`/api/agents/cmo/dailyStandUp/system`)
   - Configuración del sitio y estado general
   - Métricas de billing y subscripciones  
   - Actividad y rendimiento del sistema

2. **Análisis de Ventas** (`/api/agents/cmo/dailyStandUp/sales`)
   - Nuevos leads y oportunidades
   - Estado de comandos de ventas activos
   - Rendimiento de conversaciones de ventas

3. **Análisis de Soporte** (`/api/agents/cmo/dailyStandUp/support`)
   - Tareas abiertas y su prioridad
   - Conversaciones de soporte activas
   - Requerimientos pendientes

4. **Análisis de Crecimiento** (`/api/agents/cmo/dailyStandUp/growth`)
   - Contenido publicado recientemente
   - Experimentos y A/B tests activos
   - Rendimiento de campañas

5. **Resumen Ejecutivo** (`/api/agents/cmo/dailyStandUp/wrapUp`)
   - Consolidación de todos los análisis
   - Identificación de patrones transversales
   - Plan de acción con prioridades
   - Métricas clave y insights estratégicos

### Almacenamiento de Datos

Cada paso del workflow guarda su análisis en la tabla `agent_memory` con:

- **Memory Types**: 
  - `daily_standup_system`
  - `daily_standup_sales`
  - `daily_standup_support` 
  - `daily_standup_growth`
  - `daily_standup_executive`

- **Command ID**: Cada análisis genera un command_id único
- **Site Association**: Todos los resultados se asocian al site_id proporcionado

## Información de Contacto y Debugging

Para debugging o información adicional sobre el workflow:

```bash
# Ver información del endpoint
curl -X GET https://api.example.com/api/workflow/dailyStandUp
```

El endpoint GET devuelve metadatos sobre la funcionalidad, parámetros esperados y estructura de respuesta.

## Notas Importantes

1. **Duración**: El workflow completo puede tomar 30-60 segundos en completarse
2. **Frecuencia**: Diseñado para ejecutarse una vez por día por sitio
3. **Dependencias**: Requiere agente CMO activo para el sitio
4. **Temporal**: Requiere conexión activa a Temporal Cloud/Server
5. **Base de Datos**: Usa Supabase para persistir resultados y consultar datos 