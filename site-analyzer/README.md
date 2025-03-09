# Site Analyzer

Una aplicación web para analizar sitios web utilizando modelos de IA avanzados.

## Descripción

Site Analyzer es una herramienta que permite analizar sitios web y obtener información valiosa sobre su estructura, contenido, diseño y experiencia de usuario. Utiliza modelos de IA de diferentes proveedores (Anthropic, OpenAI, Google) para proporcionar análisis detallados y recomendaciones accionables.

## Características

- **Análisis Básico**: Obtén un resumen general, insights y recomendaciones sobre cualquier sitio web.
- **Análisis Detallado**: Análisis en profundidad con recomendaciones específicas para mejorar el sitio.
- **Análisis Estructurado**: Análisis detallado de la estructura del sitio, identificando bloques funcionales y su propósito.
- **Conversación**: Mantén una conversación con un modelo de IA sobre cualquier aspecto del sitio web.
- **Selección de Modelos**: Elige entre diferentes proveedores y modelos de IA (Claude, GPT, Gemini).
- **Capturas de Pantalla**: Opción para incluir capturas de pantalla en el análisis para una evaluación visual.
- **API Documentada**: API completa con documentación interactiva y playground para probar los endpoints.

## Tecnologías

- **Frontend**: Next.js, React, TypeScript, Tailwind CSS
- **Backend**: Next.js API Routes
- **IA**: Integración con Anthropic (Claude), OpenAI (GPT), Google (Gemini) a través de Portkey
- **Herramientas**: Puppeteer para capturas de pantalla, Cheerio para procesamiento HTML

## Seguridad

### Middleware de API

La aplicación incluye un middleware para las rutas de API que:

- Monitorea las solicitudes a rutas `/api` para asegurar que sigan la estructura de carpetas de la aplicación
- No bloquea ninguna ruta, permitiendo que toda la aplicación funcione normalmente
- Registra advertencias en la consola cuando se detectan rutas de API no estándar

Este middleware es completamente no intrusivo y solo tiene fines de monitoreo. No interfiere con el funcionamiento de Nextra ni con ninguna otra parte de la aplicación. Su único propósito es ayudar a identificar posibles problemas con las rutas de API.

Para probar el middleware, puedes usar cualquiera de estos métodos:

1. **Método recomendado**: Iniciar el servidor de desarrollo y realizar solicitudes a las rutas de API:
   ```bash
   npm run dev
   # Luego visita http://localhost:3000/api/conversation o cualquier otra ruta
   ```

2. **Usando el script de prueba**:
   ```bash
   # Primero compila el proyecto
   npm run build
   # Luego ejecuta el script de prueba
   node test-middleware.js
   ```

3. **Durante el desarrollo**: El middleware se ejecuta automáticamente para todas las solicitudes a rutas `/api/*` cuando el servidor está en ejecución.

## Instalación

1. Clona el repositorio:
   ```bash
   git clone https://github.com/tu-usuario/site-analyzer.git
   cd site-analyzer
   ```

2. Instala las dependencias:
   ```bash
   npm install
   # o
   yarn install
   ```

3. Crea un archivo `.env.local` con las siguientes variables:
   ```
   PORTKEY_API_KEY=tu_clave_de_portkey
   ANTHROPIC_API_KEY=tu_clave_de_anthropic
   AZURE_OPENAI_API_KEY=tu_clave_de_openai
   GEMINI_API_KEY=tu_clave_de_gemini
   ```

4. Inicia el servidor de desarrollo:
   ```bash
   npm run dev
   # o
   yarn dev
   ```

5. Abre [http://localhost:3000](http://localhost:3000) en tu navegador.

## Uso

### Interfaz Web

1. Ingresa la URL del sitio que deseas analizar.
2. Selecciona el tipo de análisis (Básico, Detallado, Estructurado o Conversación).
3. Elige el proveedor de IA y el modelo específico.
4. Decide si deseas incluir una captura de pantalla.
5. Haz clic en "Analizar sitio" o "Iniciar conversación".
6. Explora los resultados en las diferentes pestañas.

### API

La API está disponible en los siguientes endpoints:

#### Documentación Interactiva

Para probar los endpoints de forma interactiva, visita la documentación en [/api/docs](/api/docs). Esta interfaz te permite:

- Ver todos los endpoints disponibles
- Probar cada endpoint con parámetros personalizados
- Ver ejemplos de solicitudes y respuestas
- Ejecutar solicitudes en tiempo real

#### Referencia de Endpoints

##### `POST /api/analyze`

Realiza un análisis básico de un sitio web.

**Solicitud:**
```json
{
  "url": "https://example.com"
}
```

**Respuesta:**
```json
{
  "success": true,
  "result": {
    "summary": "Este es un sitio web de ejemplo con una estructura simple...",
    "insights": [
      "El sitio tiene una navegación clara y accesible",
      "La página de inicio presenta claramente el propósito del sitio"
    ],
    "recommendations": [
      {
        "issue": "Falta de llamadas a la acción claras",
        "solution": "Añadir botones CTA más prominentes en la página de inicio",
        "priority": "high"
      }
    ],
    "metadata": {
      "analyzed_by": "Claude 3.5 Sonnet",
      "timestamp": "2023-07-15T12:34:56Z",
      "status": "success"
    }
  }
}
```

##### `POST /api/site/analyze`

Realiza un análisis avanzado con opciones personalizables.

**Solicitud:**
```json
{
  "url": "https://example.com",
  "options": {
    "analysisType": "basic", // "basic", "detailed", "structured"
    "depth": 2,
    "timeout": 30000,
    "includeScreenshot": true,
    "provider": "anthropic", // "anthropic", "openai", "gemini"
    "modelId": "claude-3-5-sonnet-20240620"
  }
}
```

**Respuesta (para analysisType="basic" o "detailed"):**
```json
{
  "success": true,
  "analysisType": "basic",
  "result": {
    "summary": "Este es un sitio web de ejemplo con una estructura simple...",
    "insights": [
      "El sitio tiene una navegación clara y accesible",
      "La página de inicio presenta claramente el propósito del sitio"
    ],
    "recommendations": [
      {
        "issue": "Falta de llamadas a la acción claras",
        "solution": "Añadir botones CTA más prominentes en la página de inicio",
        "priority": "high"
      }
    ]
  }
}
```

**Respuesta (para analysisType="structured"):**
```json
{
  "success": true,
  "analysisType": "structured",
  "result": {
    "structuredAnalysis": {
      "site_info": {
        "url": "https://example.com",
        "title": "Example Domain",
        "description": "This domain is for use in illustrative examples",
        "language": "en"
      },
      "blocks": [
        {
          "id": "header-1",
          "type": "header",
          "section_type": "navigation",
          "selector": "header",
          "classes": ["main-header"],
          "content_type": "navigation",
          "description": "Cabecera principal del sitio",
          "relevance": {
            "score": 90,
            "reason": "Elemento crítico para la navegación"
          },
          "children": 3,
          "text_length": 45,
          "location": {
            "position": "top",
            "coordinates": {
              "top": 0,
              "left": 0
            }
          },
          "content_list": ["Home", "About", "Contact"]
        }
        // Más bloques...
      ],
      "hierarchy": {
        "main_sections": ["header", "hero", "features", "footer"],
        "navigation_structure": []
      },
      "overview": {
        "total_blocks": 12,
        "primary_content_blocks": 5,
        "navigation_blocks": 2,
        "interactive_elements": 8
      },
      "metadata": {
        "analyzed_by": "Claude 3.5 Sonnet",
        "timestamp": "2023-07-15T12:34:56Z",
        "status": "success"
      }
    }
  }
}
```

##### `POST /api/ai`

Envía mensajes a un modelo de IA y recibe respuestas.

**Solicitud:**
```json
{
  "messages": [
    { "role": "user", "content": "Hola, ¿puedes ayudarme con mi sitio web?" }
  ],
  "modelType": "anthropic", // "anthropic", "openai", "gemini"
  "modelId": "claude-3-5-sonnet-20240620"
}
```

**Respuesta:**
```json
{
  "id": "msg_01234567890",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "¡Hola! Claro que puedo ayudarte con tu sitio web. ¿Qué tipo de ayuda necesitas? Puedo ofrecerte consejos sobre diseño, usabilidad, SEO, rendimiento, o cualquier otro aspecto que te interese mejorar."
      }
    }
  ]
}
```

##### `POST /api/conversation`

Mantén una conversación contextual sobre un sitio web con un modelo de IA.

**Solicitud:**
```json
{
  "messages": [
    { "role": "user", "content": "Hola, ¿puedes ayudarme con mi sitio web?" }
  ],
  "modelType": "anthropic", // "anthropic", "openai", "gemini"
  "modelId": "claude-3-5-sonnet-20240620",
  "includeScreenshot": false,
  "siteUrl": "https://example.com"
}
```

**Respuesta:**
```json
{
  "id": "msg_01234567890",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "¡Hola! Claro que puedo ayudarte con tu sitio web example.com. ¿Qué aspectos específicos te gustaría mejorar o qué preguntas tienes sobre él?"
      }
    }
  ]
}
```

#### Códigos de Estado HTTP

- `200 OK`: La solicitud se completó correctamente
- `400 Bad Request`: Parámetros incorrectos o faltantes
- `401 Unauthorized`: Autenticación requerida o inválida
- `404 Not Found`: Recurso no encontrado
- `500 Internal Server Error`: Error del servidor

#### Límites de Uso

- Máximo de 100 solicitudes por hora por IP
- Tamaño máximo de respuesta: 10MB
- Tiempo máximo de procesamiento: 60 segundos

## Estructura del Proyecto

```
site-analyzer/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── analyze/
│   │   │   ├── ai/
│   │   │   ├── conversation/
│   │   │   ├── docs/
│   │   │   └── site/
│   │   ├── components/
│   │   │   ├── ConversationUI.tsx
│   │   │   └── StructuredAnalysis.tsx
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── lib/
│   │   ├── actions/
│   │   ├── agents/
│   │   ├── config/
│   │   ├── prompts/
│   │   ├── services/
│   │   ├── types/
│   │   └── utils/
│   │       ├── api-utils.ts
│   │       ├── dev-helpers.ts
│   │       ├── html-preprocessor.ts
│   │       ├── html-utils.ts
│   │       ├── image-utils.ts
│   │       └── message-utils.ts
├── public/
├── .env.local
├── next.config.js
├── package.json
├── tailwind.config.js
└── tsconfig.json
```

## Componentes Principales

### ConversationUI

Componente que proporciona una interfaz de chat para mantener conversaciones con modelos de IA sobre sitios web.

```tsx
<ConversationUI 
  provider="anthropic" 
  modelId="claude-3-5-sonnet-20240620"
  includeScreenshot={true}
  siteUrl="https://example.com"
/>
```

### StructuredAnalysis

Componente que muestra el análisis estructurado de un sitio web, organizando la información en bloques funcionales.

```tsx
<StructuredAnalysis analysisData={structuredData} />
```

## Utilidades

El proyecto incluye varias utilidades para facilitar el desarrollo:

### dev-helpers.ts

Funciones auxiliares para desarrollo y depuración:

```typescript
// Formatear un objeto para la consola
prettyLog(data, 'User Data');

// Medir tiempo de ejecución
const result = await measureTime(
  async () => await fetchData(),
  'Fetch Data'
);

// Validar datos de análisis
const validation = validateAnalysisData(analysisData);
if (!validation.valid) {
  console.error(`Errores: ${validation.errors.join(', ')}`);
}

// Crear un logger con prefijo
const logger = createPrefixedLogger('AnalyzerService');
logger.info('Iniciando análisis');
```

### api-utils.ts

Funciones para manejar llamadas a la API y procesar respuestas:

```typescript
// Preparar datos para análisis
const { screenshotData, processedImage, htmlContent } = 
  await prepareAnalysisData(request);

// Llamar a la API con un mensaje
const response = await callApiWithMessage(
  messages,
  'anthropic',
  'claude-3-5-sonnet-20240620'
);

// Manejar respuestas JSON incompletas
const processedResponse = await handleIncompleteJsonResponse(
  response,
  messages,
  'anthropic',
  'claude-3-5-sonnet-20240620'
);
```

### message-utils.ts

Funciones para crear mensajes para las APIs de IA:

```typescript
// Crear mensaje con imagen
const message = createVisionMessage(
  'Analiza esta página web',
  screenshotData,
  systemPrompt,
  'anthropic'
);

// Crear mensaje básico
const message = createBasicMessage(
  'Analiza esta URL: https://example.com',
  systemPrompt
);
```

## Contribución

Las contribuciones son bienvenidas. Por favor, sigue estos pasos:

1. Haz fork del repositorio
2. Crea una rama para tu característica (`git checkout -b feature/amazing-feature`)
3. Haz commit de tus cambios (`git commit -m 'Add some amazing feature'`)
4. Haz push a la rama (`git push origin feature/amazing-feature`)
5. Abre un Pull Request

## Licencia

Este proyecto está licenciado bajo la Licencia MIT - ver el archivo [LICENSE](LICENSE) para más detalles.

## Contacto

Tu Nombre - [@tu_twitter](https://twitter.com/tu_twitter) - email@example.com

Enlace del proyecto: [https://github.com/tu-usuario/site-analyzer](https://github.com/tu-usuario/site-analyzer)

## Documentación de la API

Site Analyzer proporciona una API completa para analizar sitios web y obtener información valiosa sobre su estructura, contenido, diseño y experiencia de usuario.

### Acceso a la Documentación

Puedes acceder a la documentación de la API de las siguientes maneras:

1. **Documentación Interactiva**: Visita `/api/docs` en el navegador para acceder a la documentación interactiva con un playground para probar los endpoints.

2. **Archivo API.md**: Consulta el archivo [API.md](./API.md) para una referencia completa de todos los endpoints, parámetros, ejemplos y guías de integración.

3. **Información por Endpoint**: Realiza una solicitud GET a cualquier endpoint de la API para obtener información básica sobre cómo usarlo:
   - `GET /api/analyze`
   - `GET /api/site/analyze`
   - `GET /api/ai`
   - `GET /api/conversation`
   - `GET /api/docs`

### Endpoints Principales

- **POST /api/analyze**: Análisis básico de un sitio web
- **POST /api/site/analyze**: Análisis avanzado con opciones personalizables
- **POST /api/ai**: Interacción directa con modelos de IA
- **POST /api/conversation**: Conversación contextual sobre un sitio web

### Ejemplo de Uso

```javascript
// Ejemplo de análisis básico
async function analyzeSite(url) {
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    });
    
    if (!response.ok) {
      throw new Error(`Error: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error al analizar el sitio:', error);
    throw error;
  }
}
``` 