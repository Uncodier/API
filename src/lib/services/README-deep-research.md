# Deep Research Operation

Investigación mediante Azure OpenAI Responses con Bing web search. Los ejemplos
activos usan `POST /api/agents/tools/webSearch`; el servidor llama HTTP
`POST /openai/v1/responses` con `web_search` y `store: false`.

**Nota histórica:** esta guía describía `/api/deepResearch/operation`, búsquedas
DuckDuckGo y análisis opcional con Tavily. Esa ruta no está presente en este
árbol; el servicio DuckDuckGo heredado sigue siendo una implementación distinta.
Sus operadores de fecha no representan filtros estrictos de Azure Bing. Sus
búsquedas primarias siguen intactas; el respaldo usa ahora Azure y rechaza
filtros de fecha o región que no puede respetar.

## 🚀 Características Principales

### 🔍 Búsquedas Especializadas
- **LLM News**: Consultas sobre modelos de lenguaje con dominios de interés
- **General News**: Investigación en múltiples fuentes indexadas
- **Custom Search**: Consultas personalizadas con las opciones compatibles

### 📅 Fechas y actualidad: límites explícitos
- Los filtros de fecha estrictos (`date_from`, `date_to`, `time_range`) no se
  soportan y se rechazan; no enviar estos parámetros.
- Un período escrito en `query` es intención de búsqueda, no un filtro garantizado.
- Los datos son indexados/cacheados, no scraping en vivo. Las fechas de publicación
  no están garantizadas; verificarlas en la fuente.

### 🧠 Análisis de Contenido con IA
- `include_answer: true` solicita una respuesta de IA basada en la búsqueda.
- Los snippets no son el artículo completo. Contenido crudo e `include_images: true`
  no se soportan y se rechazan.
- No se inventa un score de relevancia ni se promete análisis de sentimiento.
- `search_depth` controla presupuestos máximos de llamadas, no profundidad equivalente a Tavily:

| Nivel | Máximo de llamadas web | Razonamiento |
| --- | --- | --- |
| `basic` (por defecto) | 1 | `low` |
| `advanced` | 2 | `medium` |
| `comprehensive` | 3 | `medium` |

`max_results` es un límite **local** de 1–20 (por defecto 5 en `webSearch`),
no una garantía del número de resultados devueltos por Bing.
El alias heredado `limit` permite los mismos valores; si se envían ambos deben
coincidir. La consolidación posterior de análisis conserva las URLs de fuentes
y las anotaciones de citas incluso cuando quedan fuera del límite de resultados.

## 📁 Estructura de Archivos

```
src/
├── lib/services/
│   ├── search/data-analyst-search.ts   # Integración compartida de búsqueda
│   ├── search/web-search.ts           # Proveedor Azure Bing y normalización
│   ├── analysis/search-memory-data.ts # Consolidación y atribución compartidas
│   ├── deep-research-service.ts       # Orquestación de investigaciones
│   ├── duckduckgo-search-service.ts   # Servicio heredado distinto
│   └── README-deep-research.md        # Esta documentación
├── app/api/agents/tools/webSearch/
│   └── route.ts                       # Endpoint de búsqueda
├── content/mcp-server/
│   └── media.mdx                      # Documentación MCP
└── examples/
    └── deep-research-operation-example.ts # Ejemplos de uso
```

## 🛠️ Uso Básico

### API Endpoint
```http
POST /api/agents/tools/webSearch
```

### Ejemplo: Noticias LLM
```javascript
const response = await fetch('/api/agents/tools/webSearch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'ChatGPT Claude OpenAI language model news',
    include_domains: ['news.ycombinator.com'],
    search_depth: 'basic',
    max_results: 10,
    include_answer: true
  })
});
```

### Ejemplo: Búsqueda General
```javascript
const response = await fetch('/api/agents/tools/webSearch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'artificial intelligence startups',
    include_domains: ['techcrunch.com', 'venturebeat.com'],
    search_depth: 'advanced',
    max_results: 20,
    include_answer: true
  })
});
```

## 🔧 Configuración

### Variables de entorno del servidor

Selección del par endpoint/clave, en orden:

1. `AZURE_OPENAI_SEARCH_ENDPOINT` + `AZURE_OPENAI_SEARCH_API_KEY`: par dedicado opcional.
2. Si no está configurado, `MICROSOFT_AZURE_OPENAI_ENDPOINT` +
   `MICROSOFT_AZURE_OPENAI_API_KEY` si cualquiera está configurado.
3. Si no, `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY`.

Si cualquiera de los valores de un par seleccionado está configurado, **ambos
son obligatorios**. Un par incompleto falla; no se mezclan pares ni se continúa
al siguiente. La selección de deployment es independiente:
`AZURE_OPENAI_SEARCH_DEPLOYMENT`, si no `MICROSOFT_AZURE_OPENAI_DEPLOYMENT`, si no
`AZURE_OPENAI_DEPLOYMENT`.

Usar un deployment **existente**, habilitado para razonamiento, que soporte
`web_search_call.results` en el recurso seleccionado. Se probó `gpt-5.2`; ese
nombre de modelo no crea un deployment ni garantiza soporte en otro recurso.
No se requiere una versión de API de chat para `/openai/v1/responses`.

Plantilla sin credenciales; configurar solo el par y deployment seleccionados:

```bash
AZURE_OPENAI_SEARCH_ENDPOINT=
AZURE_OPENAI_SEARCH_API_KEY=
AZURE_OPENAI_SEARCH_DEPLOYMENT=
MICROSOFT_AZURE_OPENAI_ENDPOINT=
MICROSOFT_AZURE_OPENAI_API_KEY=
MICROSOFT_AZURE_OPENAI_DEPLOYMENT=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_DEPLOYMENT=
```

El **servidor API necesita los secretos Azure seleccionados en Vercel**, no en
variables `NEXT_PUBLIC_*` ni en el cliente MCP. La configuración local no
configura producción. Esta migración de documentación no edita archivos privados
`.env`, crea recursos ni despliega. Ver `src/config/env.example` para la plantilla completa.

### Dependencias
- `zod`: Validación de parámetros del endpoint.
- HTTP `fetch`: Llamadas Azure Responses desde el servidor.
- La orquestación Deep Research usa la integración compartida de búsqueda;
  no requiere credenciales Tavily para la búsqueda migrada.

### Coste y cumplimiento
- Los créditos comerciales permanecen en **0.1 por consulta**.
- El coste del proveedor Azure es independiente: tokens de entrada/salida del
  modelo más Bing `num_requests`, no un precio fijo por consulta.
- Bing grounding es un **límite de cumplimiento separado**: revisar términos
  Bing y requisitos de tratamiento de datos. `store: false` no garantiza retención,
  residencia ni equivalencia con el cumplimiento del procesamiento del modelo Azure.

## 📊 Respuesta de la API

### Estructura de Respuesta Exitosa

Respuesta ilustrativa de `webSearch`, no datos reales ni garantía de campos
opcionales. No contiene fechas de publicación, contenido crudo o scores inventados.

```json
{
  "success": true,
  "data": {
    "query": "LLM and AI news",
    "answer": "Illustrative research summary; verify the cited sources.",
    "results": [
      {
        "title": "Illustrative language model research article",
        "url": "https://example.invalid/research",
        "content": "Illustrative search snippet, not the raw article."
      }
    ]
  }
}
```

## 🎯 Casos de Uso

### 1. Monitoreo de Competidores
```javascript
{
  query: 'OpenAI OR Anthropic OR Google AI',
  include_domains: ['techcrunch.com', 'theverge.com'],
  include_answer: true,
  max_results: 20
}
```

### 2. Investigación Académica
```javascript
{
  query: 'multimodal AI OR vision language models',
  include_domains: ['arxiv.org', 'paperswithcode.com'],
  search_depth: 'comprehensive',
  max_results: 20
}
```

### 3. Análisis de Mercado
```javascript
{
  query: 'AI startup funding',
  max_results: 20,
  include_answer: false
}
```

### 4. Tendencias Recientes
```javascript
{
  query: 'recent AGI reasoning multimodal research trends',
  search_depth: 'basic',
  max_results: 10,
  include_answer: true
}
```

## 🧪 Testing

### Verificación offline
- Simular Azure Responses y verificar límites locales, selección de pares completos
  y rechazo de imágenes, contenido crudo y filtros de fecha estrictos.
- Mantener aserciones de redacción de cada valor sensible. Generar credenciales
  sintéticas en runtime con `node:crypto`, no copiarlas de `.env` ni de producción.
- Los ejemplos no deben fabricar scores, fechas ni garantías de frescura.

### Prueba en vivo opcional
`testDeepResearchAPI()` en `src/examples/deep-research-operation-example.ts` llama
al servidor configurado mediante `NEXT_PUBLIC_APP_URL` (localhost por defecto).
Ejecutarlo solo con autorización y secretos del servidor configurados: genera
coste Azure/Bing. No es una prueba offline ni un despliegue. No registrar secretos,
URLs autenticadas ni respuestas de error del proveedor sin redacción.

## ⚡ Optimización

### Rendimiento
- Usar `max_results` entre 1 y 20; es un límite local, no una petición de cantidad a Bing.
- Habilitar `include_answer` solo cuando sea necesario.
- Usar `basic` por defecto; `advanced` y `comprehensive` aumentan presupuesto y coste.
- No prometer latencia fija ni profundidad equivalente a Tavily.

### Rate Limiting
- Aplican las cuotas del recurso/deployment Azure y del servicio Bing.
- Los presupuestos máximos de 1/2/3 llamadas web no garantizan el mismo
  `num_requests` facturado ni el mismo número de resultados.
- Un límite local menor no garantiza menor uso de tokens o llamadas del proveedor.

### Precisión de Búsqueda
- Combinar términos generales y específicos
- Usar `include_domains` / `exclude_domains` para enfocar búsquedas.
- Verificar las fuentes y fechas; contexto temporal en la consulta no es un filtro estricto.

## 🔍 Troubleshooting

### Errores Comunes
1. **Configuración Azure incompleta**: Verificar ambas variables del par seleccionado
   en el servidor Vercel; no mezclar pares ni publicar secretos.
2. **Query ausente**: Enviar `query` no vacío a `webSearch`.
3. **Deployment incompatible o inexistente**: Verificar recurso y precedencia del
   deployment, razonamiento habilitado y soporte de `web_search_call.results`.
4. **Parámetros rechazados**: No pedir `include_images: true`, contenido crudo ni
   filtros de fecha estrictos; usar `max_results` de 1–20.
5. **Resultados vacíos o desactualizados**: Ajustar términos/dominios y verificar
   fuentes; Bing indexado/cacheado no garantiza datos en vivo.

### Debug
- Revisar solo diagnósticos redactados del servidor; no imprimir claves ni cuerpos
  de error sin sanitizar.
- Verificar configuración y capacidades por separado de las credenciales del cliente.

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
