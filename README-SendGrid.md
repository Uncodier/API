# Servicio de SendGrid para Notificaciones Transaccionales

## Descripción

El `SendGridService` es un servicio reutilizable para el envío de emails transaccionales usando la API de SendGrid. Está diseñado como un singleton para mantener la configuración centralizada y ofrecer métodos específicos para diferentes tipos de emails.

## Configuración

### Variables de Entorno Requeridas

```bash
# Requerida
SENDGRID_API_KEY=your_sendgrid_api_key_here

# Opcionales
SENDGRID_FROM_EMAIL=no-reply@uncodie.com
SENDGRID_FROM_NAME=Uncodie
NODE_ENV=production
```

### Configuración de SendGrid

1. Regístrate en [SendGrid](https://sendgrid.com/)
2. Obtén tu API Key desde el panel de control
3. Configura las variables de entorno en tu aplicación

## Uso Básico

### Importar el Servicio

```typescript
import { sendGridService } from '@/lib/services/sendgrid-service';
```

### Envío de Email Básico

```typescript
const result = await sendGridService.sendEmail({
  to: 'usuario@ejemplo.com',
  subject: 'Asunto del correo',
  html: '<h1>Hola mundo</h1><p>Este es un email de prueba.</p>',
  text: 'Hola mundo. Este es un email de prueba.', // Opcional
});

if (result.success) {
  console.log('Email enviado:', result.messageId);
} else {
  console.error('Error:', result.error);
}
```

### Envío con Parámetros Avanzados

```typescript
const result = await sendGridService.sendEmail({
  to: ['usuario1@ejemplo.com', 'usuario2@ejemplo.com'],
  subject: 'Asunto del correo',
  html: '<h1>Email con parámetros avanzados</h1>',
  from: {
    email: 'remitente@miempresa.com',
    name: 'Mi Empresa'
  },
  replyTo: 'soporte@miempresa.com',
  cc: 'copia@ejemplo.com',
  bcc: 'copia-oculta@ejemplo.com',
  categories: ['marketing', 'newsletter'],
  customArgs: {
    userId: '12345',
    campaignId: 'summer-2024'
  },
  attachments: [{
    content: 'base64-encoded-content',
    filename: 'documento.pdf',
    type: 'application/pdf',
    disposition: 'attachment'
  }]
});
```

## Métodos Predefinidos

### 1. Email de Bienvenida

```typescript
const result = await sendGridService.sendWelcomeEmail(
  'nuevo-usuario@ejemplo.com',
  {
    name: 'Juan Pérez',
    email: 'nuevo-usuario@ejemplo.com'
  }
);
```

### 2. Email de Intervención Humana

```typescript
const result = await sendGridService.sendHumanInterventionEmail(
  ['admin@miempresa.com', 'soporte@miempresa.com'],
  {
    conversationId: 'conv-123',
    message: 'El usuario necesita ayuda con el proceso de pago',
    priority: 'high',
    agentName: 'Bot Asistente',
    summary: 'Usuario reporta error en checkout',
    contactName: 'María García',
    contactEmail: 'maria@ejemplo.com',
    conversationUrl: 'https://app.uncodie.com/conversations/conv-123'
  }
);
```

### 3. Email de Reseteo de Contraseña

```typescript
const result = await sendGridService.sendPasswordResetEmail(
  'usuario@ejemplo.com',
  {
    name: 'Juan Pérez',
    resetUrl: 'https://app.uncodie.com/reset-password?token=abc123',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 horas
  }
);
```

### 4. Email con Template Dinámico

```typescript
const result = await sendGridService.sendTemplateEmail(
  'template-id-from-sendgrid',
  'usuario@ejemplo.com',
  {
    firstName: 'Juan',
    lastName: 'Pérez',
    productName: 'Mi Producto',
    orderTotal: '$299.99'
  }
);
```

### 5. Envío de Múltiples Emails

```typescript
const emails = [
  {
    to: 'usuario1@ejemplo.com',
    subject: 'Email 1',
    html: '<p>Contenido del email 1</p>'
  },
  {
    to: 'usuario2@ejemplo.com',
    subject: 'Email 2',
    html: '<p>Contenido del email 2</p>'
  }
];

const results = await sendGridService.sendMultipleEmails(emails);
results.forEach((result, index) => {
  if (result.success) {
    console.log(`Email ${index + 1} enviado:`, result.messageId);
  } else {
    console.error(`Error en email ${index + 1}:`, result.error);
  }
});
```

## Integración en APIs

### Ejemplo en un Endpoint de Next.js

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sendGridService } from '@/lib/services/sendgrid-service';

export async function POST(request: NextRequest) {
  try {
    const { email, name } = await request.json();
    
    const result = await sendGridService.sendWelcomeEmail(email, { name, email });
    
    if (result.success) {
      return NextResponse.json({ 
        success: true, 
        messageId: result.messageId 
      });
    } else {
      return NextResponse.json({ 
        success: false, 
        error: result.error 
      }, { status: 500 });
    }
  } catch (error) {
    return NextResponse.json({ 
      success: false, 
      error: 'Internal server error' 
    }, { status: 500 });
  }
}
```

## Monitoreo y Salud del Servicio

### Health Check

```typescript
const isHealthy = await sendGridService.healthCheck();
if (!isHealthy) {
  console.error('SendGrid service is not healthy');
}
```

### Obtener Configuración

```typescript
const config = sendGridService.getConfig();
console.log('Configuración actual:', config);
```

## Características Principales

### ✅ Ventajas

- **Singleton**: Una sola instancia configurada en toda la aplicación
- **Inicialización automática**: Se configura automáticamente con variables de entorno
- **Métodos predefinidos**: Templates para casos de uso comunes
- **Manejo de errores**: Respuestas estructuradas con detalles de error
- **Modo sandbox**: Activado automáticamente en desarrollo
- **Tipado completo**: Interfaces TypeScript para todos los métodos
- **Categorización**: Automática para facilitar el tracking en SendGrid
- **Retry automático**: SendGrid maneja reintentos internamente

### 🔧 Funcionalidades Soportadas

- Emails HTML y texto plano
- Múltiples destinatarios (TO, CC, BCC)
- Adjuntos
- Templates dinámicos de SendGrid
- Categorización y argumentos personalizados
- Programación de envío
- Respuestas a direcciones específicas

## Casos de Uso

1. **Notificaciones de Sistema**: Alertas, intervenciones humanas
2. **Autenticación**: Bienvenida, reseteo de contraseña, verificación
3. **Marketing Transaccional**: Confirmaciones de pedido, actualizaciones
4. **Soporte**: Tickets, respuestas automáticas

## Mejores Prácticas

1. **Usa el singleton**: Siempre importa `sendGridService` en lugar de crear nuevas instancias
2. **Maneja errores**: Siempre verifica `result.success` antes de asumir que el email se envió
3. **Usa categorías**: Facilita el tracking y análisis en SendGrid
4. **Templates dinámicos**: Para emails complejos, usa templates de SendGrid en lugar de HTML estático
5. **Rate limiting**: SendGrid tiene límites de envío, implementa lógica de cola si es necesario

## Troubleshooting

### Error: "SendGrid API key is required"
- Verifica que `SENDGRID_API_KEY` esté configurado
- Asegúrate de que la API key sea válida en SendGrid

### Error: "Invalid email"
- Verifica el formato de las direcciones de email
- Asegúrate de que los dominios estén verificados en SendGrid

### Emails no llegan
- Verifica el estado del envío en el dashboard de SendGrid
- Revisa las listas de spam y reputación del dominio
- Confirma que el modo sandbox esté desactivado en producción

## Migración desde NotificationService

Si estás migrando desde el `NotificationService` anterior:

```typescript
// Antes
await NotificationService.notify(notificationParams, emailParams);

// Ahora
await NotificationService.createNotification(notificationParams);
await sendGridService.sendEmail(emailParams);
```

El nuevo servicio separa claramente las notificaciones internas de los emails externos, permitiendo mejor control y debugging.

## Servicio de Notificación al Equipo

Adicionalmente, se ha creado un `TeamNotificationService` que busca automáticamente a todos los miembros del sitio (`site_users`) y les envía notificaciones por email solo si tienen las notificaciones habilitadas en su perfil (`profile.notifications.email == true`).

### Uso del TeamNotificationService

```typescript
import TeamNotificationService from '@/lib/services/team-notification-service';

// Notificación básica al equipo
const result = await TeamNotificationService.notifyTeam({
  siteId: 'site-123',
  title: 'Actualización importante',
  message: 'Se ha detectado un evento que requiere atención',
  priority: 'high',
  htmlContent: '<p>Contenido HTML personalizado</p>' // Opcional
});

// Notificación específica de intervención humana
const result = await TeamNotificationService.notifyHumanIntervention({
  siteId: 'site-123',
  conversationId: 'conv-456',
  message: 'Usuario necesita ayuda especializada',
  priority: 'urgent',
  agentName: 'Asistente IA',
  summary: 'Resumen de la situación',
  contactName: 'Juan Pérez',
  contactEmail: 'juan@ejemplo.com'
});

// Obtener miembros con notificaciones habilitadas
const members = await TeamNotificationService.getTeamMembersWithEmailNotifications('site-123');
```

### Características del TeamNotificationService

- **Filtrado automático**: Solo envía a usuarios con `profile.notifications.email === true`
- **Fallback inteligente**: Si no hay configuración de notificaciones, incluye a los admins por defecto
- **Doble notificación**: Crea notificaciones internas Y envía emails con SendGrid
- **Resultados detallados**: Retorna estadísticas de envío (notificaciones enviadas, emails enviados, errores)
- **HTML personalizable**: Permite contenido HTML personalizado o usa templates por defecto

### Integración en Contact-Human

El endpoint de `contact-human` ahora usa automáticamente el `TeamNotificationService` en lugar de la lógica anterior, proporcionando:

- Mejor filtrado de destinatarios
- Respeto por las preferencias de notificación de usuarios
- Estadísticas detalladas de envío
- Manejo robusto de errores 