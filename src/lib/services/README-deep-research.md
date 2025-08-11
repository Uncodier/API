# Deep Research Operation

Sistema avanzado de investigación que combina búsquedas en DuckDuckGo con filtros de fecha precisos y análisis opcional de contenido usando Tavily AI.

## 🚀 Características Principales

### 🔍 Búsquedas Especializadas
- **LLM News**: Noticias específicas sobre modelos de lenguaje en Hacker News
- **General News**: Búsquedas personalizables en múltiples fuentes
- **Custom Search**: Control completo sobre parámetros de búsqueda

### 📅 Filtros de Fecha Precisos
- Sintaxis DuckDuckGo: `after:YYYY-MM-DD` y `before:YYYY-MM-DD`
- Rangos temporales específicos para análisis de tendencias
- Búsquedas históricas y de actualidad

### 🧠 Análisis de Contenido con IA
- Resúmenes automáticos de artículos encontrados
- Extracción de puntos clave y insights
- Análisis de sentimiento y relevancia
- Dos niveles de profundidad: básico y avanzado

## 📁 Estructura de Archivos

```
src/
├── lib/services/
│   ├── duckduckgo-search-service.ts    # Servicio principal de búsqueda
│   └── README-deep-research.md         # Esta documentación
├── app/api/deepResearch/
│   └── operation/
│       └── route.ts                    # Endpoint principal
├── components/ApiTester/
│   └── apis/
│       └── deep-research-operation.tsx # Configuración del tester
├── content/rest-api/analysis/
│   └── deep-research-operation.mdx     # Documentación MDX
├── examples/
│   └── deep-research-operation-example.ts # Ejemplos de uso
└── scripts/
    └── test-deep-research-operation.mjs   # Script de pruebas
```

## 🛠️ Uso Básico

### API Endpoint
```http
POST /api/deepResearch/operation
```

### Ejemplo: Noticias LLM
```javascript
const response = await fetch('/api/deepResearch/operation', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    operation_type: 'llm_news',
    date_from: '2024-01-01',
    date_to: '2024-12-31',
    keywords: ['ChatGPT', 'Claude', 'OpenAI'],
    max_results: 50,
    include_content_analysis: true
  })
});
```

### Ejemplo: Búsqueda General
```javascript
const response = await fetch('/api/deepResearch/operation', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    operation_type: 'general_news',
    query: 'artificial intelligence startups',
    date_from: '2024-06-01',
    sources: ['techcrunch.com', 'venturebeat.com'],
    max_results: 30
  })
});
```

## 🔧 Configuración

### Variables de Entorno Requeridas
```bash
TAVILY_API_KEY=your_tavily_api_key_here
NEXT_PUBLIC_APP_URL=http://localhost:3000  # Para desarrollo
```

### Dependencias
- `cheerio`: Para parsing de HTML
- `zod`: Para validación de schemas
- Servicios existentes: `fetchHtml`, `cleanHtmlContent`, `searchWithTavily`

## 📊 Respuesta de la API

### Estructura de Respuesta Exitosa
```json
{
  "success": true,
  "operation_type": "llm_news",
  "query": "LLM and AI news",
  "date_range": {
    "from": "2024-01-01",
    "to": "2024-12-31"
  },
  "results": [
    {
      "title": "ChatGPT-4 Shows Remarkable Improvements",
      "url": "https://news.ycombinator.com/item?id=123456",
      "snippet": "Discussion about latest improvements...",
      "domain": "news.ycombinator.com",
      "publishedDate": "2024-03-15",
      "content_analysis": {
        "summary": "Article discusses significant improvements...",
        "key_points": ["40% improvement in reasoning", "..."],
        "sentiment": "positive",
        "relevance_score": 8.5
      }
    }
  ],
  "total_results": 25,
  "processing_time_ms": 3450,
  "analysis_included": true
}
```

## 🎯 Casos de Uso

### 1. Monitoreo de Competidores
```javascript
{
  operation_type: 'general_news',
  query: 'OpenAI OR Anthropic OR Google AI',
  sources: ['techcrunch.com', 'theverge.com'],
  include_content_analysis: true
}
```

### 2. Investigación Académica
```javascript
{
  operation_type: 'custom_search',
  query: 'multimodal AI OR vision language models',
  sources: ['arxiv.org', 'paperswithcode.com'],
  analysis_depth: 'advanced'
}
```

### 3. Análisis de Mercado
```javascript
{
  operation_type: 'general_news',
  query: 'AI startup funding',
  date_from: '2024-01-01',
  max_results: 100,
  include_content_analysis: false
}
```

### 4. Tendencias Recientes
```javascript
{
  operation_type: 'llm_news',
  date_from: '2024-12-01', // Último mes
  keywords: ['AGI', 'reasoning', 'multimodal'],
  include_content_analysis: true
}
```

## 🧪 Testing

### Script de Pruebas
```bash
# Prueba básica
node src/scripts/test-deep-research-operation.mjs

# Prueba específica
node src/scripts/test-deep-research-operation.mjs --type=llm_news --days=7

# Ver ayuda
node src/scripts/test-deep-research-operation.mjs --help
```

### Documentación Interactiva
Visita `/api/deepResearch/operation` en tu navegador para ver la documentación completa y usar el tester interactivo.

## ⚡ Optimización

### Rendimiento
- Usar `max_results` apropiados (recomendado: 10-50)
- Habilitar `include_content_analysis` solo cuando sea necesario
- Usar rangos de fechas específicos para mejorar relevancia

### Rate Limiting
- El servicio incluye pausas automáticas entre análisis de contenido
- Límite de 10 URLs por análisis con Tavily
- Timeout de 30 segundos para requests HTML

### Precisión de Búsqueda
- Combinar términos generales y específicos
- Usar `sources` para enfocar búsquedas
- Aprovechar filtros de fecha para contexto temporal

## 🔍 Troubleshooting

### Errores Comunes
1. **`TAVILY_API_KEY not found`**: Configurar variable de entorno
2. **`Query is required`**: Agregar query para general_news y custom_search
3. **`Search operation failed`**: Verificar conectividad y format de fechas
4. **Resultados vacíos**: Ajustar rango de fechas o términos de búsqueda

### Debug
- Logs detallados en consola del servidor
- Tiempo de procesamiento incluido en respuesta
- Error codes específicos para diferentes fallos

## 🚀 Roadmap

### Futuras Mejoras
- [ ] Soporte para más fuentes de noticias
- [ ] Caché inteligente de resultados
- [ ] Análisis de tendencias temporales
- [ ] Exportación de resultados a diferentes formatos
- [ ] Webhooks para monitoreo continuo
- [ ] Integración con sistemas de notificaciones

### Integraciones Planeadas
- [ ] RSS feeds automáticos
- [ ] Slack/Discord notifications
- [ ] Dashboard de tendencias
- [ ] API de subscripciones

## 📝 Licencia

Este código es parte del proyecto API interno y sigue las mismas políticas de licencia del proyecto principal.

