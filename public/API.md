# API de Site Analyzer

Este documento proporciona una referencia completa de la API de Site Analyzer, incluyendo todos los endpoints disponibles, parámetros, ejemplos de solicitudes y respuestas.

## Índice

- [Introducción](#introducción)
- [Autenticación](#autenticación)
- [Endpoints](#endpoints)
  - [Análisis Básico](#análisis-básico)
  - [Análisis de Sitio](#análisis-de-sitio)
  - [API de IA](#api-de-ia)
  - [Conversación](#conversación)
- [Modelos y Proveedores](#modelos-y-proveedores)
- [Códigos de Estado](#códigos-de-estado)
- [Límites de Uso](#límites-de-uso)
- [Ejemplos de Integración](#ejemplos-de-integración)

## Introducción

La API de Site Analyzer permite analizar sitios web y obtener información valiosa sobre su estructura, contenido, diseño y experiencia de usuario utilizando modelos de IA avanzados. La API está diseñada para ser fácil de usar y proporciona diferentes niveles de análisis según las necesidades del usuario.

Para una documentación interactiva con un playground para probar los endpoints, visita `/docs` en tu navegador.

## Autenticación

Actualmente, la API no requiere autenticación para uso local. Para implementaciones en producción, se recomienda implementar un sistema de autenticación basado en tokens JWT o API keys.

## Endpoints

### Análisis Básico

**Endpoint:** `POST /api/analyze`

Realiza un análisis básico de un sitio web, proporcionando un resumen, insights y recomendaciones.

#### Parámetros de la Solicitud

| Parámetro | Tipo   | Requerido | Descripción                   |
|-----------|--------|-----------|-------------------------------|
| url       | string | Sí        | URL del sitio web a analizar  |

#### Ejemplo de Solicitud

```json
{
  "url": "https://example.com"
}
```

#### Ejemplo de Respuesta

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

### Análisis de Sitio

**Endpoint:** `POST /api/site/analyze`

Realiza un análisis avanzado con opciones personalizables, incluyendo diferentes tipos de análisis, selección de modelo y captura de pantalla.

#### Parámetros de la Solicitud

| Parámetro | Tipo   | Requerido | Descripción                                                |
|-----------|--------|-----------|-----------------------------------------------------------|
| url       | string | Sí        | URL del sitio web a analizar                               |
| options   | object | No        | Opciones de análisis (ver tabla de opciones a continuación)|

#### Opciones de Análisis

| Opción           | Tipo    | Valor por defecto | Descripción                                                |
|------------------|---------|-------------------|-----------------------------------------------------------|
| analysisType     | string  | "basic"           | Tipo de análisis: "basic", "detailed" o "structured"       |
| depth            | number  | 2                 | Profundidad del análisis (1-3)                             |
| timeout          | number  | 30000            | Tiempo máximo de espera en milisegundos                    |
| includeScreenshot| boolean | true              | Si se debe incluir una captura de pantalla en el análisis  |
| provider         | string  | "anthropic"       | Proveedor de IA: "anthropic", "openai" o "gemini"          |
| modelId          | string  | (depende del proveedor) | ID del modelo específico a utilizar                  |

#### Ejemplo de Solicitud

```json
{
  "url": "https://example.com",
  "options": {
    "analysisType": "structured",
    "depth": 2,
    "timeout": 30000,
    "includeScreenshot": true,
    "provider": "anthropic",
    "modelId": "claude-3-5-sonnet-20240620"
  }
}
```

#### Ejemplo de Respuesta (analysisType="basic" o "detailed")

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

#### Ejemplo de Respuesta (analysisType="structured")

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

### API de IA

**Endpoint:** `POST /api/ai`

Envía mensajes a un modelo de IA y recibe respuestas.

#### Parámetros de la Solicitud

| Parámetro | Tipo     | Requerido | Descripción                                      |
|-----------|----------|-----------|--------------------------------------------------|
| messages  | array    | Sí        | Array de mensajes en formato de chat             |
| modelType | string   | No        | Proveedor de IA (por defecto: "anthropic")       |
| modelId   | string   | No        | ID del modelo específico a utilizar              |

#### Formato de Mensajes

| Campo   | Tipo   | Descripción                                      |
|---------|--------|--------------------------------------------------|
| role    | string | Rol del emisor: "user", "assistant" o "system"   |
| content | string | Contenido del mensaje                            |

#### Ejemplo de Solicitud

```json
{
  "messages": [
    { "role": "user", "content": "Hola, ¿puedes ayudarme con mi sitio web?" }
  ],
  "modelType": "anthropic",
  "modelId": "claude-3-5-sonnet-20240620"
}
```

#### Ejemplo de Respuesta

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

### Conversación

**Endpoint:** `POST /api/conversation`

Mantén una conversación contextual sobre un sitio web con un modelo de IA.

#### Parámetros de la Solicitud

| Parámetro        | Tipo     | Requerido | Descripción                                      |
|------------------|----------|-----------|--------------------------------------------------|
| messages         | array    | Sí        | Array de mensajes en formato de chat             |
| modelType        | string   | No        | Proveedor de IA (por defecto: "anthropic")       |
| modelId          | string   | No        | ID del modelo específico a utilizar              |
| includeScreenshot| boolean  | No        | Si se debe incluir una captura de pantalla       |
| siteUrl          | string   | No        | URL del sitio web sobre el que se conversa       |

#### Ejemplo de Solicitud

```json
{
  "messages": [
    { "role": "user", "content": "Hola, ¿puedes ayudarme con mi sitio web?" }
  ],
  "modelType": "anthropic",
  "modelId": "claude-3-5-sonnet-20240620",
  "includeScreenshot": false,
  "siteUrl": "https://example.com"
}
```

#### Ejemplo de Respuesta

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

## Modelos y Proveedores

La API soporta los siguientes proveedores y modelos:

### Anthropic (Claude)

- `claude-3-opus-20240229`: Claude 3 Opus
- `claude-3-sonnet-20240229`: Claude 3 Sonnet
- `claude-3-haiku-20240307`: Claude 3 Haiku
- `claude-3-5-sonnet-20240620`: Claude 3.5 Sonnet
- `claude-2.1`: Claude 2.1
- `claude-instant-1.2`: Claude Instant

### OpenAI (GPT)

- `gpt-5-nano`: GPT-5 Nano
- `gpt-4-vision-preview`: GPT-4 Vision
- `gpt-4-turbo`: GPT-4 Turbo
- `gpt-4`: GPT-4
- `gpt-3.5-turbo`: GPT-3.5 Turbo

### Google (Gemini)

- `gemini-1.5-pro`: Gemini 1.5 Pro
- `gemini-1.5-flash`: Gemini 1.5 Flash
- `gemini-pro-vision`: Gemini Pro Vision
- `gemini-pro`: Gemini Pro

## Códigos de Estado

La API utiliza los siguientes códigos de estado HTTP:

| Código | Descripción                                                |
|--------|-----------------------------------------------------------|
| 200    | OK - La solicitud se completó correctamente                |
| 400    | Bad Request - Parámetros incorrectos o faltantes           |
| 401    | Unauthorized - Autenticación requerida o inválida          |
| 404    | Not Found - Recurso no encontrado                          |
| 429    | Too Many Requests - Se ha excedido el límite de solicitudes|
| 500    | Internal Server Error - Error del servidor                 |

## Límites de Uso

- Máximo de 100 solicitudes por hora por IP
- Tamaño máximo de respuesta: 10MB
- Tiempo máximo de procesamiento: 60 segundos

## Ejemplos de Integración

### JavaScript (Fetch)

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

// Ejemplo de conversación
async function startConversation(message, siteUrl) {
  try {
    const response = await fetch('/api/conversation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: message }],
        modelType: 'anthropic',
        modelId: 'claude-3-5-sonnet-20240620',
        siteUrl
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Error: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error en la conversación:', error);
    throw error;
  }
}
```

### Python (Requests)

```python
import requests
import json

# Ejemplo de análisis estructurado
def analyze_site_structure(url):
    try:
        response = requests.post(
            'http://localhost:3000/api/site/analyze',
            json={
                'url': url,
                'options': {
                    'analysisType': 'structured',
                    'includeScreenshot': True,
                    'provider': 'anthropic',
                    'modelId': 'claude-3-5-sonnet-20240620'
                }
            }
        )
        
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error al analizar el sitio: {e}")
        raise

# Ejemplo de API de IA
def ask_ai(question):
    try:
        response = requests.post(
            'http://localhost:3000/api/ai',
            json={
                'messages': [
                    {'role': 'user', 'content': question}
                ],
                'modelType': 'anthropic',
                'modelId': 'claude-3-5-sonnet-20240620'
            }
        )
        
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error al preguntar a la IA: {e}")
        raise
``` 