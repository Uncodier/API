# Lead Assignment Notification API

Este endpoint permite notificar a un vendedor cuando se le asigna un nuevo lead, incluyendo toda la información relevante, brief y siguientes pasos.

## Endpoint

```
POST /api/notifications/leadAssignment
```

## Parámetros de la Request

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `lead_id` | string (UUID) | ✅ | ID del lead a asignar |
| `assignee_id` | string (UUID) | ✅ | ID del vendedor al que se asigna el lead |
| `brief` | string | ✅ | Descripción detallada del lead y contexto |
| `next_steps` | string[] | ✅ | Lista de pasos a seguir por el vendedor |
| `priority` | enum | ❌ | Prioridad: 'low', 'normal', 'high', 'urgent' (default: 'normal') |
| `due_date` | string (ISO) | ❌ | Fecha límite para completar la asignación |
| `additional_context` | string | ❌ | Contexto adicional relevante |
| `include_team_notification` | boolean | ❌ | Si notificar también al equipo (default: false) |
| `metadata` | object | ❌ | Metadatos adicionales para tracking |

## Ejemplo de Uso

```typescript
const response = await fetch('/api/notifications/leadAssignment', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    lead_id: '550e8400-e29b-41d4-a716-446655440000',
    assignee_id: '550e8400-e29b-41d4-a716-446655440002',
    brief: 'Este es un prospecto de alto valor de nuestro sitio web. Mostró interés en nuestra solución empresarial y tiene un presupuesto estimado de $50,000. Viene de una empresa Fortune 500 y necesita una implementación para Q1 2025.',
    next_steps: [
      'Llamar dentro de las próximas 24 horas para presentarte',
      'Enviar materiales de demostración del producto',
      'Programar una demo del producto para la próxima semana',
      'Hacer seguimiento de sus requisitos específicos',
      'Enviar propuesta comercial personalizada'
    ],
    priority: 'high',
    due_date: '2024-12-31T23:59:59Z',
    additional_context: 'Mencionó que tienen un presupuesto de $50k y necesitan una solución para Q1 2025. Están evaluando 3 proveedores diferentes.',
    include_team_notification: true,
    metadata: {
      source: 'website_form',
      campaign: 'enterprise_trial',
      lead_score: 85,
      company_size: 'enterprise'
    }
  })
});

const result = await response.json();
```

## Respuesta Exitosa

```json
{
  "success": true,
  "data": {
    "lead_id": "550e8400-e29b-41d4-a716-446655440000",
    "assignee_id": "550e8400-e29b-41d4-a716-446655440002",
    "lead_info": {
      "name": "Juan Pérez",
      "email": "juan.perez@empresa.com",
      "phone": "+1234567890",
      "status": "new",
      "origin": "website"
    },
    "assignee_info": {
      "name": "María García",
      "email": "maria.garcia@empresa.com"
    },
    "site_info": {
      "name": "Mi Sitio Web",
      "url": "https://miempresa.com"
    },
    "assignment_details": {
      "brief": "Este es un prospecto de alto valor...",
      "next_steps": ["Llamar dentro de las próximas 24 horas..."],
      "priority": "high",
      "due_date": "2024-12-31T23:59:59Z",
      "additional_context": "Mencionó que tienen un presupuesto..."
    },
    "notifications_sent": {
      "assignee": 0,
      "team": 2
    },
    "emails_sent": {
      "assignee": 1,
      "team": 1
    },
    "total_recipients": {
      "assignee": 1,
      "team": 2
    },
    "assignment_updated": true,
    "sent_at": "2024-12-20T10:30:00Z"
  }
}
```

## Funcionalidad

### 1. Asignación del Lead
- Actualiza el campo `assignee_id` del lead en la base de datos
- Vincula el lead al vendedor asignado

### 2. Notificación al Vendedor
- Envía un email profesional al vendedor asignado
- Incluye toda la información del lead (nombre, email, teléfono, empresa, etc.)
- Muestra el brief detallado y los siguientes pasos
- Incluye botones de acción para ver el lead y responder

### 3. Notificación al Equipo (Opcional)
- Si `include_team_notification` está en `true`, notifica al equipo
- Útil para transparencia y seguimiento interno
- Incluye información del lead y vendedor asignado

### 4. Contenido del Email

#### Para el Vendedor:
- **Encabezado**: "New Lead Assignment"
- **Información del Lead**: Nombre, email, teléfono, posición, empresa, estado, origen
- **Brief**: Descripción detallada del contexto del lead
- **Siguientes Pasos**: Lista numerada de acciones a tomar
- **Fecha Límite**: Si se especifica
- **Contexto Adicional**: Información extra relevante
- **Botones de Acción**: Ver lead, responder, visitar sitio

#### Para el Equipo:
- **Encabezado**: "Lead Assignment Notification"
- **Información de la Asignación**: Lead asignado a vendedor
- **Brief y Siguientes Pasos**: Mismo contenido para transparencia
- **Botón de Acción**: Ver detalles del lead

## Códigos de Estado

- **200**: Éxito completo
- **207**: Éxito parcial (algunas notificaciones fallaron)
- **400**: Error de validación
- **404**: Lead o vendedor no encontrado
- **500**: Error interno del servidor

## Errores Comunes

### Error de Validación (400)
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [
      {
        "code": "invalid_type",
        "expected": "string",
        "received": "number",
        "path": ["lead_id"],
        "message": "lead_id debe ser un UUID válido"
      }
    ]
  }
}
```

### Lead No Encontrado (404)
```json
{
  "success": false,
  "error": {
    "code": "LEAD_NOT_FOUND",
    "message": "Lead not found"
  }
}
```

### Vendedor No Encontrado (404)
```json
{
  "success": false,
  "error": {
    "code": "ASSIGNEE_NOT_FOUND",
    "message": "Assignee not found"
  }
}
```

## Casos de Uso

### 1. Asignación Manual
```typescript
// Cuando un manager asigna manualmente un lead
await assignLead({
  lead_id: leadId,
  assignee_id: selectedSalesperson.id,
  brief: 'Lead cualificado manualmente por el manager',
  next_steps: ['Contactar en las próximas 2 horas'],
  priority: 'urgent',
  include_team_notification: false
});
```

### 2. Asignación Automática
```typescript
// Sistema automatizado de asignación de leads
await assignLead({
  lead_id: newLead.id,
  assignee_id: await getNextAvailableSalesperson(),
  brief: `Lead generado automáticamente desde ${lead.origin}`,
  next_steps: [
    'Revisar perfil del lead',
    'Contactar dentro de 4 horas',
    'Calificar nivel de interés'
  ],
  priority: 'normal',
  include_team_notification: true
});
```

### 3. Reasignación de Lead
```typescript
// Cuando se reasigna un lead existente
await assignLead({
  lead_id: existingLead.id,
  assignee_id: newAssignee.id,
  brief: 'Lead reasignado debido a especialización requerida',
  next_steps: [
    'Revisar historial de interacciones previas',
    'Contactar para continuidad',
    'Actualizar estrategia de seguimiento'
  ],
  priority: 'high',
  additional_context: 'Lead previamente manejado por otro vendedor',
  include_team_notification: true
});
```

## Configuración

### Variables de Entorno
- `UNCODIE_BRANDING_TEXT`: Texto de branding en los emails
- `UNCODIE_COMPANY_NAME`: Nombre de la empresa
- `NEXT_PUBLIC_APP_URL`: URL base de la aplicación

### Dependencias
- SendGrid para envío de emails
- Supabase para base de datos
- TeamNotificationService para notificaciones internas

## Consideraciones de Seguridad

- Validación estricta de UUIDs
- Verificación de existencia de lead y vendedor
- Límites de timeout (2 minutos máximo)
- Logging detallado para auditoría
- Manejo seguro de errores sin exposición de datos internos 