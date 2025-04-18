# Documentación de Agentbase Framework

Bienvenido a la documentación oficial del framework Agentbase, un sistema avanzado para construir y gestionar sistemas multi-agente basados en modelos de lenguaje.

## Introducción

Agentbase es un framework diseñado para facilitar la creación de sistemas complejos basados en agentes que utilizan modelos de lenguaje como backend. Permite que múltiples agentes colaboren de forma asíncrona, cada uno con su propio contexto especializado, trabajando juntos en tareas complejas.

## Características Principales

- **Arquitectura basada en comandos**: Estructura estandarizada para interacciones entre agentes
- **Procesamiento asíncrono**: Ejecución no bloqueante de tareas por múltiples agentes
- **Sistema de caché optimizado**: Mejora de rendimiento para operaciones frecuentes
- **Preservación de contexto**: Manejo robusto del contexto (agent_background) durante todo el flujo
- **Sistema de eventos**: Arquitectura basada en eventos para hooks del ciclo de vida
- **Manejo de errores avanzado**: Mecanismos de retry y circuit breakers para operaciones robustas
- **Validación de estructura**: Validación robusta para asegurar la integridad de los datos

## Guías y Documentación

### Conceptos Fundamentales
- [README](../README.md): Visión general del framework
- [CommandService](COMMAND_SERVICE.md): Servicio central para gestión de comandos
- [AgentInitializer](AGENT_INITIALIZER.md): Inicializador del sistema de agentes
- [CommandCache](COMMAND_CACHE.md): Sistema de caché para optimización de rendimiento

### Migración y Compatibilidad
- [Guía de Migración](MIGRATION_GUIDE.md): Migración de Processor a Agent

## Arquitectura

El framework Agentbase está organizado en un conjunto de servicios cohesivos que interactúan entre sí:

### Servicios Principales

```
src/lib/agentbase/
├── services/
│   ├── agent/
│   │   ├── AgentInitializer.ts      # Inicializador central
│   │   ├── AgentBackgroundService.ts # Servicio de backgrounds
│   │   └── AgentCacheService.ts     # Caché específica de agentes
│   ├── command/
│   │   ├── CommandService.ts        # Servicio principal de comandos
│   │   ├── CommandCache.ts          # Sistema de caché
│   │   ├── CommandProcessor.ts      # Procesador de comandos
│   │   ├── CommandFactory.ts        # Creación de comandos
│   │   └── ...                      # Otros servicios especializados
│   └── processor/
│       └── ProcessorInitializer.ts  # Compatibilidad con código antiguo
└── ...
```

## Flujo de Ejecución de Comandos

1. **Creación del Comando**: Mediante CommandFactory y CommandSubmitService
2. **Generación de Background**: Mediante AgentBackgroundService
3. **Evaluación de Herramientas**: Determinación de herramientas apropiadas
4. **Ejecución de Herramientas**: Ejecución por parte del agente
5. **Procesamiento de Targets**: Procesamiento de cada target definido
6. **Generación de Resultados**: Formateo y almacenamiento de resultados
7. **Finalización**: Actualización a estado completado o fallido

## Ejemplos de Uso

### Inicialización Básica

```typescript
import { AgentInitializer } from '@/lib/agentbase/services/agent/AgentInitializer';
import { CommandFactory } from '@/lib/agentbase/services/command/CommandFactory';

// Inicializar el framework
const agentInitializer = AgentInitializer.getInstance();
agentInitializer.initialize();

// Obtener el servicio de comandos
const commandService = agentInitializer.getCommandService();
```

### Creación y Ejecución de Comandos

```typescript
// Crear un comando
const command = CommandFactory.createCommand({
  task: 'Analizar texto',
  userId: 'user123',
  agentId: 'research_agent'
});

// Ejecutar el comando
const result = await agentInitializer.executeCommand(command);
console.log(result);
```

### Monitoreo de Comandos

```typescript
// Escuchar cambios de estado
commandService.on('statusChange', (commandId, status) => {
  console.log(`El comando ${commandId} cambió a estado: ${status}`);
});
```

## Desarrollo y Contribución

Para contribuir al desarrollo de Agentbase:

1. Familiarízate con la arquitectura y el flujo de ejecución
2. Sigue los estándares de código establecidos
3. Asegúrate de mantener la compatibilidad con código existente
4. Añade pruebas unitarias para nuevas funcionalidades
5. Documenta los cambios realizados

## Recursos Adicionales

- Código fuente: `src/lib/agentbase/`
- Ejemplos: Próximamente
- Pruebas: `src/lib/agentbase/test/` 