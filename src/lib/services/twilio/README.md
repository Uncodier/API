# TwilioValidationService

Este servicio se encarga de validar las peticiones de webhook de Twilio usando su sistema de firmas criptográficas. Implementa la validación de seguridad recomendada por Twilio para asegurar que las peticiones realmente provienen de sus servidores.

## Cómo funciona

### 1. Validación de Firma

Twilio envía un header `X-Twilio-Signature` con cada webhook que contiene una firma HMAC-SHA1. Esta firma se calcula usando:

- La URL completa del webhook (incluyendo parámetros de consulta)
- Los datos del POST ordenados alfabéticamente por clave
- El Auth Token de Twilio como clave secreta

### 2. Búsqueda de Auth Token

El servicio busca el Auth Token en la tabla `secure_tokens` usando:

- `site_id`: El ID del sitio
- `token_type`: `'twilio_whatsapp'`
- `identifier`: Debe contener el número de WhatsApp (usando LIKE)

### 3. Desencriptación

El Auth Token se almacena encriptado en la base de datos usando la misma lógica que otros tokens del sistema.

## Configuración en secure_tokens

Para que la validación funcione, necesitas crear un registro en `secure_tokens`:

```sql
INSERT INTO secure_tokens (
  site_id,
  token_type,
  identifier,
  encrypted_value
) VALUES (
  'tu-site-id',
  'twilio_whatsapp',
  '+1234567890',  -- El número de WhatsApp de tu cuenta de Twilio
  'salt:encrypted_auth_token'  -- El Auth Token encriptado
);
```

## Uso

### En la ruta de WhatsApp

```typescript
import { TwilioValidationService } from '@/lib/services/twilio/TwilioValidationService';

export async function POST(request: NextRequest) {
  const twilioSignature = request.headers.get('x-twilio-signature');
  const webhookData = await request.formData();
  const whatsappNumber = extractPhoneNumber(webhookData.From);
  
  const validationResult = await TwilioValidationService.validateTwilioRequest(
    request.url,
    Object.fromEntries(webhookData.entries()),
    twilioSignature,
    whatsappNumber,
    siteId
  );
  
  if (!validationResult.isValid) {
    return NextResponse.json(
      { error: 'Invalid Twilio signature' },
      { status: 403 }
    );
  }
  
  // Procesar el webhook...
}
```

## Configuración del Middleware

La ruta `/api/agents/whatsapp` está excluida de la validación de CORS y API key en el middleware, ya que Twilio tiene su propia validación específica.

## Seguridad

- ✅ **Validación de firma**: Verifica que la petición viene de Twilio
- ✅ **Tokens encriptados**: Los Auth Tokens se almacenan encriptados
- ✅ **Comparación segura**: Usa `crypto.timingSafeEqual` para evitar timing attacks
- ✅ **Logs de seguridad**: Registra intentos de validación para auditoría

## Debugging

El servicio incluye logs detallados que puedes usar para debug:

```
[TwilioValidation] Iniciando validación de Twilio
[TwilioValidation] URL: https://...
[TwilioValidation] WhatsApp Number: +1234567890
[TwilioValidation] Signature present: true
[TwilioValidation] Auth token obtenido exitosamente
[TwilioValidation] Firma esperada: abc123...
[TwilioValidation] Firma recibida: abc123...
[TwilioValidation] Resultado de validación: true
```

## Testing

Ejecuta los tests con:

```bash
npm test src/__tests__/lib/services/twilio/TwilioValidationService.test.ts
```

Los tests cubren:
- Validación exitosa con firma correcta
- Rechazo de firmas inválidas
- Manejo de errores de base de datos
- Casos donde no se encuentra el auth token 