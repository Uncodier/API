# New Leads Alert Notification

Esta notificación envía una alerta al equipo cuando hay leads nuevos sin asignar, advirtiendo que comenzarán a ser prospectados automáticamente por IA en un tiempo determinado (por defecto 48 horas).

## Endpoint

```http
POST /api/notifications/newLeadsAlert
```

## Parámetros de Request

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `site_id` | string (UUID) | Sí | ID del sitio para buscar leads sin asignar |
| `priority` | string | No | Prioridad de la notificación: 'low', 'normal', 'high', 'urgent' (default: 'normal') |
| `hours_until_auto_prospect` | number | No | Horas hasta que comience el auto-prospecting (default: 48, min: 1, max: 168) |
| `include_lead_details` | boolean | No | Incluir detalles de los leads en el email (default: true) |
| `max_leads_to_display` | number | No | Máximo número de leads a mostrar en email (default: 20, min: 1, max: 50) |

### Ejemplo de Request

```json
{
  "site_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "priority": "high",
  "hours_until_auto_prospect": 24,
  "include_lead_details": true,
  "max_leads_to_display": 15
}
```

## Response Structure

### Éxito con leads encontrados (200 OK)

```json
{
  "success": true,
  "data": {
    "site_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "total_unassigned_leads": 8,
    "hours_until_auto_prospect": 48,
    "site_info": {
      "name": "Mi Sitio Web"
    },
    "notification_sent": true,
    "notifications_sent": 3,
    "emails_sent": 3,
    "team_members_notified": 3,
    "leads_preview": [
      {
        "id": "lead-uuid-1",
        "name": "Juan Pérez",
        "email": "juan@empresa.com",
        "created_at": "2024-12-20T10:00:00Z",
        "origin": "website",
        "segment": "Enterprise"
      },
      {
        "id": "lead-uuid-2", 
        "name": "María García",
        "email": "maria@startup.com",
        "created_at": "2024-12-20T09:30:00Z",
        "origin": "landing_page",
        "segment": "SMB"
      }
    ],
    "sent_at": "2024-12-20T15:30:00Z"
  }
}
```

### Sin leads sin asignar (200 OK)

```json
{
  "success": true,
  "data": {
    "site_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "total_unassigned_leads": 0,
    "message": "No unassigned leads found",
    "notification_sent": false
  }
}
```

## Funcionalidad

### 1. Búsqueda de Leads Sin Asignar
- Busca leads con `status = 'new'` 
- Filtra por `assignee_id IS NULL` (sin asignar)
- Ordena por fecha de creación (más recientes primero)
- Incluye información de segmentos asociados

### 2. Notificación al Equipo
- Utiliza `TeamNotificationService` para obtener miembros del equipo
- Filtra por usuarios con notificaciones por email habilitadas
- Envía tanto notificaciones internas como emails

### 3. Email Personalizado
- **Encabezado visual**: Logo del sitio y contador de leads
- **Información destacada**: Cantidad de leads y tiempo hasta auto-prospecting
- **Lista de leads**: Detalles de leads recientes (nombre, email, empresa, segmento, origen)
- **Botones de acción**: "Assign Leads Now" y "View All Leads"
- **Explicación del auto-prospecting**: Información sobre el sistema de IA

### 4. Características del Email

#### Secciones principales:
- **Resumen visual**: Estadísticas rápidas con iconos
- **Lista de leads**: Vista previa de leads sin asignar (máximo 10 mostrados)
- **Advertencia temporal**: Fecha exacta cuando comenzará el auto-prospecting
- **Explicación del proceso**: Qué sucede con el auto-prospecting
- **Botones de acción**: Enlaces directos para asignar leads

#### Responsive y profesional:
- Diseño adaptable para móviles
- Colores que indican urgencia según tiempo restante
- Información clara y accionable
- Branding consistente con la plataforma

## Lógica de Negocio

### Criterios de Selección de Leads
Los leads se incluyen si cumplen **TODOS** estos criterios:
- `status = 'new'` (nuevos)
- `assignee_id IS NULL` (sin asignar)
- `site_id` coincide con el sitio solicitado
- Están asociados a un segmento válido

### Sistema de Prioridad Visual
- **≤ 24 horas**: Estilo urgente (rojo)
- **≤ 48 horas**: Estilo de alta prioridad (naranja)
- **> 48 horas**: Estilo normal (azul)

### Auto-Prospecting
El sistema informa que los leads sin asignar:
- Entrarán automáticamente al sistema de prospecting por IA
- Comenzarán a recibir outreach personalizado
- Mantendrán el contexto de datos del lead y messaging del sitio
- Pueden ser reclamados en cualquier momento por el equipo humano

## Casos de Uso

### Alerta Diaria de Leads
```json
{
  "site_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "priority": "normal",
  "hours_until_auto_prospect": 48,
  "include_lead_details": true
}
```

### Alerta Urgente (< 24 horas)
```json
{
  "site_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", 
  "priority": "urgent",
  "hours_until_auto_prospect": 12,
  "include_lead_details": true,
  "max_leads_to_display": 30
}
```

### Resumen Solo con Números
```json
{
  "site_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "priority": "low",
  "hours_until_auto_prospect": 72,
  "include_lead_details": false,
  "max_leads_to_display": 5
}
```

## Códigos de Error

| Código | Descripción |
|--------|-------------|
| `VALIDATION_ERROR` | Datos de request inválidos o campos requeridos faltantes |
| `SITE_NOT_FOUND` | Sitio no encontrado |
| `NOTIFICATION_SEND_ERROR` | Error al enviar notificación al equipo |
| `NOTIFICATION_ERROR` | Error en el proceso de notificación |
| `SYSTEM_ERROR` | Error interno del sistema |

## Integración

### Automática con Cron Jobs
Este endpoint puede ser llamado automáticamente en:
- **Daily checks**: Verificación diaria de leads sin asignar
- **Hourly checks**: Verificaciones más frecuentes cerca del deadline
- **Triggered events**: Cuando se detectan nuevos leads sin asignar

### Manual desde Dashboard
Los administradores pueden triggear la notificación manualmente para:
- Verificar el estado actual de leads
- Alertar al equipo sobre leads pendientes
- Forzar una revisión antes de deadlines importantes

### Webhooks
Puede integrarse con sistemas externos que detecten:
- Nuevos leads ingresando al sistema
- Cambios en el estado de asignación
- Actualizaciones en la configuración de auto-prospecting

## Configuración

### Variables de Entorno
- `NEXT_PUBLIC_APP_URL`: URL base para enlaces en emails
- `UNCODIE_BRANDING_TEXT`: Texto de branding en footer
- `UNCODIE_COMPANY_NAME`: Nombre de la empresa

### Personalización
- **Logos**: Se usa `site.logo_url` si está disponible
- **URLs**: Enlaces personalizados por sitio
- **Tiempo**: Configurable entre 1 y 168 horas (1 semana)
- **Cantidad**: Entre 1 y 50 leads mostrados

## Métricas y Monitoreo

La notificación genera logs que incluyen:
- Número de leads sin asignar encontrados
- Número de team members notificados
- Éxito/fallo de envío de emails
- Tiempos de respuesta de la base de datos
- Errores en el proceso de notificación

Esto permite monitorear:
- Eficiencia del sistema de asignación de leads
- Tasa de respuesta del equipo a las alertas
- Identificación de sitios con problemas de asignación
- Optimización de tiempos de auto-prospecting 