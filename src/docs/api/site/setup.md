# Site Setup API

## Endpoint: `/api/site/setup`

Esta API ejecuta el workflow `siteSetupWorkflow` utilizando el servicio de ejecución de workflows de Temporal existente en el proyecto. El workflow inicializa todas las configuraciones necesarias para que un sitio recién creado esté operativo.

## Métodos Disponibles

### POST - Ejecutar Setup del Sitio

Inicia el workflow de configuración para un sitio recién creado.

#### URL
```
POST /api/site/setup
```

#### Parámetros del Body (JSON)

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `site_id` | string (UUID) | ✅ | ID del sitio recién creado |
| `user_id` | string (UUID) | ❌ | ID del usuario propietario del sitio |
| `setup_type` | string | ❌ | Tipo de configuración: `basic`, `advanced`, `complete` (default: `basic`) |
| `options` | object | ❌ | Opciones de configuración adicionales |

#### Opciones de Configuración

| Opción | Tipo | Default | Descripción |
|--------|------|---------|-------------|
| `enable_analytics` | boolean | `true` | Habilitar analytics del sitio |
| `enable_chat` | boolean | `true` | Habilitar widget de chat |
| `enable_leads` | boolean | `true` | Habilitar sistema de leads |
| `enable_email_tracking` | boolean | `true` | Habilitar tracking de emails |
| `default_timezone` | string | `"UTC"` | Zona horaria por defecto |
| `default_language` | string | `"es"` | Idioma por defecto |

#### Tipos de Setup

- **`basic`**: Configuración básica del sitio con funcionalidades esenciales
- **`advanced`**: Incluye configuraciones avanzadas y integraciones
- **`complete`**: Setup completo con todas las funcionalidades y configuraciones personalizadas

#### Ejemplo de Request

```json
{
  "site_id": "12345678-1234-1234-1234-123456789012",
  "user_id": "87654321-4321-4321-4321-210987654321",
  "setup_type": "advanced",
  "options": {
    "enable_analytics": true,
    "enable_chat": true,
    "enable_leads": true,
    "enable_email_tracking": true,
    "default_timezone": "America/Mexico_City",
    "default_language": "es"
  }
}
```

#### Respuesta Exitosa (200)

```json
{
  "success": true,
  "data": {
    "workflow_id": "site-setup-12345678-1234-1234-1234-123456789012-1640995200000",
    "execution_id": "execution-abc123",
    "run_id": "run-def456",
    "status": "running",
    "site_id": "12345678-1234-1234-1234-123456789012",
    "setup_type": "advanced",
    "message": "Site setup workflow iniciado exitosamente"
  }
}
```

#### Respuestas de Error

**400 - Bad Request**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "site_id is required"
  }
}
```

**500 - Internal Server Error**
```json
{
  "success": false,
  "error": {
    "code": "WORKFLOW_EXECUTION_ERROR",
    "message": "Error al ejecutar workflow de setup del sitio"
  }
}
```

### GET - Consultar Estado del Workflow

Obtiene el estado actual de un workflow de setup del sitio.

#### URL
```
GET /api/site/setup?workflow_id={WORKFLOW_ID}
```

#### Parámetros de Query

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `workflow_id` | string | ✅ | ID del workflow a consultar |

#### Ejemplo de Request

```bash
GET /api/site/setup?workflow_id=site-setup-12345678-1234-1234-1234-123456789012-1640995200000
```

#### Respuesta Exitosa (200)

```json
{
  "success": true,
  "data": {
    "workflow_id": "site-setup-12345678-1234-1234-1234-123456789012-1640995200000",
    "run_id": "run-def456",
    "status": "completed",
    "message": "Workflow status: completed"
  }
}
```

#### Estados Posibles del Workflow

- `running`: El workflow está ejecutándose
- `completed`: El workflow se completó exitosamente
- `failed`: El workflow falló
- `cancelled`: El workflow fue cancelado
- `timed_out`: El workflow excedió el tiempo límite

## Workflow: siteSetupWorkflow

### Actividades Ejecutadas

El workflow `siteSetupWorkflow` ejecuta las siguientes actividades según el tipo de setup:

#### Setup Básico (`basic`)
1. ✅ Crear configuración básica del sitio
2. ✅ Configurar analytics (si está habilitado)
3. ✅ Configurar chat widget (si está habilitado)
4. ✅ Configurar sistema de leads (si está habilitado)
5. ✅ Configurar tracking de emails (si está habilitado)
6. ✅ Marcar el sitio como configurado
7. ✅ Enviar notificación de completado (si hay user_id)

#### Setup Avanzado (`advanced`)
Incluye todas las actividades del setup básico más:
8. ✅ Configurar funcionalidades avanzadas
9. ✅ Configurar ajustes de SEO
10. ✅ Configurar integraciones

#### Setup Completo (`complete`)
Incluye todas las actividades del setup avanzado más:
11. ✅ Configurar branding personalizado
12. ✅ Configurar analytics avanzados
13. ✅ Configurar acceso a API

### Variables de Entorno

El workflow utiliza las siguientes variables de entorno:

```bash
# Cola de tareas para workflows (opcional, default: 'site-setup-queue')
WORKFLOW_TASK_QUEUE=site-setup-queue

# Configuración de Temporal (heredada del WorkflowService)
TEMPORAL_SERVER_URL=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_CLOUD_API_KEY=your-api-key # Solo para Temporal Cloud
```

## Casos de Uso

### 1. Setup Básico de Sitio Nuevo

```bash
curl -X POST /api/site/setup \
  -H "Content-Type: application/json" \
  -d '{
    "site_id": "12345678-1234-1234-1234-123456789012",
    "user_id": "87654321-4321-4321-4321-210987654321"
  }'
```

### 2. Setup Avanzado con Configuraciones Personalizadas

```bash
curl -X POST /api/site/setup \
  -H "Content-Type: application/json" \
  -d '{
    "site_id": "12345678-1234-1234-1234-123456789012",
    "user_id": "87654321-4321-4321-4321-210987654321",
    "setup_type": "advanced",
    "options": {
      "enable_analytics": true,
      "enable_chat": false,
      "default_timezone": "America/New_York",
      "default_language": "en"
    }
  }'
```

### 3. Consultar Estado del Setup

```bash
curl -X GET "/api/site/setup?workflow_id=site-setup-12345678-1234-1234-1234-123456789012-1640995200000"
```

## Integración con Temporal

Esta API utiliza el `WorkflowService` existente que:

- ✅ Se conecta directamente al servidor de Temporal
- ✅ Soporta tanto Temporal local como Temporal Cloud
- ✅ Maneja automáticamente reintentos y errores
- ✅ Proporciona monitoreo del estado de workflows
- ✅ Mantiene el patrón singleton para eficiencia

## Logging

El endpoint proporciona logging detallado para depuración:

```bash
🏗️ Iniciando setup del sitio: 12345678-1234-1234-1234-123456789012
👤 Usuario: 87654321-4321-4321-4321-210987654321
🔧 Tipo de setup: advanced
🔄 Ejecutando workflow siteSetupWorkflow con ID: site-setup-12345678-1234-1234-1234-123456789012-1640995200000
✅ Workflow de setup del sitio iniciado exitosamente
🆔 Workflow ID: site-setup-12345678-1234-1234-1234-123456789012-1640995200000
🏃 Run ID: run-def456
```

## Testing

Para ejecutar los tests del endpoint:

```bash
npm test -- --testPathPattern=site/setup.test.ts
```

Los tests cubren:
- ✅ Ejecución exitosa del workflow
- ✅ Validación de parámetros requeridos
- ✅ Validación de UUIDs
- ✅ Manejo de errores del workflow
- ✅ Diferentes tipos de setup
- ✅ Consulta de estado del workflow 