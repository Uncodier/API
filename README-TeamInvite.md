# Team Member Invitation API

API endpoint para enviar invitaciones por email a miembros del equipo para unirse a app.uncodie.com.

## Endpoint

```
POST /api/teamMembers/invite
```

## Autenticación

- **Desarrollo**: No se requiere autenticación
- **Producción**: Requiere headers `x-api-key` y `x-api-secret`

## Parámetros

### Headers (Producción)
```
x-api-key: your-api-key
x-api-secret: your-api-secret
Content-Type: application/json
```

### Body
```json
{
  "siteName": "string (required) - Nombre del sitio/proyecto",
  "teamMembers": [
    {
      "email": "string (required) - Email del miembro",
      "name": "string (required) - Nombre completo",
      "role": "string (required) - view|create|delete|admin",
      "position": "string (required) - Cargo/posición"
    }
  ]
}
```

### Roles Disponibles
- `view`: Solo lectura
- `create`: Crear y editar
- `delete`: Acceso completo (incluye eliminar)
- `admin`: Privilegios de administrador

## Ejemplos de Uso

### cURL

```bash
curl -X POST http://localhost:3000/api/teamMembers/invite \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -H "x-api-secret: your-api-secret" \
  -d '{
    "siteName": "Mi Proyecto Increíble",
    "teamMembers": [
      {
        "email": "desarrollador@empresa.com",
        "name": "Juan Pérez",
        "role": "create",
        "position": "Frontend Developer"
      },
      {
        "email": "manager@empresa.com", 
        "name": "María González",
        "role": "admin",
        "position": "Project Manager"
      }
    ]
  }'
```

### JavaScript/TypeScript

```javascript
const response = await fetch('/api/teamMembers/invite', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'your-api-key',
    'x-api-secret': 'your-api-secret'
  },
  body: JSON.stringify({
    siteName: 'Mi Proyecto Increíble',
    teamMembers: [
      {
        email: 'desarrollador@empresa.com',
        name: 'Juan Pérez',
        role: 'create',
        position: 'Frontend Developer'
      },
      {
        email: 'manager@empresa.com',
        name: 'María González', 
        role: 'admin',
        position: 'Project Manager'
      }
    ]
  })
});

const result = await response.json();
console.log(result);
```

### Python

```python
import requests

url = "http://localhost:3000/api/teamMembers/invite"
headers = {
    "Content-Type": "application/json",
    "x-api-key": "your-api-key",
    "x-api-secret": "your-api-secret"
}

data = {
    "siteName": "Mi Proyecto Increíble",
    "teamMembers": [
        {
            "email": "desarrollador@empresa.com",
            "name": "Juan Pérez",
            "role": "create",
            "position": "Frontend Developer"
        },
        {
            "email": "manager@empresa.com",
            "name": "María González",
            "role": "admin", 
            "position": "Project Manager"
        }
    ]
}

response = requests.post(url, json=data, headers=headers)
print(response.json())
```

## Respuestas

### Éxito Completo (200)
```json
{
  "success": true,
  "message": "All invitations sent successfully",
  "data": {
    "totalMembers": 2,
    "successfulInvites": 2,
    "failedInvites": 0,
    "results": [
      {
        "email": "desarrollador@empresa.com",
        "success": true,
        "messageId": "sendgrid-message-id"
      },
      {
        "email": "manager@empresa.com",
        "success": true,
        "messageId": "sendgrid-message-id"
      }
    ]
  }
}
```

### Éxito Parcial (207)
```json
{
  "success": false,
  "message": "1 invitations sent successfully, 1 failed",
  "data": {
    "totalMembers": 2,
    "successfulInvites": 1,
    "failedInvites": 1,
    "results": [
      {
        "email": "desarrollador@empresa.com",
        "success": true,
        "messageId": "sendgrid-message-id"
      },
      {
        "email": "invalid@domain",
        "success": false,
        "error": "Invalid email address"
      }
    ]
  }
}
```

### Error de Validación (400)
```json
{
  "success": false,
  "message": "Validation errors",
  "errors": [
    "Member 1: email is required and must be a string",
    "Member 1: role must be one of: view, create, delete, admin"
  ]
}
```

### Error de Autenticación (401)
```json
{
  "success": false,
  "message": "Missing or invalid authentication headers. x-api-key and x-api-secret are required in production."
}
```

### Error del Servidor (500)
```json
{
  "success": false,
  "message": "All invitations failed",
  "data": {
    "totalMembers": 2,
    "successfulInvites": 0,
    "failedInvites": 2,
    "results": [...]
  }
}
```

## Contenido del Email

Los emails incluyen:
- **Asunto**: "You're invited to join {siteName} on Uncodie"
- **Diseño profesional** con gradiente morado/azul
- **Información del equipo**: Nombre del proyecto, rol, posición
- **Botón CTA**: "Join Team" que redirige a app.uncodie.com/signup
- **Detalles del rol** con colores distintivos por tipo de acceso
- **Lista de características** de la plataforma
- **Instrucciones** para usuarios nuevos

## Notas de Implementación

- Los emails se envían **secuencialmente** para mejor control de errores
- Se usa **HTML responsivo** compatible con todos los clientes de email
- Incluye **categorías de SendGrid** para tracking: `['team-invitation', 'transactional']`
- **Custom args** para analytics: `siteId`, `memberRole`, `invitationType`
- **Rate limiting**: Máximo 50 invitaciones por request
- **Validación estricta** de formato de email y roles permitidos
- **Logging detallado** para debugging y monitoreo

## Testing

Para ejecutar los tests:

```bash
npm test src/tests/api/teamMembers/invite.test.ts
```

Los tests cubren:
- ✅ Autenticación en desarrollo y producción
- ✅ Validación de parámetros y Content-Type
- ✅ Envío de emails exitoso, parcial y fallido
- ✅ Generación correcta del contenido HTML
- ✅ Manejo de errores y excepciones
- ✅ Endpoint GET de información

## Dependencias

- `@sendgrid/mail` - Envío de emails
- `next` - Framework y API routes
- El sistema de autenticación existente del proyecto

## Variables de Entorno

### Configuración de SendGrid
```bash
SENDGRID_API_KEY=your_sendgrid_api_key_here
SENDGRID_FROM_EMAIL=no-reply@uncodie.com
SENDGRID_FROM_NAME=Uncodie
```

### Configuración de la Aplicación
```bash
NEXT_PUBLIC_APP_URL=https://app.uncodie.com
```

### Configuración de Branding y Personalización
```bash
# Texto de branding que aparece en el footer de todos los emails
# Por defecto: "Uncodie, your AI Sales Team"
UNCODIE_BRANDING_TEXT=Uncodie, your AI Sales Team

# Nombre de la compañía (aparece en títulos, asuntos de email, etc.)
# Por defecto: "Uncodie"
UNCODIE_COMPANY_NAME=Uncodie

# Tagline de la compañía (aparece en el footer después del branding)
# Por defecto: "AI-powered team collaboration"
UNCODIE_COMPANY_TAGLINE=AI-powered team collaboration

# Email de soporte por defecto
# Por defecto: "support@uncodie.com"
UNCODIE_SUPPORT_EMAIL=support@uncodie.com
```

### Ejemplos de Personalización
```bash
# Para una marca personalizada
UNCODIE_COMPANY_NAME=TuEmpresa
UNCODIE_BRANDING_TEXT=TuEmpresa, tu equipo AI de ventas
UNCODIE_COMPANY_TAGLINE=Automatización inteligente de ventas
UNCODIE_SUPPORT_EMAIL=soporte@tuempresa.com
NEXT_PUBLIC_APP_URL=https://app.tuempresa.com
```

**Nota**: Todas estas variables permiten personalizar completamente la experiencia de email sin modificar código. Si no se especifican, se usan los valores por defecto de Uncodie. 