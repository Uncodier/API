# Configuración de Notificaciones por Correo Electrónico

Este documento explica cómo configurar el servicio de notificaciones por correo electrónico en la plataforma.

## Requisitos

Para que las notificaciones por correo electrónico funcionen correctamente, debes configurar las siguientes variables de entorno en tu archivo `.env`:

```
# Configuración SMTP para correos electrónicos
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_USER=tu-usuario@example.com
EMAIL_PASSWORD=tu-contraseña
EMAIL_FROM=notificaciones@uncodie.com
```

## Servicios SMTP Recomendados

Puedes utilizar cualquiera de estos servicios de correo electrónico:

1. **Amazon SES**: Ideal para aplicaciones con gran volumen de correos
2. **SendGrid**: Ofrece una capa gratuita con 100 correos diarios
3. **Mailgun**: Buena opción para desarrolladores, con 10,000 correos gratis al mes
4. **SMTP de Gmail**: Para entornos de desarrollo (requiere configuración de contraseña de aplicación)

## Plantillas de Correo

Las plantillas de correo están integradas en el código. Actualmente, tenemos las siguientes plantillas:

1. **Intervención Humana**: Se envía cuando un agente solicita la intervención de un humano en una conversación.

## Configuración de la Base de Datos

El servicio de notificaciones requiere una tabla `notifications` en la base de datos. Esta tabla se utiliza para almacenar las notificaciones generadas por el sistema.

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL, 
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  user_id UUID REFERENCES auth.users(id),
  site_id UUID REFERENCES sites(id),
  entity_type TEXT,
  entity_id UUID,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  read_at TIMESTAMP WITH TIME ZONE,
  archived_at TIMESTAMP WITH TIME ZONE
);

-- Índices para mejorar el rendimiento
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_site_id ON notifications(site_id);
CREATE INDEX idx_notifications_status ON notifications(status);
CREATE INDEX idx_notifications_created_at ON notifications(created_at);
```

## Cómo Probar

Para probar si la configuración de correo electrónico funciona correctamente, puedes ejecutar el siguiente comando:

```bash
NODE_ENV=test npx ts-node scripts/test-email.ts
```

Este script enviará un correo electrónico de prueba a la dirección configurada en `EMAIL_USER`.

## Solución de Problemas

### No se envían correos electrónicos

- Verifica que las variables de entorno estén correctamente configuradas
- Asegúrate de que el servidor SMTP sea accesible desde el entorno donde se ejecuta la aplicación
- Revisa los logs del servidor en busca de errores relacionados con el envío de correos

### Errores de autenticación SMTP

- Verifica las credenciales de usuario y contraseña
- Si usas Gmail, asegúrate de haber configurado una "contraseña de aplicación"
- Algunos servicios pueden requerir una clave API en lugar de una contraseña tradicional

### Correos marcados como spam

- Configura registros SPF y DKIM para tu dominio
- Usa una dirección de remitente que coincida con el dominio desde el que envías
- Evita palabras que puedan activar filtros de spam en el asunto y cuerpo del correo 