# WorkflowService con Temporal

El `WorkflowService` ha sido actualizado para usar directamente el cliente de Temporal en lugar de hacer llamadas HTTP a otro servidor.

## Configuración

### Variables de Entorno

```bash
# URL del servidor de Temporal (opcional, default: localhost:7233)
TEMPORAL_SERVER_URL=localhost:7233

# Namespace de Temporal (opcional, default: default)
TEMPORAL_NAMESPACE=default
```

### Instalación de Dependencias

```bash
npm install @temporalio/client @temporalio/common
```

## Uso Básico

### Enviar Email desde Agente

```typescript
import { WorkflowService } from '@/lib/services/workflow-service';

const workflowService = WorkflowService.getInstance();

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