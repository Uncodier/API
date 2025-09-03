# Integración de Composio con Agentbase

Este módulo permite integrar herramientas de Composio en el flujo de procesamiento de herramientas de Agentbase, enriqueciendo los comandos con herramientas adicionales para ser evaluadas por el ToolEvaluator.

## Configuración

Para activar y configurar la integración con Composio, se puede utilizar la función `configureComposio`:

```typescript
import { configureComposio } from '../utils/composioIntegration';

// Activar Composio con configuración básica
configureComposio({
  enabled: true,
  apps: ['whatsapp', 'gmail', 'calendar'],
  apiKey: process.env.COMPOSIO_API_KEY
});
```

## Formas de Integración

Hay varias formas de integrar Composio con Agentbase:

### 1. Integración automática en CommandProcessor

La integración más sencilla es simplemente activar Composio. El `CommandProcessor` y el `EventHandlerService` ya están configurados para enriquecer automáticamente los comandos con herramientas de Composio:

```typescript
// Importar la función de configuración
import { configureComposio } from './lib/agentbase/utils/composioIntegration';

// Activar la integración con Composio
configureComposio({
  enabled: true,
  apps: ['whatsapp', 'gmail']
});

// A partir de aquí, todos los comandos procesados por Agentbase
// se enriquecerán automáticamente con las herramientas de Composio
```

### 2. Crear un ToolEvaluator con Composio habilitado

Puedes crear un ToolEvaluator específico que integre Composio:

```typescript
import { ToolEvaluator } from './lib/agentbase/agents/ToolEvaluator';
import { PortkeyConnector } from './lib/agentbase/services/PortkeyConnector';

// Crear conector
const connector = new PortkeyConnector({
  apiKey: process.env.PORTKEY_API_KEY
});

// Crear evaluador con Composio habilitado
const evaluator = new ToolEvaluator(
  'composio-evaluator',
  'Composio Evaluator',
  connector,
  ['tool_evaluation'],
  { // Opciones del modelo
    modelType: 'openai',
    modelId: 'gpt-5-nano'
  },
  'Descripción opcional',
  undefined, // systemPrompt
  undefined, // agentSystemPrompt
  { // Opciones de Composio
    enabled: true,
    apps: ['whatsapp', 'gmail'],
    tags: ['messaging']
  }
);
```

### 3. Enriquecer un comando manualmente

También puedes enriquecer un comando manualmente en cualquier parte del código:

```typescript
import { DbCommand } from './lib/agentbase/models/types';
import { enrichWithComposioTools } from './lib/agentbase/utils/composioIntegration';

async function procesarComando(command: DbCommand) {
  // Enriquecer el comando con herramientas de Composio para esta instancia específica
  const enrichedCommand = await enrichWithComposioTools(command, {
    enabled: true,
    apps: ['whatsapp'],
    tags: ['urgent']
  });
  
  // Continuar con el procesamiento del comando enriquecido
  // ...
}
```

## Opciones de Configuración

La configuración de Composio acepta las siguientes opciones:

| Opción | Tipo | Descripción |
|--------|------|-------------|
| `enabled` | `boolean` | Activa o desactiva la integración |
| `apiKey` | `string` | API Key de Composio |
| `entityId` | `string` | ID de entidad en Composio |
| `apps` | `string[]` | Lista de apps a utilizar |
| `tags` | `string[]` | Tags para filtrar herramientas |
| `integrationId` | `string` | ID de integración específica |
| `filterByAvailableApps` | `boolean` | Filtrar sólo por apps disponibles |

## Ejemplo completo de uso

```typescript
import { configureComposio } from './lib/agentbase/utils/composioIntegration';
import { CommandService } from './lib/agentbase/services/command/CommandService';
import { DbCommand } from './lib/agentbase/models/types';

// Configurar Composio globalmente
configureComposio({
  enabled: true,
  apiKey: process.env.COMPOSIO_API_KEY,
  apps: ['whatsapp', 'gmail']
});

// Crear un comando
const commandService = new CommandService();
const commandId = await commandService.submitCommand({
  task: 'Enviar un mensaje de WhatsApp a Juan',
  status: 'pending',
  user_id: 'user123',
  context: 'Necesito enviar un mensaje urgente a Juan',
  tools: [
    // Herramientas iniciales del comando
    // Composio añadirá automáticamente más herramientas
  ]
});

// Los comandos se procesarán con herramientas de Composio automáticamente
``` 