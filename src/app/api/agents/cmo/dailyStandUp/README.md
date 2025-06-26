# CMO Daily StandUp System

Este sistema permite al CMO (Chief Marketing Officer) realizar un análisis diario completo de todos los aspectos del negocio a través de múltiples endpoints especializados.

## Estructura de Rutas

### 1. `/system` - Análisis del Sistema
- **Función**: Revisa configuraciones, billing y métricas básicas del sistema
- **Datos analizados**: 
  - Configuración del sitio
  - Estado de suscripción y billing
  - Métricas de actividad (últimas 24h)
- **Retorna**: `command_id` y `summary` del análisis del sistema

### 2. `/sales` - Análisis de Ventas
- **Función**: Analiza performance de ventas y coordina con el agente de ventas
- **Datos analizados**:
  - Nuevos leads creados
  - Comandos de ventas activos
  - Conversaciones de ventas recientes
  - Estado del agente de ventas
- **Retorna**: `command_id` y `summary` del análisis de ventas

### 3. `/support` - Análisis de Soporte
- **Función**: Revisa tareas de soporte y conversaciones recientes
- **Datos analizados**:
  - Tareas abiertas
  - Conversaciones de soporte activas
  - Requerimientos pendientes
  - Estado del agente de soporte
- **Retorna**: `command_id` y `summary` del análisis de soporte

### 4. `/growth` - Análisis de Crecimiento
- **Función**: Analiza contenido, experimentos y campañas de crecimiento
- **Datos analizados**:
  - Contenido creado recientemente
  - Experimentos activos
  - Campañas en ejecución
  - Análisis de sitio recientes
- **Retorna**: `command_id` y `summary` del análisis de crecimiento

### 5. `/wrapUp` - Resumen Ejecutivo
- **Función**: Consolida todas las memorias de análisis previos
- **Datos analizados**:
  - Memorias del agente de todos los análisis
  - Comandos completados del standup
  - Insights cross-departamentales
- **Retorna**: `command_id`, `summary`, `action_plan` y `key_insights`

## Flujo de Trabajo

### Ejecución Individual
Cada ruta puede ejecutarse independientemente:

```bash
POST /api/agents/cmo/dailyStandUp/system
POST /api/agents/cmo/dailyStandUp/sales
POST /api/agents/cmo/dailyStandUp/support  
POST /api/agents/cmo/dailyStandUp/growth
POST /api/agents/cmo/dailyStandUp/wrapUp
```

### Parámetros Requeridos
- `site_id`: UUID del sitio a analizar
- `command_id`: (opcional) ID del comando padre para tracking

### Ejecución Coordinada
Para ejecutar el flujo completo de daily standup, se recomienda usar un workflow de Temporal que:

1. Ejecute system, sales, support y growth en paralelo
2. Recopile todos los `command_id` resultantes
3. Ejecute wrapUp con los `command_ids` para el resumen final

## Persistencia de Datos

Cada análisis guarda sus resultados en:
- **agent_memory**: Con el `command_id` y tipo específico
- **commands**: Estado y resultados del comando ejecutado

## Tipos de Memoria

- `daily_standup_system`
- `daily_standup_sales` 
- `daily_standup_support`
- `daily_standup_growth`
- `daily_standup_executive`

## Respuesta Estándar

Todas las rutas retornan:

```json
{
  "success": true,
  "data": {
    "command_id": "uuid",
    "summary": "string",
    "analysis_type": "string",
    "[specific]_data": { /* datos específicos del análisis */ }
  }
}
```

## Manejo de Errores

Posibles códigos de error:
- `INVALID_REQUEST`: Parámetros inválidos
- `AGENT_NOT_FOUND`: No se encontró agente CMO activo
- `DATA_ERROR`: Error al obtener datos
- `COMMAND_EXECUTION_FAILED`: Comando no completado exitosamente
- `INTERNAL_SERVER_ERROR`: Error interno del servidor 