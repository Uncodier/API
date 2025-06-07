# Content Improve API

API para mejorar contenido existente utilizando agentes de copywriting con IA. Esta API procesa **todo el contenido en estado `draft` de un sitio** de golpe, aplicando mejoras consistentes basadas en objetivos específicos y actualizando el contenido en la base de datos.

## Endpoint Base

```
/api/agents/copywriter/content-improve
```

## Métodos Disponibles

### POST - Mejora Masiva de Contenido en Draft

Mejora **todo el contenido en estado `draft` de un sitio** aplicando optimizaciones de SEO, legibilidad y engagement de forma consistente.

#### URL
```
POST /api/agents/copywriter/content-improve
```

#### Parámetros del Body (JSON)

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `siteId` | string (UUID) | ✅ | ID del sitio - se procesará todo su contenido en draft |
| `contentIds` | array[string (UUID)] | ❌ | IDs específicos de contenido a mejorar (si no se proporciona, mejora todo el draft del sitio) |
| `segmentId` | string (UUID) | ❌ | ID del segmento de audiencia |
| `campaignId` | string (UUID) | ❌ | ID de la campaña |
| `userId` | string | ❌ | ID del usuario (por defecto: `system`) |
| `agent_id` | string | ❌ | ID del agente (por defecto: `default_copywriter_agent`) |
| `improvementGoals` | array[string] | ❌ | Objetivos específicos de mejora |
| `targetAudience` | string\|array[string] | ❌ | Audiencia objetivo específica |
| `keywords` | array[string] | ❌ | Palabras clave para optimización SEO |
| `contentStyle` | string | ❌ | Estilo de contenido deseado |
| `maxLength` | number | ❌ | Longitud máxima en caracteres por contenido |
| `limit` | number | ❌ | Límite máximo de contenidos a procesar (por defecto: 50) |

#### Ejemplo de Request - Mejora Masiva

```json
{
  "siteId": "456e7890-e89b-12d3-a456-426614174001",
  "segmentId": "789e0123-e89b-12d3-a456-426614174002",
  "userId": "user_123",
  "improvementGoals": [
    "Mejorar la legibilidad y estructura",
    "Optimizar para SEO",
    "Aumentar el engagement",
    "Mantener consistencia de marca"
  ],
  "targetAudience": [
    "Emprendedores digitales",
    "Marketers profesionales"
  ],
  "keywords": [
    "marketing digital",
    "estrategia de contenido",
    "SEO",
    "conversión",
    "engagement"
  ],
  "contentStyle": "profesional pero accesible",
  "maxLength": 2000,
  "limit": 25
}
```

#### Ejemplo de Request - Mejora Selectiva

```json
{
  "siteId": "456e7890-e89b-12d3-a456-426614174001",
  "contentIds": [
    "123e4567-e89b-12d3-a456-426614174000",
    "234e5678-e89b-12d3-a456-426614174001",
    "345e6789-e89b-12d3-a456-426614174002"
  ],
  "userId": "user_123",
  "improvementGoals": [
    "Optimizar para palabras clave específicas",
    "Mejorar call-to-action"
  ],
  "keywords": ["producto", "ventas", "conversión"]
}
```

#### Respuesta Exitosa (200)

```json
{
  "success": true,
  "data": {
    "command_id": "789e0123-e89b-12d3-a456-426614174003",
    "siteId": "456e7890-e89b-12d3-a456-426614174001",
    "segmentId": "789e0123-e89b-12d3-a456-426614174002",
    "campaignId": null,
    "processed_count": 15,
    "updated_count": 14,
    "failed_count": 1,
    "failed_content_ids": ["123e4567-e89b-12d3-a456-426614174000"],
    "original_content": [
      {
        "id": "234e5678-e89b-12d3-a456-426614174001",
        "title": "Título Original 1",
        "description": "Descripción original",
        "status": "draft"
      },
      {
        "id": "345e6789-e89b-12d3-a456-426614174002",
        "title": "Título Original 2", 
        "description": "Descripción original",
        "status": "draft"
      }
    ],
    "improved_content": [
      {
        "id": "234e5678-e89b-12d3-a456-426614174001",
        "title": "Título Mejorado y Optimizado para SEO",
        "description": "Descripción mejorada con mayor impacto y keywords",
        "text": "Contenido mejorado con mejor estructura...",
        "status": "improved",
        "updated_at": "2024-01-15T10:30:00Z",
        "metadata": {
          "improved_at": "2024-01-15T10:30:00Z",
          "improved_by": "user_123",
          "improvement_notes": "Optimización SEO, mejora de estructura y fortalecimiento del CTA",
          "original_score": 65,
          "improved_score": 87,
          "improvements_applied": [
            "Reestructuración de párrafos",
            "Optimización de keywords",
            "Mejora de call-to-action",
            "Corrección de legibilidad"
          ]
        }
      }
    ],
    "improvements_summary": "Successfully improved 14 out of 15 content items"
  }
}
```

#### Respuestas de Error

**400 - Parámetros Inválidos**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "siteId is required"
  }
}
```

**400 - ContentIds Inválidos**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "contentIds must be an array of valid UUIDs"
  }
}
```

**404 - Sin Contenido Draft**
```json
{
  "success": false,
  "error": {
    "code": "NO_DRAFT_CONTENT",
    "message": "No draft content found for improvement"
  }
}
```

**500 - Error de Ejecución**
```json
{
  "success": false,
  "error": {
    "code": "COMMAND_EXECUTION_FAILED",
    "message": "The bulk content improvement command did not complete successfully in the expected time"
  }
}
```

### GET - Obtener Contenido en Draft

Obtiene lista de contenido en estado `draft` disponible para mejora en un sitio.

#### URL
```
GET /api/agents/copywriter/content-improve?siteId={siteId}&limit={limit}
```

#### Parámetros de Query

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `siteId` | string (UUID) | ✅ | ID del sitio |
| `segmentId` | string (UUID) | ❌ | Filtrar por segmento específico |
| `campaignId` | string (UUID) | ❌ | Filtrar por campaña específica |
| `limit` | number | ❌ | Límite de resultados (por defecto: 50) |

#### Ejemplo de Request

```
GET /api/agents/copywriter/content-improve?siteId=456e7890-e89b-12d3-a456-426614174001&limit=20
```

#### Respuesta Exitosa (200)

```json
{
  "success": true,
  "data": {
    "siteId": "456e7890-e89b-12d3-a456-426614174001",
    "segmentId": null,
    "campaignId": null,
    "draft_content": [
      {
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "title": "Guía de Marketing Digital",
        "description": "Una guía completa sobre marketing digital",
        "text": "Contenido del artículo...",
        "type": "blog_post",
        "status": "draft",
        "created_at": "2024-01-10T09:15:00Z",
        "site_id": "456e7890-e89b-12d3-a456-426614174001",
        "metadata": {
          "estimated_reading_time": 300,
          "keywords": ["marketing", "digital"]
        }
      },
      {
        "id": "234e5678-e89b-12d3-a456-426614174001",
        "title": "Estrategias de Conversión",
        "description": "Cómo optimizar tu funnel de ventas",
        "text": "Contenido sobre conversiones...",
        "type": "article",
        "status": "draft",
        "created_at": "2024-01-11T10:20:00Z",
        "site_id": "456e7890-e89b-12d3-a456-426614174001"
      }
    ],
    "total_items": 2
  }
}
```

## Flujo de Mejora Masiva de Contenido

1. **Consultar Contenido Draft**: Usar GET para ver todo el contenido disponible para mejora
2. **Configurar Mejoras**: Definir objetivos, palabras clave y parámetros para mejora masiva
3. **Ejecutar Mejora Masiva**: Enviar request POST con `siteId` para procesar todo el contenido draft
4. **Mejora Selectiva (Opcional)**: Usar `contentIds` para mejorar solo contenidos específicos
5. **Recibir Resultados**: Todos los contenidos se actualizan automáticamente en la base de datos

## Ventajas de la Mejora Masiva

### Consistencia
- **Estilo Unificado**: Mantiene coherencia de marca en todo el contenido
- **Terminología Consistente**: Usa vocabulario y tono uniformes
- **Calidad Homogénea**: Aplica los mismos estándares a todos los contenidos

### Eficiencia
- **Procesamiento Bulk**: Mejora múltiples contenidos en una sola operación
- **Optimización de Recursos**: Reduce el tiempo total de procesamiento
- **Análisis Conjunto**: Evalúa todo el contenido como un conjunto cohesivo

### Estrategia
- **Visión Holística**: Considera el contenido como parte de una estrategia integral
- **Optimización SEO Coordinada**: Distribuye keywords de forma estratégica
- **Mensaje Unificado**: Asegura que todo el contenido apoye los objetivos de negocio

## Estados del Contenido

- `draft`: Contenido disponible para mejora masiva
- `improved`: Contenido que ha sido mejorado por el agente
- `published`: Contenido publicado (no se incluye en mejora masiva)

## Metadatos de Mejora

Cada contenido mejorado incluye metadatos detallados:

- `improved_at`: Timestamp de la mejora
- `improved_by`: Usuario que solicitó la mejora
- `improvement_notes`: Notas sobre las mejoras aplicadas
- `original_score`: Puntuación de calidad antes de la mejora
- `improved_score`: Puntuación de calidad después de la mejora
- `improvements_applied`: Lista de mejoras específicas aplicadas

## Mejores Prácticas

### Para Mejora Masiva
1. **Objetivos Claros**: Define objetivos específicos que se apliquen a todo el contenido
2. **Keywords Estratégicas**: Proporciona palabras clave que funcionen para múltiples contenidos
3. **Estilo Consistente**: Especifica un estilo que funcione para todo el contenido del sitio
4. **Límites Apropiados**: Usa `limit` para controlar el volumen de procesamiento
5. **Monitoreo**: Revisa los resultados para identificar patrones y mejoras futuras

### Para Mejora Selectiva
1. **Selección Estratégica**: Elige contenidos que se beneficien de mejoras similares
2. **Objetivos Específicos**: Define mejoras particulares para el conjunto seleccionado
3. **Coordinación**: Asegúrate de que las mejoras se alineen con el resto del contenido

## Límites y Consideraciones

- **Volumen**: Por defecto procesa hasta 50 contenidos (configurable con `limit`)
- **Tiempo de Procesamiento**: Operaciones masivas pueden tomar hasta 2 minutos
- **Solo Draft**: Solo procesa contenido en estado `draft`
- **Actualizaciones Automáticas**: Los cambios se aplican directamente a la base de datos
- **Consistencia**: Mantiene coherencia entre todos los contenidos procesados
- **Rollback**: No hay función de rollback automático, revisa los resultados

## Códigos de Error

| Código | Descripción |
|--------|-------------|
| `INVALID_REQUEST` | Parámetros de request inválidos |
| `NO_DRAFT_CONTENT` | No se encontró contenido en draft para mejorar |
| `COMMAND_EXECUTION_FAILED` | Error en la ejecución del comando de mejora masiva |
| `NO_IMPROVED_CONTENT` | No se generó contenido mejorado |
| `DATABASE_UPDATE_FAILED` | Error al actualizar contenidos en la base de datos |
| `INTERNAL_SERVER_ERROR` | Error interno del servidor |

## Ejemplos de Uso

### Mejora Completa del Sitio
```javascript
// Mejorar todo el contenido draft de un sitio
const response = await fetch('/api/agents/copywriter/content-improve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    siteId: 'site-uuid',
    improvementGoals: [
      'Optimizar para SEO',
      'Mejorar legibilidad',
      'Fortalecer calls-to-action'
    ],
    keywords: ['producto', 'servicio', 'solución'],
    contentStyle: 'profesional y accesible'
  })
});
```

### Mejora de Contenidos Específicos
```javascript
// Mejorar solo contenidos seleccionados
const response = await fetch('/api/agents/copywriter/content-improve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    siteId: 'site-uuid',
    contentIds: ['content-1-uuid', 'content-2-uuid'],
    improvementGoals: ['Optimizar para conversión'],
    targetAudience: 'decisores de compra'
  })
});
```

### Consulta de Contenido Draft
```javascript
// Ver contenido disponible para mejora
const response = await fetch(
  '/api/agents/copywriter/content-improve?siteId=site-uuid&limit=20'
);
const data = await response.json();
console.log(`${data.data.total_items} contenidos disponibles para mejora`);
``` 