# CommandCache - Documentación

El sistema de `CommandCache` es un componente crítico del framework Agentbase que proporciona una capa de caché en memoria para los comandos durante su flujo de ejecución. Este sistema mejora significativamente el rendimiento al reducir consultas a la base de datos y garantiza la preservación de datos críticos como el `agent_background` a lo largo de todo el ciclo de vida de un comando.

## Estructura Interna

El sistema de caché utiliza varias estructuras de datos internas:

1. **commandCache**: Mapa principal que almacena los comandos completos indexados por ID
2. **idMapping**: Mapa para la traducción entre IDs temporales y UUIDs de la base de datos
3. **cacheTimestamps**: Registro de marcas de tiempo para implementar el TTL (Time-To-Live)

## Características Principales

### Mapeo Bidireccional de IDs

El sistema implementa un mapeo bidireccional entre los IDs temporales generados internamente y los UUIDs de la base de datos:

```typescript
// Mapeo interno
idMapping.set(tempId, dbId);
idMapping.set(dbId, dbId); // El UUID siempre mapea a sí mismo
```

Esto permite que un comando pueda ser recuperado indistintamente con cualquiera de los dos identificadores, facilitando la compatibilidad entre diferentes partes del sistema.

### Preservación de Agent Background

Una de las funciones más importantes es garantizar que el `agent_background` se mantenga intacto durante todo el ciclo de vida del comando:

```typescript
// Mantener el agent_background si ya existía y no se proporciona en las actualizaciones
if (command.agent_background && !updates.agent_background) {
  updatedCommand.agent_background = command.agent_background;
}
```

### TTL (Time-To-Live) y Limpieza Automática

El sistema implementa un mecanismo de TTL para evitar el crecimiento descontrolado de la memoria:

- Por defecto, los comandos tienen un TTL de 10 minutos
- Una función de limpieza automática elimina los comandos expirados
- Cada acceso a un comando actualiza su timestamp, extendiendo su vida útil

## Métodos Principales

### Almacenamiento y Recuperación

```typescript
// Almacenar un comando en caché
CommandCache.cacheCommand('cmd_12345', command);

// Recuperar un comando
const command = CommandCache.getCachedCommand('cmd_12345');
```

### Actualización

```typescript
// Actualizar un comando en caché
const updatedCommand = CommandCache.updateCachedCommand('cmd_12345', {
  status: 'completed',
  results: [...]
});
```

### Manejo Específico de Agent Background

```typescript
// Establecer explícitamente el agent_background
CommandCache.setAgentBackground('cmd_12345', 'Contenido del background...');

// Verificar si un comando tiene agent_background
const hasBackground = CommandCache.hasAgentBackground('cmd_12345');

// Obtener solo el agent_background
const background = CommandCache.getAgentBackground('cmd_12345');
```

### Sincronización de IDs

```typescript
// Sincronizar IDs temporales con UUIDs de la BD
CommandCache.syncIds('cmd_temp_12345', '550e8400-e29b-41d4-a716-446655440000');

// Obtener el ID mapeado
const dbId = CommandCache.getMappedId('cmd_temp_12345');
```

## Integración con Sistema de Eventos

CommandCache se integra con el sistema de eventos del framework:

```typescript
// Configurar el event emitter
CommandCache.setEventEmitter(eventEmitter);

// El sistema emite eventos cuando hay actualizaciones
eventEmitter.on('commandCacheUpdated', (command) => {
  console.log(`Comando actualizado en caché: ${command.id}`);
});
```

## Gestión de Memoria

El sistema incluye varias funciones para la gestión de memoria:

```typescript
// Limpieza manual de la caché
CommandCache.cleanupCache();

// Obtener el tamaño actual de la caché
const size = CommandCache.getCacheSize();

// Limpiar completamente la caché
CommandCache.clearAll();
```

## Mejores Prácticas

1. **Acceso Unificado**: Usar CommandCache como punto único de acceso a comandos durante su procesamiento
2. **Verificación de Existencia**: Verificar siempre si el comando existe en caché antes de acceder a BD
3. **Actualizaciones Atómicas**: Actualizar comandos completos en lugar de propiedades individuales para mantener coherencia
4. **Preservación de Contexto**: Asegurar que el agent_background se preserve en actualizaciones parciales

## Optimizaciones de Rendimiento

- **Duplicación Bidireccional**: Los comandos se almacenan con ambos IDs (temporal y UUID)
- **Actualización de TTL en Acceso**: Cada acceso extiende la vida útil del comando en caché
- **Limpieza Periódica**: Eliminación automática de entradas antiguas
- **Logs Eficientes**: Sistema de logs optimizado para evitar sobrecarga en operaciones frecuentes

## Consideraciones Técnicas

- El sistema está diseñado para ser thread-safe en un entorno de servidor
- Las operaciones de caché son síncronas para garantizar consistencia
- Se optimizan los patrones de acceso más comunes durante el procesamiento de comandos
- La caché funciona como una capa de write-through, manteniendo la coherencia con la BD 