# API Key Authentication

Este documento describe el sistema de autenticación de API keys implementado en la API.

> Para los límites actuales de servicio interno verificado, precedencia de
> credenciales y exclusiones de rutas, ver
> [SERVICE_EXPENSIVE_RATE_LIMITS.md](SERVICE_EXPENSIVE_RATE_LIMITS.md).
> En rutas privadas expensive: 600/min de servicio, sujeto además a 5.000/min de
> autenticación de servicio y al global compartido de 2.000/min. CORS no es
> autenticación: un origen permitido nunca sustituye una credencial válida.

## Resumen

La API aplica dos controles independientes:

1. **CORS** - Restringe orígenes de navegador; no autentica al solicitante.
2. **Autenticación** - Valida API keys o sesiones de usuario admitidas por la ruta,
   tanto con `origin` como sin él. Las rutas públicas y webhooks mantienen sus
   contratos específicos de autorización.

## Flujo de Autenticación

### Peticiones desde Navegadores

Si la petición incluye un header `origin`, se valida mediante CORS:
- En desarrollo: Se permiten todos los orígenes
- En producción: Solo se permiten orígenes configurados en `cors.config.js`

Una petición a una ruta privada sigue necesitando autenticación válida después
de CORS. No se deben enviar claves de servicio desde el navegador.

### Peticiones Servidor-a-Servidor

Para peticiones autenticadas mediante API key, con o sin `origin` y también en desarrollo:

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
- Los scopes requeridos se determinan en el servidor según ruta y método.
  El header `x-required-scope` enviado por el cliente no concede permisos.

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

1. **Autenticación en todos los entornos**: Desarrollo no omite la validación de API keys.
2. **CORS independiente**: Un origen permitido no sustituye la autenticación.
3. **Service Key Primero**: El `SERVICE_API_KEY` se valida antes que las keys de BD
4. **Información en Request**: Los datos de la API key validada se añaden al header `x-api-key-data`

## Endpoint de Status

`GET /api/status` es público: permite comprobar disponibilidad, pero un 200 sin
credenciales no demuestra autenticación. Para validar permisos, usa las pruebas
de middleware indicadas en la documentación de límites.

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