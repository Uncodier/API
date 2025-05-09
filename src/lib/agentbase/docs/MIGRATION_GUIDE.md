# Guía de Migración: De Processor a Agent

Esta guía proporciona instrucciones paso a paso para migrar código que utiliza el sistema antiguo basado en "Processor" al nuevo sistema basado en "Agent" en el framework Agentbase.

## Visión General de los Cambios

El framework Agentbase ha evolucionado su arquitectura, migrando del concepto de "Processor" a "Agent". Aunque se mantiene compatibilidad con código anterior, recomendamos actualizar a la nueva nomenclatura y estructura por claridad y para aprovechar las nuevas funcionalidades.

Cambios principales:
- `ProcessorInitializer` → `AgentInitializer`
- `ProcessorRegistry` → Configuración mediante `AgentInitializer`
- Mejora en el sistema de manejo de comandos y backgrounds
- Nuevo sistema de caché para optimizar rendimiento

## Compatibilidad Garantizada

El framework mantiene compatibilidad con código anterior mediante wrappers:
- La clase `ProcessorInitializer` actúa como wrapper para `AgentInitializer`
- Los métodos de la API antigua son redirigidos a sus equivalentes modernos

## Pasos de Migración

### 1. Actualizar las Importaciones

**Antes:**
```typescript
import { 
  ProcessorInitializer, 
  ProcessorRegistry 
} from '@/lib/agentbase/services/processor';
```

**Después:**
```typescript
import { 
  AgentInitializer 
} from '@/lib/agentbase/services/agent';
```

### 2. Actualizar la Inicialización

**Antes:**
```typescript
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();

const commandService = processorInitializer.getCommandService();
```

**Después:**
```typescript
const agentInitializer = AgentInitializer.getInstance();
agentInitializer.initialize();

const commandService = agentInitializer.getCommandService();
```

### 3. Actualizar Ejecución de Comandos

**Antes:**
```typescript
const result = await processorInitializer.executeCommand(command);
```

**Después:**
```typescript
const result = await agentInitializer.executeCommand(command);
```

### 4. Actualizar Referencias a Procesadores

**Antes:**
```typescript
// Utilizando ProcessorRegistry
const processor = ProcessorRegistry.getProcessor('text_processor');
```

**Después:**
```typescript
// La configuración de agentes se maneja internamente por AgentInitializer
// Para ejecutar un comando con un agente específico, usar el agentId:
const command = CommandFactory.createCommand({
  task: 'Procesar texto',
  userId: 'user123',
  agentId: 'text_processor'
});

const result = await agentInitializer.executeCommand(command);
```

### 5. Aprovechar los Nuevos Eventos

El nuevo sistema proporciona más eventos que pueden ser escuchados:

```typescript
// Obtener el sistema de eventos
const eventEmitter = commandService.getEventEmitter();

// Escuchar eventos específicos
eventEmitter.on('commandCacheUpdated', (command) => {
  console.log(`Comando actualizado en caché: ${command.id}`);
});

eventEmitter.on('commandStatusChanged', (commandId, newStatus) => {
  console.log(`Estado del comando ${commandId} cambió a: ${newStatus}`);
});
```

### 6. Utilizar el Sistema de Caché

El nuevo sistema incluye un potente sistema de caché:

```typescript
import { CommandCache } from '@/lib/agentbase/services/command/CommandCache';

// Verificar si un comando está en caché
const command = CommandCache.getCachedCommand(commandId);

if (command) {
  // Usar comando de caché
} else {
  // Obtener de base de datos
}
```

### 7. Considerar los Nuevos Campos

El nuevo sistema introduce y gestiona nuevos campos importantes:

```typescript
// El campo agent_background es ahora un campo crítico 
// que se genera automáticamente y debe preservarse
const command = CommandFactory.createCommand({
  task: 'Analizar texto',
  userId: 'user123',
  agentId: 'text_processor',
  // No es necesario proporcionar agent_background, se genera automáticamente
});
```

## Casos de Uso Comunes

### Flujo Básico de Comando

```typescript
// 1. Importar dependencias
import { AgentInitializer } from '@/lib/agentbase/services/agent/AgentInitializer';
import { CommandFactory } from '@/lib/agentbase/services/command/CommandFactory';

// 2. Inicializar el framework
const agentInitializer = AgentInitializer.getInstance();
agentInitializer.initialize();

// 3. Crear un comando
const command = CommandFactory.createCommand({
  task: 'Analizar el siguiente texto...',
  userId: 'user_123',
  agentId: 'research_agent',
  context: 'Contexto adicional para el agente...',
  tools: ['web_search', 'document_analyzer']
});

// 4. Ejecutar el comando
const result = await agentInitializer.executeCommand(command);

// 5. Procesar los resultados
console.log(result.status);  // 'completed', 'failed', etc.
console.log(result.results); // Array de resultados
```

### Monitoreo de Comandos

```typescript
// Obtener el servicio de comandos
const commandService = agentInitializer.getCommandService();

// Escuchar cambios de estado
commandService.on('statusChange', (commandId, status) => {
  console.log(`El comando ${commandId} cambió a estado: ${status}`);
  
  if (status === 'completed') {
    // Obtener los resultados finales
    commandService.getCommandById(commandId).then(command => {
      if (command) {
        console.log('Resultados:', command.results);
      }
    });
  }
});
```

## Preguntas Frecuentes

### ¿Debo migrar todo mi código de inmediato?
No es necesario, el sistema mantiene compatibilidad con el código antiguo. Sin embargo, recomendamos migrar gradualmente para aprovechar las mejoras.

### ¿Cómo afecta esta migración al rendimiento?
La nueva arquitectura mejora significativamente el rendimiento, especialmente en escenarios con alto volumen de comandos, gracias al sistema de caché y la optimización en el manejo de backgrounds.

### ¿Qué ocurre con los procesadores personalizados?
Los procesadores personalizados deben migrarse a agentes personalizados, extendiendo la clase `Base` en lugar de las antiguas clases de procesador.

### ¿Cómo puedo probar que mi migración funciona correctamente?
Recomendamos crear pruebas unitarias y de integración que verifiquen:
1. La ejecución correcta de comandos
2. La preservación del agent_background
3. El manejo adecuado de errores
4. La finalización exitosa del flujo completo 