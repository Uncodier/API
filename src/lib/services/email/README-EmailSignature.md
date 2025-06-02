# EmailSignatureService

Servicio para generar firmas profesionales para agentes basadas en la configuración del sitio y información de la empresa almacenada en la base de datos.

## Características

- ✅ Genera firmas automáticamente basadas en información del sitio
- ✅ Personalización con nombre del agente
- ✅ Múltiples formatos de salida (texto plano y HTML profesional)
- ✅ Integración automática en emails enviados por agentes
- ✅ Manejo de errores robusto con fallback a firma básica
- ✅ Incluye logo del sitio cuando está disponible
- ✅ Tweet pitch basado en settings.about
- ✅ Diseño responsive y profesional
- ✅ Sin uso de etiquetas para evitar problemas de traducción

## Uso Básico

### Generar Firma Programáticamente

```typescript
import { EmailSignatureService } from '@/lib/services/email/EmailSignatureService';

// Generar firma con nombre de agente
const signature = await EmailSignatureService.generateAgentSignature(
  'site-id-123',
  'María González'
);

console.log(signature.plainText);
console.log(signature.formatted);
```

### Endpoint API

#### POST `/api/agents/tools/signature`

Genera una firma personalizada para un agente.

**Parámetros:**
- `site_id` (requerido): ID del sitio
- `agent_name` (opcional): Nombre del agente
- `format` (opcional): Formato de respuesta (`both`, `plain`, `formatted`)

**Ejemplo de solicitud:**
```bash
curl -X POST /api/agents/tools/signature \
  -H "Content-Type: application/json" \
  -d '{
    "site_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "agent_name": "María González",
    "format": "both"
  }'
```

**Respuesta:**
```json
{
  "success": true,
  "site_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "agent_name": "María González",
  "signatures": {
    "plain": "María González\nTechCorp Solutions\nEmail: info@techcorp.com\nTeléfono: +34 987 654 321\nWeb: https://techcorp.com",
    "formatted": "---\nMaría González\nTechCorp Solutions\nEmail: info@techcorp.com\nTeléfono: +34 987 654 321\nWeb: https://techcorp.com\n\nGracias por contactarnos. Estamos aquí para ayudarte.\n---"
  },
  "generated_at": "2024-03-15T10:30:00Z"
}
```

#### GET `/api/agents/tools/signature`

Obtiene información del servicio o una previsualización.

**Previsualización:**
```bash
curl "/api/agents/tools/signature?site_id=your-site-id&preview=true"
```

## Configuración de Datos

El servicio utiliza información de dos tablas principales:

### Tabla `sites`
- `name`: Nombre de la empresa
- `url`: Sitio web principal
- `description`: Descripción de la empresa
- `logo_url`: URL del logo de la empresa

### Tabla `settings`
- `company_size`: Tamaño de la empresa
- `industry`: Sector/industria
- `about`: Descripción detallada (priorizada para tweet pitch)
- `team_members`: Array JSON con miembros del equipo
- `locations`: Array JSON con ubicaciones
- `social_media`: Objeto JSON con redes sociales
- `channels.email.email`: Email principal configurado

### Estructura de Datos JSON

#### `team_members`
```json
[
  {
    "name": "Juan Pérez",
    "role": "CEO",
    "email": "juan@empresa.com",
    "phone": "+34 123 456 789"
  }
]
```

#### `locations`
```json
[
  {
    "address": "Calle Principal 123, Madrid, España",
    "phone": "+34 987 654 321",
    "type": "headquarters"
  }
]
```

#### `social_media`
```json
{
  "linkedin": "https://linkedin.com/company/empresa",
  "twitter": "https://twitter.com/empresa",
  "facebook": "https://facebook.com/empresa"
}
```

## Lógica de Prioridades

### Información de Contacto
1. **Email**: Se obtiene de `settings.channels.email.email`
2. **Teléfono**: Prioridad a ubicaciones sobre miembros del equipo
3. **Dirección**: Se busca ubicación `headquarters`, `main` o `principal`

### Redes Sociales
Se incluyen en orden: LinkedIn, Twitter, Facebook (solo URLs limpias)

### Formato
- Se mantiene un diseño limpio y profesional
- No se incluye información adicional como sector o descripciones
- Las redes sociales se muestran como URLs directas sin etiquetas

## Integración Automática

El servicio se integra automáticamente en el endpoint `sendEmail`:

```typescript
// En /api/agents/tools/sendEmail/route.ts
const signature = await EmailSignatureService.generateAgentSignature(site_id, from);
finalMessage = message + '\n\n' + signature.formatted;
```

## Formatos de Salida

### Texto Plano (`plainText`)
```
María González
TechCorp Solutions
"Empresa líder en desarrollo de software"
Email: info@techcorp.com
Tel: +34 987 654 321
Web: https://techcorp.com
Calle Principal 123, Madrid, España
https://linkedin.com/company/techcorp | https://twitter.com/techcorp
```

### HTML Profesional (`formatted`)
```html
<table style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; border-collapse: collapse; width: 100%; max-width: 500px;">
  <tbody>
    <!-- Logo del sitio (cuando está disponible) -->
    <tr>
      <td style="padding-bottom: 15px;">
        <img src="https://techcorp.com/logo.png" alt="TechCorp Solutions" style="max-height: 60px; max-width: 200px; height: auto;">
      </td>
    </tr>
    
    <!-- Nombre del agente -->
    <tr>
      <td style="font-weight: bold; font-size: 16px; color: #333; padding-bottom: 3px;">
        María González
      </td>
    </tr>
    
    <!-- Nombre de la empresa -->
    <tr>
      <td style="font-size: 14px; color: #007bff; font-weight: 500; padding-bottom: 10px;">
        TechCorp Solutions
      </td>
    </tr>
    
    <!-- Tweet pitch -->
    <tr>
      <td style="padding: 10px 0; font-style: italic; color: #666; font-size: 14px; border-left: 3px solid #007bff; padding-left: 12px; margin: 10px 0;">
        "Empresa líder en desarrollo de software"
      </td>
    </tr>
    
    <!-- Información de contacto -->
    <tr>
      <td style="padding-bottom: 15px; font-size: 13px;">
        <div style="margin-bottom: 4px;">
          <span style="color: #666;">✉</span>
          <a href="mailto:info@techcorp.com" style="color: #007bff; text-decoration: none; margin-left: 8px;">info@techcorp.com</a>
        </div>
        <div style="margin-bottom: 4px;">
          <span style="color: #666;">📞</span>
          <a href="tel:+34987654321" style="color: #333; text-decoration: none; margin-left: 8px;">+34 987 654 321</a>
        </div>
        <div style="margin-bottom: 4px;">
          <span style="color: #666;">🌐</span>
          <a href="https://techcorp.com" style="color: #007bff; text-decoration: none; margin-left: 8px;">https://techcorp.com</a>
        </div>
        <div style="margin-bottom: 4px;">
          <span style="color: #666;">📍</span>
          <span style="color: #333; margin-left: 8px;">Calle Principal 123, Madrid, España</span>
        </div>
      </td>
    </tr>
    
    <!-- Redes sociales -->
    <tr>
      <td style="border-top: 1px solid #eee; padding-top: 10px;">
        <a href="https://linkedin.com/company/techcorp" style="text-decoration: none; margin-right: 10px;">
          <span style="color: #0077b5; font-size: 16px;">💼</span>
        </a>
        <a href="https://twitter.com/techcorp" style="text-decoration: none; margin-right: 10px;">
          <span style="color: #1da1f2; font-size: 16px;">🐦</span>
        </a>
      </td>
    </tr>
  </tbody>
</table>
```

## Manejo de Errores

- **Datos faltantes**: Genera firma básica con nombre del agente
- **Errores de base de datos**: Fallback a firma básica
- **JSON inválido**: Ignora campos problemáticos y continúa
- **Site ID inválido**: Devuelve firma genérica

## Testing

```bash
# Ejecutar tests
npm test src/lib/services/email/__tests__/EmailSignatureService.test.ts

# Test específico
npm test -- --testNamePattern="debería generar una firma completa"
```

## Consideraciones de Rendimiento

- Las consultas a la base de datos se realizan en paralelo
- Los datos JSON se parsean solo una vez
- Caché automático a nivel de Supabase
- Fallback rápido en caso de errores

## Personalización

Para personalizar el formato de la firma, modifica los métodos:
- `buildSignature()`: Lógica principal de construcción
- `formatSignature()`: Formato de presentación
- `buildSocialLinks()`: Enlaces a redes sociales

## Seguridad

- Validación de UUID para `site_id`
- Sanitización automática de datos de entrada
- No exposición de información sensible
- Manejo seguro de errores de parsing JSON 