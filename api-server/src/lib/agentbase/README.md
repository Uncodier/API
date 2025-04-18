# Agentbase Framework

Un framework avanzado para crear y gestionar sistemas multi-agente, permitiendo que modelos de lenguaje colaboren de forma asíncrona en tareas complejas.

## Visión General

Agentbase está diseñado para habilitar llamadas asíncronas a múltiples modelos de lenguaje que pueden trabajar colaborativamente en objetos compartidos mientras mantienen memorias e instrucciones distintas. La estructura de comandos sirve como base, permitiendo que múltiples agentes procesen datos iterativamente, cada uno con su propio contexto y capacidades especializadas, operando dentro de un flujo de trabajo unificado.

## Arquitectura

Agentbase utiliza una arquitectura modular basada en servicios claramente separados, que facilitan el procesamiento de comandos a través de agentes. La reciente evolución del framework incluye:

- **Migración de Processor a Agent**: El sistema ha migrado del concepto de "Processor" a "Agent", manteniendo la compatibilidad con código anterior a través de wrappers.
- **Servicios Independientes**: Cada aspecto del procesamiento de comandos tiene su propio servicio especializado.
- **Sistema de Caché**: Implementación de un sistema robusto de caché para mejorar el rendimiento.
- **Manejo de Backgrounds**: Sistema especializado para generar y administrar los "backgrounds" de los agentes (contexto y memoria).

## Componentes Principales

### Componentes Core

- **Base**: Clase abstracta que todos los agentes extienden (evolución de BaseAgent)
- **AgentInitializer**: Servicio centralizado para inicializar agentes y configurar el procesamiento de comandos
- **CommandService**: Servicio para gestionar el ciclo de vida de los comandos
- **CommandCache**: Sistema de caché para optimizar el acceso a comandos y datos de agentes
- **AgentBackgroundService**: Servicio especializado para generar y gestionar backgrounds de agentes

### Servicios de Procesamiento de Comandos

- **CommandProcessor**: Procesador principal que ejecuta el flujo completo de comandos
- **CommandSubmitService**: Servicio para enviar comandos al sistema
- **CommandStatusService**: Servicio para gestionar los cambios de estado de los comandos
- **CommandUpdateService**: Servicio para actualizar datos de comandos
- **CommandQueryService**: Servicio para consultar información de comandos
- **CommandResultService**: Servicio para procesar y formatear resultados de comandos

### Adaptadores y Conectores

- **DatabaseAdapter**: Adaptador para interactuar con la base de datos
- **PortkeyConnector**: Conector para comunicación con LLMs a través de la API de Portkey

## Uso Básico

### 1. Inicialización del Framework

```typescript
import { AgentInitializer } from '@/lib/agentbase/services/agent/AgentInitializer';

// Inicializar el framework
const agentInitializer = AgentInitializer.getInstance();
agentInitializer.initialize();

// Obtener el servicio de comandos
const commandService = agentInitializer.getCommandService();
```

### 2. Creación y Ejecución de Comandos

```typescript
import { CommandFactory } from '@/lib/agentbase/services/command/CommandFactory';

// Crear un comando
const command = CommandFactory.createCommand({
  task: 'Analizar el siguiente texto...',
  userId: 'user_123',
  agentId: 'research_agent' // ID del agente predefinido o UUID de agente en BD
});

// Ejecutar el comando de forma síncrona
const result = await agentInitializer.executeCommand(command);
console.log(result);

// O procesar de forma asíncrona
const commandId = await commandService.submitCommand(command);
console.log(`Comando enviado con ID: ${commandId}`);
```

### 3. Monitoreo de Comandos

```typescript
// Escuchar cambios de estado en comandos
commandService.on('statusChange', (commandId, status) => {
  console.log(`El comando ${commandId} cambió a estado: ${status}`);
});

// Consultar estado de un comando
const command = await commandService.getCommandById(commandId);
console.log(`Estado actual: ${command.status}`);
```

## Flujo de Procesamiento de Comandos

El flujo estándar de procesamiento de comandos en Agentbase incluye:

1. **Creación del Comando**: A través de CommandFactory y CommandSubmitService
2. **Generación de Background**: AgentBackgroundService genera el contexto para el agente
3. **Evaluación de Herramientas**: Se determinan qué herramientas son apropiadas para el comando
4. **Ejecución de Herramientas**: Las herramientas seleccionadas son ejecutadas por el agente
5. **Procesamiento de Targets**: Se procesa cada target definido en el comando
6. **Generación de Resultados**: Se formatean y almacenan los resultados
7. **Finalización**: Se actualiza el estado del comando a completado o fallido

## Compatibilidad con Código Antiguo

El framework mantiene compatibilidad con código que aún hace referencia a "Processor" mediante clases de wrapper:

```typescript
import { ProcessorInitializer } from '@/lib/agentbase/services/processor/ProcessorInitializer';

// Este código utiliza la interfaz antigua pero internamente usa AgentInitializer
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
```

## Funcionalidades Avanzadas

- **Sistema de Caché**: Optimización de rendimiento mediante almacenamiento en caché
- **Manejo de Errores**: Mecanismos de retry y circuit breakers para robustecer el sistema
- **Sistema de Eventos**: Arquitectura basada en eventos para hooks del ciclo de vida de comandos
- **Validación de Estructura**: Validación robusta para asegurar la integridad del flujo target → result
- **Gestión de Fallos**: Reporte adecuado de fallos con mensajes de error descriptivos
- **Aislamiento de Contextos**: Cada agente mantiene su propio contexto aislado

## Mejoras Futuras

- Integración con streaming para respuestas en tiempo real
- Más tipos de agentes especializados
- Implementación avanzada de herramientas
- Interfaz web para supervisión y administración
- Optimización adicional del sistema de caché 