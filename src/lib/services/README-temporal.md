# WorkflowService con Temporal

El `WorkflowService` ha sido actualizado para usar directamente el cliente de Temporal con detección automática de configuración entre local y cloud.

## Configuración Automática

El servicio detecta automáticamente si debe conectarse a:
- **Temporal Local**: Servidor local de desarrollo (localhost:7233)
- **Temporal Cloud**: Servicio cloud gestionado (*.tmprl.cloud)
- **Temporal Custom**: Servidor personalizado

### Variables de Entorno

```bash
# 🚀 NUEVA: Entorno de Temporal (auto-configura para desarrollo)
TEMPORAL_ENV=development

# URL del servidor de Temporal (opcional, default: localhost:7233)
TEMPORAL_SERVER_URL=localhost:7233

# Namespace de Temporal (opcional, default: default)
TEMPORAL_NAMESPACE=default

# API Key para Temporal Cloud (solo requerido para cloud)
TEMPORAL_CLOUD_API_KEY=your-api-key

# Cola de tareas por defecto (opcional)
WORKFLOW_TASK_QUEUE=default
```

### Configuraciones por Entorno

#### 🎯 Desarrollo Simplificado (RECOMENDADO)
```bash
TEMPORAL_ENV=development
# ¡Solo esto! Configura automáticamente:
# - TEMPORAL_SERVER_URL=localhost:7233
# - TEMPORAL_NAMESPACE=default
# - Ignora cualquier otra configuración de Temporal
```

#### Desarrollo Local Manual
```bash
TEMPORAL_SERVER_URL=localhost:7233
TEMPORAL_NAMESPACE=default
# No necesita API Key
```

#### Temporal Cloud
```bash
TEMPORAL_SERVER_URL=your-namespace.tmprl.cloud:7233
TEMPORAL_NAMESPACE=your-namespace
TEMPORAL_CLOUD_API_KEY=your-cloud-api-key
```

#### Servidor Personalizado
```bash
TEMPORAL_SERVER_URL=temporal.your-domain.com:7233
TEMPORAL_NAMESPACE=your-custom-namespace
# API Key opcional según configuración del servidor
```

### Instalación de Dependencias

```bash
npm install @temporalio/client @temporalio/common
```

## Uso Básico

### Configuración Rápida para Desarrollo

Para desarrollo, simplemente configura:

```bash
# En tu .env o .env.local
TEMPORAL_ENV=development
```

¡Y listo! El servicio se configura automáticamente para localhost.

### Enviar Email desde Agente

```typescript
import { WorkflowService } from '@/lib/services/workflow-service';

const workflowService = WorkflowService.getInstance();

// El servicio detecta automáticamente la configuración
// Si TEMPORAL_ENV=development, usa localhost automáticamente
const result = await workflowService.sendEmailFromAgent({
  email: 'user@example.com',
  from: 'noreply@yourdomain.com',
  subject: 'Asunto del email',
  message: 'Contenido del mensaje'
}, {
  taskQueue: 'email-task-queue',
  workflowId: 'send-email-12345' // Opcional, se genera automáticamente
});

if (result.success) {
  console.log(`Workflow iniciado: ${result.workflowId}`);
  console.log(`Run ID: ${result.runId}`);
  console.log(`Deployment: ${result.deploymentType}`); // local, cloud, custom
} else {
  console.error('Error:', result.error);
}
```

### Ejecutar Workflow Genérico

```typescript
const result = await workflowService.executeWorkflow(
  'processData',
  { 
    dataId: '12345',
    parameters: { /* ... */ }
  },
  {
    taskQueue: 'data-processing-queue',
    workflowId: 'process-data-12345'
  }
);
```

### Obtener Estado de Workflow

```typescript
const status = await workflowService.getWorkflowStatus('workflow-id', 'run-id');

if (status.success) {
  console.log(`Estado: ${status.status}`);
} else {
  console.error('Error al obtener estado:', status.error);
}
```

### Cancelar Workflow

```typescript
const result = await workflowService.cancelWorkflow('workflow-id', 'run-id');

if (result.success) {
  console.log('Workflow cancelado exitosamente');
}
```

### Cerrar Conexión

```typescript
// Al finalizar la aplicación
await workflowService.closeConnection();
```

## Validación y Diagnóstico

### Verificar Configuración

```typescript
const workflowService = WorkflowService.getInstance();

// Obtener reporte de configuración
const configReport = workflowService.getConfigurationReport();
console.log('Configuración actual:', configReport);

// Obtener configuración auto-detectada
const autoConfig = workflowService.getAutoDetectedConfiguration();
console.log('Configuración sugerida:', autoConfig);

// Probar conexión
const connectionTest = await workflowService.testConnection();
if (connectionTest.success) {
  console.log('✅ Conexión exitosa');
  console.log('Tipo de deployment:', connectionTest.config?.deploymentType);
} else {
  console.error('❌ Error de conexión:', connectionTest.error);
}
```

### API de Estado

Verifica el estado de Temporal via API:

```bash
# Verificar configuración
GET /api/temporal/status

# Verificar configuración y probar conexión
GET /api/temporal/status?test=true

# Probar conexión
POST /api/temporal/status
```

### Validación de Configuración

El servicio incluye validación automática que verifica:

- ✅ URLs de servidor válidas
- ✅ Namespaces correctos
- ✅ API Keys para Temporal Cloud
- ✅ Configuración TLS apropiada
- 🎯 **NUEVO**: Detección de `TEMPORAL_ENV=development`
- ⚠️ Advertencias para configuración local en producción
- 💡 Recomendaciones de mejores prácticas

### Probar la Nueva Funcionalidad

1. **Configurar entorno de desarrollo:**
   ```bash
   export TEMPORAL_ENV=development
   # o en tu .env:
   echo "TEMPORAL_ENV=development" >> .env.local
   ```

2. **Ejecutar script de prueba:**
   ```bash
   node test-temporal-config.js
   ```

3. **Verificar via API:**
   ```bash
   curl http://localhost:3000/api/temporal/status?test=true
   ```

4. **Logs esperados:**
   ```
   🧪 Modo desarrollo detectado - configurando para localhost automáticamente
   🎯 Configuración forzada por TEMPORAL_ENV
   ```

## Configuración del Worker

Para que los workflows funcionen, necesitas tener un worker de Temporal ejecutándose que procese los workflows. Ejemplo:

```typescript
// worker.ts
import { Worker } from '@temporalio/worker';
import { sendEmailFromAgent, genericWorkflow } from './workflows/email-workflows';

async function runWorker() {
  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows/email-workflows'),
    activitiesPath: require.resolve('./activities'), // Implementar actividades
    taskQueue: 'email-task-queue',
  });
  
  await worker.run();
}

runWorker().catch(console.error);
```

## Cambios Principales

### Antes (HTTP)
- Hacía llamadas HTTP a un servidor de workflows externo
- Dependía de `WORKFLOWS_SERVER_URL`
- Usaba `fetch()` para comunicación

### Después (Temporal Client)
- Usa directamente el cliente de Temporal
- Se conecta directamente al servidor de Temporal
- Más eficiente y con mejor control de errores
- Soporte nativo para monitoreo y cancelación de workflows

## Interfaces

### WorkflowExecutionArgs
```typescript
interface WorkflowExecutionArgs {
  email: string;
  from: string;
  subject: string;
  message: string;
}
```

### WorkflowExecutionOptions
```typescript
interface WorkflowExecutionOptions {
  priority?: 'low' | 'medium' | 'high';
  async?: boolean;
  retryAttempts?: number;
  taskQueue?: string;
  workflowId?: string;
}
```

### WorkflowExecutionResponse
```typescript
interface WorkflowExecutionResponse {
  success: boolean;
  executionId?: string;
  workflowId?: string;
  runId?: string;
  status?: string;
  error?: {
    code: string;
    message: string;
  };
}
```

## Notas

- El servicio mantiene el patrón singleton
- La conexión se reutiliza entre llamadas para eficiencia
- Los workflows deben estar implementados y ejecutándose en workers separados
- Los workers deben estar configurados con las mismas `taskQueue` que usas en las opciones 