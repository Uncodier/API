# API Key Authentication

Este documento describe el sistema de autenticación de API keys implementado en la API.

## Resumen

La API utiliza un sistema dual de autenticación:

1. **CORS** - Para peticiones desde navegadores (con header `origin`)
2. **API Keys** - Para peticiones servidor-a-servidor (sin header `origin`)

## Flujo de Autenticación

### Peticiones desde Navegadores

Si la petición incluye un header `origin`, se valida mediante CORS:
- En desarrollo: Se permiten todos los orígenes
- En producción: Solo se permiten orígenes configurados en `cors.config.js`

### Peticiones Servidor-a-Servidor

Si la petición NO incluye header `origin` y estamos en producción:

1. Se busca el API key en los siguientes headers (en orden):
   - `x-api-key`
   - `authorization` (soporta formato `Bearer <apikey>` o directamente el API key)

2. Se valida el API key:
   - Primero se compara contra `SERVICE_API_KEY` (variable de entorno)
   - Si no coincide, se valida contra la base de datos

## Configuración

### Variables de Entorno

```bash
# API Key de servicio para comunicación interna
# Esta clave permite acceso completo a la API desde servicios internos
SERVICE_API_KEY=your_internal_service_api_key_here
```

### API Key de Servicio

El `SERVICE_API_KEY` es una clave especial que:
- Permite acceso completo a la API (todos los scopes)
- No requiere validación en base de datos
- Ideal para servicios internos o del intranet
- Se valida antes que las API keys de la base de datos

## Uso

### Petición con API Key de Servicio

```bash
curl -X GET https://api.example.com/api/endpoint \
  -H "x-api-key: your_service_api_key"

# O usando Authorization header
curl -X GET https://api.example.com/api/endpoint \
  -H "Authorization: Bearer your_service_api_key"
```

### Petición con API Key de Base de Datos

```bash
curl -X GET https://api.example.com/api/endpoint \
  -H "x-api-key: user_api_key_from_database"
```

## Scopes

- Las API keys de servicio tienen acceso completo (scope: `*`)
- Las API keys de base de datos tienen scopes específicos
- Se puede requerir un scope específico usando el header `x-required-scope`

## Errores

### Sin API Key
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "API key is required for server-to-server requests"
  }
}
```

### API Key Inválida
```json
{
  "success": false,
  "error": {
    "code": "INVALID_API_KEY",
    "message": "Invalid or expired API key"
  }
}
```

### Scope Insuficiente
```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_SCOPE",
    "message": "This operation requires the 'write' scope"
  }
}
```

## Notas Importantes

1. **Solo en Producción**: La validación de API keys solo ocurre en producción
2. **Prioridad CORS**: Si hay un header `origin`, siempre se usa CORS
3. **Service Key Primero**: El `SERVICE_API_KEY` se valida antes que las keys de BD
4. **Información en Request**: Los datos de la API key validada se añaden al header `x-api-key-data`

## Endpoint de Status

Para probar la autenticación y verificar el estado del servidor, usa el endpoint `/api/status`:

### Petición desde Navegador (CORS)
```bash
# La petición incluirá automáticamente el header origin
curl -X GET https://api.example.com/api/status
```

### Petición con API Key
```bash
# Con x-api-key
curl -X GET https://api.example.com/api/status \
  -H "x-api-key: your_api_key"

# Con Authorization
curl -X GET https://api.example.com/api/status \
  -H "Authorization: Bearer your_api_key"
```

### Respuesta Ejemplo
```json
{
  "success": true,
  "server": {
    "status": "healthy",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "environment": "production",
    "nodeVersion": "v18.17.0",
    "responseTimeMs": 45
  },
  "authentication": {
    "origin": "none",
    "hasApiKey": true,
    "authMethod": "API_KEY",
    "apiKeyInfo": {
      "id": "service-key",
      "name": "Internal Service Key",
      "scopes": ["*"],
      "isService": true
    }
  },
  "services": {
    "database": {
      "connected": true,
      "responseTime": "OK"
    }
  },
  "environment": {
    "hasSupabaseUrl": true,
    "hasSupabaseKey": true,
    "hasEncryptionKey": true,
    "hasServiceApiKey": true
  }
}
```

El endpoint retorna:
- **200 OK**: Si todo está funcionando correctamente
- **503 Service Unavailable**: Si hay problemas con servicios críticos 