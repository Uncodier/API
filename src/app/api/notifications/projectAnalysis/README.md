# Project Analysis Notifications API

Este endpoint permite enviar notificaciones al equipo cuando se completa un análisis de proyecto con insights específicos.

## Endpoint

```
POST /api/notifications/projectAnalysis
```

## Parámetros de Entrada

### Requeridos

- `site_id` (string): UUID del sitio analizado
- `insights` (array): Lista de insights generados por el análisis

### Opcionales

- `analysis_type` (string): Tipo de análisis realizado (default: 'profile_update')
- `analysis_summary` (string): Resumen del análisis
- `impact_level` (enum): Nivel de impacto ('low', 'medium', 'high', 'critical')

## Estructura de Insights

Cada insight debe tener:

```typescript
{
  type: 'finding' | 'change' | 'recommendation' | 'alert',
  title: string,
  description: string,
  impact?: 'low' | 'medium' | 'high' | 'critical',
  category?: string,
  affected_area?: string,
  metadata?: Record<string, any>
}
```

## Ejemplos de Uso

### Ejemplo Básico

```json
{
  "site_id": "550e8400-e29b-41d4-a716-446655440000",
  "insights": [
    {
      "type": "finding",
      "title": "Industry Classification Updated",
      "description": "The AI agent identified and updated the company's industry classification based on the latest market trends.",
      "impact": "medium",
      "affected_area": "lead_scoring",
      "category": "industry"
    },
    {
      "type": "change",
      "title": "Target Audience Refined",
      "description": "The AI agent redefined the target audience segments to better align with current market position.",
      "impact": "high",
      "affected_area": "segmentation",
      "category": "targeting"
    },
    {
      "type": "recommendation",
      "title": "Review ICP Profiles",
      "description": "Please review and validate the updated Ideal Customer Profile segments.",
      "impact": "medium",
      "affected_area": "targeting",
      "metadata": {
        "priority": "high",
        "estimated_time": "30 minutes"
      }
    }
  ]
}
```

### Ejemplo Completo

```json
{
  "site_id": "550e8400-e29b-41d4-a716-446655440000",
  "insights": [
    {
      "type": "alert",
      "title": "Critical Data Inconsistency",
      "description": "Found inconsistencies in customer data that may affect lead scoring accuracy.",
      "impact": "critical",
      "affected_area": "data_quality",
      "category": "data_integrity",
      "metadata": {
        "records_affected": 1250,
        "data_sources": ["CRM", "Analytics"]
      }
    },
    {
      "type": "finding",
      "title": "New Market Opportunity",
      "description": "Analysis revealed a new market segment with high conversion potential.",
      "impact": "high",
      "affected_area": "market_analysis",
      "category": "opportunities"
    },
    {
      "type": "change",
      "title": "Persona Attributes Updated",
      "description": "Updated key persona attributes based on recent customer behavior analysis.",
      "impact": "medium",
      "affected_area": "personalization",
      "category": "personas"
    }
  ],
  "analysis_type": "comprehensive_audit",
  "analysis_summary": "Comprehensive site analysis completed with critical findings requiring immediate attention.",
  "impact_level": "critical"
}
```

## Respuesta

### Éxito (200)

```json
{
  "success": true,
  "data": {
    "site_id": "550e8400-e29b-41d4-a716-446655440000",
    "site_info": {
      "name": "Example Site"
    },
    "emails_sent": 2,
    "notifications_sent": 3,
    "analysis_summary": "AI agents have analyzed your site...",
    "key_findings_count": 1,
    "affected_areas_count": 2,
    "recommendations_count": 1,
    "sent_at": "2024-01-15T10:30:00Z"
  }
}
```

### Error de Validación (400)

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [
      {
        "message": "site_id debe ser un UUID válido",
        "path": ["site_id"]
      }
    ]
  }
}
```

### Sitio No Encontrado (404)

```json
{
  "success": false,
  "error": {
    "code": "SITE_NOT_FOUND",
    "message": "Site not found"
  }
}
```

## Tipos de Insights

### Finding
Descubrimientos o hallazgos importantes del análisis.

### Change
Cambios realizados en el perfil o configuración del sitio.

### Recommendation
Recomendaciones de acciones que el equipo debería tomar.

### Alert
Alertas urgentes que requieren atención inmediata.

## Áreas Afectadas Comunes

- `lead_scoring`: Puntuación de leads
- `segmentation`: Segmentación de audiencias
- `targeting`: Orientación de campañas
- `personalization`: Personalización de contenido
- `data_quality`: Calidad de datos
- `market_analysis`: Análisis de mercado
- `conversion_optimization`: Optimización de conversiones

## Categorías Comunes

- `industry`: Clasificación de industria
- `targeting`: Orientación y targeting
- `personas`: Perfiles de personas
- `data_integrity`: Integridad de datos
- `opportunities`: Oportunidades de mercado
- `performance`: Rendimiento y métricas 