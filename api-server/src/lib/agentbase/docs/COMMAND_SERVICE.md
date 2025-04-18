# CommandService - Documentación

El `CommandService` es un componente central del framework Agentbase que gestiona todo el ciclo de vida de los comandos, desde su creación hasta su finalización o error. Implementa una arquitectura de microservicios internos donde cada aspecto del ciclo de vida del comando es manejado por un servicio especializado.

## Arquitectura

CommandService integra varios servicios especializados que trabajan en conjunto:

1. **CommandSubmitService**: Maneja la creación y envío de comandos al sistema
2. **CommandQueryService**: Proporciona métodos para consultar comandos
3. **CommandUpdateService**: Actualiza propiedades y contenido de los comandos
4. **CommandStatusService**: Gestiona los cambios de estado de los comandos
5. **CommandResultService**: Procesa y formatea los resultados de los comandos
6. **SupervisionService**: Gestiona las solicitudes de supervisión para comandos

Todos estos servicios comparten un `EventEmitter` común que permite la comunicación mediante eventos.

## Eventos Principales

El CommandService emite y escucha varios eventos:

- `commandCreated`: Cuando se crea un nuevo comando
- `commandUpdated`: Cuando se actualiza cualquier propiedad del comando
- `statusChange`: Cuando cambia el estado de un comando
- `supervisionRequested`: Cuando un comando solicita supervisión
- `supervisionCompleted`: Cuando se completa una supervisión

## Métodos Principales

### Creación y Consulta

```typescript
// Crear y enviar un comando
const commandId = await commandService.submitCommand({
  task: 'Analizar texto',
  userId: 'user123',
  agentId: 'research_agent',
  agent_background: '...' // Opcional
});

// Obtener un comando por su ID
const command = await commandService.getCommandById(commandId);
```

### Actualización de Estado

```typescript
// Actualizar el estado de un comando
await commandService.updateStatus(commandId, 'running');

// Marcar un comando como fallido con mensaje de error
await commandService.updateStatus(commandId, 'failed', 'El servicio externo no está disponible');
```

### Actualización de Comandos

```typescript
// Actualizar propiedades de un comando
await commandService.updateCommand(commandId, {
  results: [...],
  targets: [...],
  context: '...'
});

// Actualizar solo resultados
await commandService.updateResults(commandId, [
  { type: 'text', content: '...' },
  { type: 'json', content: { data: [...] } }
]);
```

### Gestión de Eventos

```typescript
// Escuchar cambios de estado
commandService.on('statusChange', (commandId, newStatus) => {
  console.log(`Comando ${commandId} cambió a estado: ${newStatus}`);
});

// Dejar de escuchar un evento
commandService.off('statusChange', listenerFunction);
```

## Campo Agent Background

El `CommandService` ha sido optimizado para preservar el campo `agent_background` durante todo el ciclo de vida del comando. Este campo contiene el contexto específico para el agente que ejecuta el comando y es crítico para mantener la coherencia del modelo de lenguaje.

Características importantes:

- El `agent_background` se preserva durante todas las operaciones de actualización
- Se implementa verificación de integridad para asegurar que no se pierda durante operaciones
- Se utiliza caché para reducir la carga en la base de datos

## Integración con Caché

CommandService está estrechamente integrado con `CommandCache` para optimizar el rendimiento:

- Los comandos consultados frecuentemente se almacenan en caché
- El sistema de caché utiliza un sistema de mapeo por ID para soportar tanto UUIDs de BD como IDs internos
- Las actualizaciones de comandos también actualizan la caché automáticamente

## Manejo de Errores

El servicio implementa varias estrategias para el manejo robusto de errores:

1. Preservación del contexto (agent_background) durante estados de error
2. Mensajes de error descriptivos que se almacenan con el comando
3. Eventos específicos para fallos que permiten reaccionar a errores

## Estados de Comando

Un comando puede pasar por varios estados:

- `pending`: Comando creado pero aún no procesado
- `running`: Comando en ejecución
- `waiting_for_supervision`: Esperando aprobación manual 
- `completed`: Comando completado exitosamente
- `failed`: Comando fallido con error

## Consideraciones de Rendimiento

- El sistema de caché mejora significativamente el rendimiento para comandos consultados frecuentemente
- La arquitectura basada en eventos permite operaciones asíncronas eficientes
- Los comandos grandes con contexts o backgrounds extensos son manejados eficientemente

## Integración en el Framework

CommandService se obtiene normalmente a través del AgentInitializer:

```typescript
import { AgentInitializer } from '@/lib/agentbase/services/agent/AgentInitializer';

const agentInitializer = AgentInitializer.getInstance();
agentInitializer.initialize();

// Obtener el servicio de comandos
const commandService = agentInitializer.getCommandService();
``` 