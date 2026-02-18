# Servicio de Continuación de JSON

Este servicio permite completar respuestas JSON incompletas de agentes de IA que se quedan sin contexto durante la generación.

## Problema

Cuando un agente de IA está generando una respuesta JSON compleja, puede quedarse sin contexto (token limit) antes de terminar, lo que resulta en un JSON incompleto que no puede ser utilizado por la aplicación.

## Solución

El servicio de continuación de JSON implementa una solución en tres niveles:

1. **Reparación rápida**: Intenta reparar el JSON incompleto cerrando llaves y corchetes no balanceados.
2. **Continuación con IA**: Si la reparación rápida no funciona, utiliza un modelo de IA para continuar la generación desde donde se quedó.
   - **Concatenación inteligente**: El servicio solicita al modelo SOLO la parte faltante del JSON y la concatena con la parte original para formar un JSON completo y coherente.
3. **Integración transparente**: Se integra con el servicio de análisis de segmentos y la API de conversación para detectar y manejar automáticamente respuestas JSON incompletas.

## Componentes

### 1. Servicio de Continuación (`continuation-service.ts`)

Implementa la lógica principal para:
- Detectar JSON incompletos
- Intentar reparar JSON incompletos
- Continuar la generación con IA

### 2. Cliente de Continuación (`continuation-client.ts`)

Proporciona una interfaz fácil de usar para:
- Verificar si un JSON está incompleto
- Intentar reparar un JSON incompleto
- Continuar la generación de un JSON incompleto

### 3. API de Continuación (`/api/ai/text/continuation/route.ts`)

Expone un endpoint HTTP para:
- Verificar si un JSON está incompleto (GET)
- Continuar la generación de un JSON incompleto (POST)

### 4. Integración con el Analizador de Segmentos (`segment-analyzer-service.ts`)

Detecta y maneja automáticamente respuestas JSON incompletas durante el análisis de segmentos.

### 5. Integración con la API de Conversación (`/api/conversation/route.ts`)

Utiliza el servicio de continuación para manejar respuestas JSON incompletas en las conversaciones con modelos de IA.

## Uso

### Uso Básico

```typescript
import { continueIncompleteJson } from '@/lib/services/continuation-client';

// Verificar y completar un JSON incompleto
const result = await continueIncompleteJson(
  incompleteJsonString,
  'anthropic',
  'claude-3-opus-20240229',
  'https://example.com'
);

if (result.success) {
  // Usar el JSON completo
  const completeJson = result.completeJson;
} else {
  // Manejar el error
  console.error('Error:', result.error);
}
```

### Uso del Cliente

```typescript
import { continuationClient } from '@/lib/services/continuation-client';

// Verificar si un JSON está incompleto
if (continuationClient.isIncomplete(jsonString)) {
  // Intentar reparar sin IA
  const repairedJson = continuationClient.attemptRepair(jsonString);
  
  if (repairedJson) {
    // Usar el JSON reparado
  } else {
    // Continuar con IA
    const result = await continuationClient.continueGeneration({
      incompleteJson: jsonString,
      modelType: 'anthropic',
      modelId: 'claude-3-opus-20240229',
      siteUrl: 'https://example.com'
    });
    
    if (result.success) {
      // Usar el JSON completo
    }
  }
}
```

### Uso de la API

```typescript
// POST /api/ai/text/continuation
const response = await fetch('/api/ai/text/continuation', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    incompleteJson: jsonString,
    modelType: 'anthropic',
    modelId: 'claude-3-opus-20240229',
    siteUrl: 'https://example.com'
  })
});

const result = await response.json();

if (result.success) {
  // Usar el JSON completo
  const completeJson = result.completeJson;
}
```

### Integración con la API de Conversación

La API de conversación utiliza automáticamente el servicio de continuación cuando detecta una respuesta JSON incompleta:

```typescript
// Solicitar una respuesta en formato JSON
const response = await fetch('/api/conversation', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    messages: [
      { role: 'user', content: 'Genera un JSON con información sobre...' }
    ],
    modelType: 'anthropic',
    modelId: 'claude-3-opus-20240229',
    responseFormat: 'json' // Solicitar respuesta en formato JSON
  })
});

// La respuesta ya estará completa gracias al servicio de continuación
const result = await response.json();
```

## Ejemplo Completo

Ver `src/lib/examples/continuation-example.ts` para un ejemplo completo de uso del servicio.

## Consideraciones

- El servicio está diseñado para manejar JSON incompletos, no para corregir JSON mal formados.
- La continuación con IA puede consumir tokens adicionales, por lo que se recomienda usar la reparación rápida cuando sea posible.
- El servicio está integrado con el analizador de segmentos y la API de conversación, pero puede ser utilizado de forma independiente en cualquier parte de la aplicación.
- **Concatenación vs. Regeneración**: El servicio utiliza un enfoque de concatenación inteligente, solicitando al modelo solo la parte faltante del JSON y concatenándola con la parte original, en lugar de regenerar todo el JSON desde cero. Esto permite mantener la estructura y contenido original del JSON incompleto. 