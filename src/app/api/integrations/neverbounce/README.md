# NeverBounce Integration

Esta integración permite validar direcciones de email utilizando el servicio de NeverBounce para verificar si una dirección de email es válida, existe y puede recibir correos.

## Estructura

- `validate/route.ts`: Endpoint para validar direcciones de email individuales

## Requisitos

Para utilizar esta integración, necesitas:

1. Una cuenta de NeverBounce
2. Una clave API de NeverBounce
3. Variable de entorno configurada

## Variables de Entorno

Añade esta variable a tu archivo `.env`:

```
NEVER_BOUNCE_API_KEY=tu_api_key_de_neverbounce
```

## Instalación

Instala el paquete de NeverBounce:

```bash
npm install neverbounce --save
```

## Uso del API

### Validar una dirección de email

```http
POST /api/integrations/neverbounce/validate
Content-Type: application/json

{
  "email": "support@neverbounce.com"
}
```

**Respuesta:**
```json
{
  "email": "support@neverbounce.com",
  "isValid": true,
  "result": "valid",
  "flags": [],
  "suggested_correction": null,
  "execution_time": 245,
  "message": "Email is valid"
}
```

### Obtener información del servicio

```http
GET /api/integrations/neverbounce/validate
```

**Respuesta:**
```json
{
  "service": "NeverBounce Email Validation",
  "version": "1.0.0",
  "description": "Validate email addresses using NeverBounce API",
  "endpoints": {
    "validate": {
      "method": "POST",
      "path": "/api/integrations/neverbounce/validate",
      "description": "Validate a single email address",
      "body": {
        "email": "string (required) - Email address to validate"
      }
    }
  },
  "status": "configured"
}
```

## Tipos de Resultados

NeverBounce puede devolver los siguientes resultados:

- **`valid`**: La dirección de email es válida y puede recibir correos
- **`invalid`**: La dirección de email no es válida
- **`disposable`**: La dirección de email es de un servicio de email temporal/desechable
- **`catchall`**: El dominio acepta todos los emails enviados a él
- **`unknown`**: No se pudo determinar la validez del email

## Flags Adicionales

NeverBounce puede proporcionar flags adicionales como:

- `has_dns`: El dominio tiene registros DNS válidos
- `has_dns_mx`: El dominio tiene registros MX válidos
- `smtp_connectable`: Se puede conectar al servidor SMTP
- `deliverable`: El email es entregable
- `free_email_host`: Es un proveedor de email gratuito
- `role_account`: Es una cuenta de rol (info@, admin@, etc.)

## Manejo de Errores

La API maneja varios tipos de errores:

### Errores de Cliente (4xx)
- **400**: Email faltante o formato inválido
- **401**: Clave API inválida o no configurada

### Errores de Servidor (5xx)
- **429**: Cuota de API excedida
- **500**: Error interno del servidor
- **503**: Servicio temporalmente no disponible

### Ejemplo de Error
```json
{
  "error": "Email is required",
  "message": "Please provide an email address to validate"
}
```

## Limitaciones

- La API de NeverBounce tiene límites de cuota según tu plan
- Algunos dominios pueden tomar más tiempo en validarse
- Los resultados `unknown` pueden ocurrir cuando el servidor de email de destino no responde

## Casos de Uso

Esta integración es útil para:

1. **Validación de formularios**: Verificar emails antes de guardarlos en la base de datos
2. **Limpieza de listas**: Validar listas de emails existentes
3. **Mejora de deliverability**: Evitar enviar emails a direcciones inválidas
4. **Reducción de rebotes**: Prevenir emails devueltos

## Ejemplo de Implementación

```javascript
// Validar email antes de registrar usuario
const validateEmail = async (email) => {
  try {
    const response = await fetch('/api/integrations/neverbounce/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email })
    });
    
    const result = await response.json();
    
    if (result.isValid) {
      console.log('Email válido:', email);
      // Proceder con el registro
    } else {
      console.log('Email inválido:', result.message);
      // Mostrar error al usuario
      if (result.suggested_correction) {
        console.log('Sugerencia:', result.suggested_correction);
      }
    }
  } catch (error) {
    console.error('Error validando email:', error);
  }
};
```

## Seguridad

- ✅ **Validación de entrada**: Se valida el formato básico del email antes de enviarlo a NeverBounce
- ✅ **Manejo de credenciales**: La API key se maneja como variable de entorno
- ✅ **Control de errores**: Se manejan todos los tipos de errores posibles
- ✅ **Logs de debugging**: Se registran las operaciones para monitoreo

## Testing

Para probar la integración:

1. Configura la variable de entorno `NEVER_BOUNCE_API_KEY`
2. Envía una petición POST con un email válido
3. Verifica que la respuesta contenga los campos esperados
4. Prueba con diferentes tipos de emails (válidos, inválidos, desechables)