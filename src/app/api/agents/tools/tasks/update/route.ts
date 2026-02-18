import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { updateTask, getTaskById } from '@/lib/database/task-db';

/**
 * Función para transformar diferentes formatos de fecha a ISO 8601
 */
function transformToISO8601(dateInput: any): string | null {
  if (!dateInput) return null;
  
  try {
    // Si ya es un string que parece ISO 8601 con timezone, preservarlo tal como está
    if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : dateInput; // Retornar el original si es válido
    }
    
    // Si es ISO 8601 con milisegundos y timezone, también preservarlo
    if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : dateInput;
    }
    
    // Si es ISO 8601 con 'Z' al final, también preservarlo
    if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : dateInput;
    }
    
    // Si es ISO 8601 sin timezone, convertir a UTC
    if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : date.toISOString();
    }

    // Si es un número (timestamp)
    if (typeof dateInput === 'number') {
      // Si parece timestamp en segundos (menos de año 2050 en ms)
      const timestamp = dateInput < 2524608000 ? dateInput * 1000 : dateInput;
      const date = new Date(timestamp);
      return isNaN(date.getTime()) ? null : date.toISOString();
    }

    // Si es un string, intentar con Date constructor para formatos estándar
    if (typeof dateInput === 'string') {
      let dateStr = dateInput.trim();
      
      // Verificar si es una fecha claramente inválida
      if (dateStr.match(/[a-zA-Z]/) && !dateStr.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)) {
        return null;
      }
      
      // Intentar con Date constructor para formatos naturales
      let date = new Date(dateStr);
      if (!isNaN(date.getTime()) && dateStr.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)) {
        return date.toISOString();
      }
    }

    // Último intento: usar Date constructor directamente solo si no contiene letras problemáticas
    if (typeof dateInput === 'string' && !dateInput.match(/[a-zA-Z]/) || 
        (typeof dateInput === 'string' && dateInput.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i))) {
      const date = new Date(dateInput);
      return isNaN(date.getTime()) ? null : date.toISOString();
    }

    return null;
    
  } catch (error) {
    console.warn('[UpdateTask] Error transformando fecha:', dateInput, error);
    return null;
  }
}

/**
 * Función para limpiar y transformar los datos de entrada
 */
function preprocessTaskData(data: any) {
  const processed = { ...data };
  
  // Transformar scheduled_date si existe
  if (processed.scheduled_date) {
    const transformedDate = transformToISO8601(processed.scheduled_date);
    if (transformedDate) {
      processed.scheduled_date = transformedDate;
      console.log('[UpdateTask] scheduled_date transformada:', data.scheduled_date, '->', transformedDate);
    } else {
      console.warn('[UpdateTask] No se pudo transformar scheduled_date:', data.scheduled_date);
      // Remover la fecha si no se puede transformar para evitar error de validación
      delete processed.scheduled_date;
    }
  }
  
  // Transformar completed_date si existe
  if (processed.completed_date) {
    const transformedDate = transformToISO8601(processed.completed_date);
    if (transformedDate) {
      processed.completed_date = transformedDate;
      console.log('[UpdateTask] completed_date transformada:', data.completed_date, '->', transformedDate);
    } else {
      console.warn('[UpdateTask] No se pudo transformar completed_date:', data.completed_date);
      // Remover la fecha si no se puede transformar para evitar error de validación
      delete processed.completed_date;
    }
  }
  
  return processed;
}

/**
 * Esquema para validar los datos de entrada
 */
const UpdateTaskSchema = z.object({
  task_id: z.string().uuid('Task ID debe ser un UUID válido'),
  site_id: z.string().uuid('Site ID es requerido'),
  title: z.string().min(1, 'Título es requerido').optional(),
  description: z.string().optional(),
  type: z.string().min(1, 'Tipo de tarea es requerido').optional(),
  status: z.enum(['in_progress', 'failed', 'pending', 'completed']).optional(),
  stage: z.string().optional(),
  priority: z.number().int().min(0).optional(),
  scheduled_date: z.string()
    .refine((val: string) => {
      if (!val) return true; // opcional
      // Verificar que sea una fecha válida ISO 8601 (con o sin timezone)
      const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?$/;
      if (!iso8601Regex.test(val)) return false;
      
      // Verificar que la fecha sea válida
      const date = new Date(val);
      return !isNaN(date.getTime());
    }, 'Fecha debe ser ISO 8601 válida (con o sin timezone)')
    .optional(),
  amount: z.number().optional(),
  assignee: z.string().uuid('Assignee debe ser un UUID válido').optional(),
  notes: z.string().optional(),
  address: z.record(z.any()).optional(),
  completed_date: z.string()
    .refine((val: string) => {
      if (!val) return true; // opcional
      // Verificar que sea una fecha válida ISO 8601 (con o sin timezone)
      const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?$/;
      if (!iso8601Regex.test(val)) return false;
      
      // Verificar que la fecha sea válida
      const date = new Date(val);
      return !isNaN(date.getTime());
    }, 'Fecha de completado debe ser ISO 8601 válida (con o sin timezone)')
    .optional()
});

/**
 * PUT endpoint para actualizar una tarea existente
 */
export async function PUT(request: NextRequest) {
  try {
    console.log('[UpdateTask] Iniciando actualización de tarea');

    const body = await request.json();
    console.log('[UpdateTask] Datos recibidos:', JSON.stringify(body, null, 2));

    // Preprocesar los datos para transformar fechas
    const preprocessedData = preprocessTaskData(body);
    console.log('[UpdateTask] Datos preprocesados:', JSON.stringify(preprocessedData, null, 2));

    // Validar los datos de entrada
    const validatedData = UpdateTaskSchema.parse(preprocessedData);
    console.log('[UpdateTask] Datos validados correctamente');

    const { task_id, site_id, ...updateFields } = validatedData;

    // Verificar que la tarea existe y pertenece al sitio
    console.log('[UpdateTask] Verificando existencia de tarea:', task_id, 'en sitio:', site_id);
    const existingTask = await getTaskById(task_id);
    
    if (!existingTask) {
      return NextResponse.json({
        success: false,
        error: 'Tarea no encontrada'
      }, { status: 404 });
    }

    if (existingTask.site_id !== site_id) {
      return NextResponse.json({
        success: false,
        error: 'No tienes permiso para actualizar esta tarea'
      }, { status: 403 });
    }

    console.log('[UpdateTask] Tarea encontrada:', existingTask.id);

    // Actualizar la tarea
    console.log('[UpdateTask] Actualizando tarea con datos:', updateFields);
    try {
      const updatedTask = await updateTask(task_id, updateFields);
      console.log('[UpdateTask] Tarea actualizada exitosamente:', updatedTask.id);

      return NextResponse.json({
        success: true,
        task: updatedTask
      }, { status: 200 });
    } catch (updateError: any) {
      console.error('[UpdateTask] Error en updateTask:', updateError);
      return NextResponse.json({
        success: false,
        error: `Error actualizando tarea: ${updateError.message}`
      }, { status: 500 });
    }

  } catch (error) {
    console.error('[UpdateTask] Error inesperado:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Datos de entrada inválidos',
        details: error.errors
      }, { status: 400 });
    }

    // Si es un error de la base de datos
    if (error instanceof Error && error.message.includes('Error updating task')) {
      return NextResponse.json({
        success: false,
        error: error.message
      }, { status: 500 });
    }

    return NextResponse.json({
      success: false,
      error: 'Error interno del servidor'
    }, { status: 500 });
  }
}

/**
 * POST endpoint para compatibilidad (alias de PUT)
 */
export async function POST(request: NextRequest) {
  return PUT(request);
}

/**
 * GET endpoint para información sobre la API
 */
export async function GET() {
  return NextResponse.json({
    message: "API de actualización de tareas",
    description: "Actualiza una tarea existente en el sistema con nueva información",
    usage: "Envía una solicitud PUT o POST con el task_id y los campos a actualizar",
    endpoint: "/api/agents/tools/tasks/update",
    methods: ["PUT", "POST", "GET"],
    required_fields: [
      "task_id"
    ],
    optional_fields: [
      "title",
      "description",
      "type",
      "status",
      "stage", 
      "priority",
      "scheduled_date",
      "amount",
      "assignee",
      "notes",
      "address",
      "completed_date"
    ],
    task_statuses: ["in_progress", "failed", "pending", "completed"],
    task_stages: "String libre (etapas del customer_journey, ej: 'awareness', 'consideration', 'decision')",
    task_types: "String libre (cualquier tipo personalizado permitido, ej: 'call', 'email', 'demo', 'custom_type')",
    priority_levels: "Número entero (0 = más baja, números más altos = mayor prioridad)",
    update_behavior: {
      partial_updates: "Solo los campos proporcionados se actualizan",
      preserve_existing: "Los campos no incluidos permanecen sin cambios",
      automatic_timestamp: "updated_at se actualiza automáticamente",
      validation: "Validación de entrada para integridad de datos"
    },
    example_request: {
      task_id: "abcdef12-3456-7890-abcd-ef1234567890",
      status: "in_progress",
      stage: "decision",
      priority: 15,
      notes: "Cliente muy interesado, programar demo técnico",
      scheduled_date: "2023-12-20T14:00:00Z",
      address: {
        venue_name: "Oficina del cliente",
        street: "456 Business Ave",
        city: "San Francisco",
        country: "USA"
      }
    },
    example_response: {
      success: true,
      task: {
        id: "abcdef12-3456-7890-abcd-ef1234567890",
        title: "Seguimiento de lead",
        description: "Llamar al cliente para confirmar interés",
        type: "call",
        status: "in_progress",
        stage: "decision",
        priority: 15,
        user_id: "12345678-1234-1234-1234-123456789012",
        site_id: "87654321-4321-4321-4321-210987654321",
        lead_id: "lead-456",
        scheduled_date: "2023-12-20T14:00:00Z",
        notes: "Cliente muy interesado, programar demo técnico",
        amount: 1500.00,
        address: {
          venue_name: "Oficina del cliente",
          street: "456 Business Ave",
          city: "San Francisco",
          country: "USA"
        },
        created_at: "2023-12-10T10:30:00Z",
        updated_at: "2023-12-15T14:22:00Z"
      }
    },
    common_patterns: {
      status_update: {
        task_id: "task-id",
        status: "in_progress",
        stage: "consideration"
      },
      completion: {
        task_id: "task-id",
        status: "completed",
        stage: "completed",
        completed_date: "2023-12-20T16:30:00Z"
      },
      reassignment: {
        task_id: "task-id",
        assignee: "new-user-id",
        notes: "Reassigned to specialist"
      },
      schedule_change: {
        task_id: "task-id",
        scheduled_date: "2023-12-25T10:00:00Z",
        notes: "Rescheduled per customer request"
      }
    }
  });
} 