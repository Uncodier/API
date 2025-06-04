import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createTask } from '@/lib/database/task-db';
import { supabaseAdmin } from '@/lib/database/supabase-server';

/**
 * Esquema para validar los datos de entrada
 */
const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Título es requerido'),
  description: z.string().optional(),
  type: z.string().min(1, 'Tipo de tarea es requerido'),
  status: z.enum(['in_progress', 'failed', 'pending', 'completed']).default('pending'),
  stage: z.string().default('pending'),
  priority: z.number().int().min(0).default(0),
  lead_id: z.string().uuid('Lead ID debe ser un UUID válido'),
  user_id: z.string().uuid('User ID debe ser un UUID válido').optional(),
  site_id: z.string().uuid('Site ID debe ser un UUID válido').optional(),
  scheduled_date: z.string().datetime('Fecha debe ser ISO 8601').optional(),
  amount: z.number().optional(),
  assignee: z.string().uuid('Assignee debe ser un UUID válido').optional(),
  notes: z.string().optional(),
  command_id: z.string().uuid('Command ID debe ser un UUID válido').optional(),
  address: z.record(z.any()).optional()
});

/**
 * Tipos de tareas válidos
 */
const VALID_TASK_TYPES = [
  'website_visit',
  'demo',
  'meeting',
  'email',
  'call',
  'quote',
  'contract',
  'payment',
  'referral',
  'feedback'
];

/**
 * Obtiene la información del lead y sus relaciones
 */
async function getLeadInfo(leadId: string) {
  try {
    const { data: lead, error } = await supabaseAdmin
      .from('leads')
      .select(`
        id,
        user_id,
        site_id,
        name,
        email,
        company
      `)
      .eq('id', leadId)
      .single();

    if (error || !lead) {
      return null;
    }

    return lead;
  } catch (error) {
    console.error('Error getting lead info:', error);
    return null;
  }
}

/**
 * POST endpoint para crear una nueva tarea
 */
export async function POST(request: NextRequest) {
  try {
    console.log('[CreateTask] Iniciando creación de tarea');

    const body = await request.json();
    console.log('[CreateTask] Datos recibidos:', JSON.stringify(body, null, 2));

    // Validar los datos de entrada
    const validatedData = CreateTaskSchema.parse(body);
    console.log('[CreateTask] Datos validados correctamente');

    // Obtener información del lead
    console.log('[CreateTask] Obteniendo información del lead:', validatedData.lead_id);
    const leadInfo = await getLeadInfo(validatedData.lead_id);
    
    if (!leadInfo) {
      return NextResponse.json({
        success: false,
        error: 'Lead no encontrado'
      }, { status: 404 });
    }

    console.log('[CreateTask] Información del lead obtenida:', leadInfo);

    // Usar datos del lead si no se especificaron
    const taskData = {
      title: validatedData.title,
      description: validatedData.description,
      type: validatedData.type,
      status: validatedData.status,
      stage: validatedData.stage,
      priority: validatedData.priority,
      user_id: validatedData.user_id || leadInfo.user_id, // Usar del lead si no se especifica
      site_id: validatedData.site_id || leadInfo.site_id, // Usar del lead si no se especifica
      lead_id: validatedData.lead_id,
      scheduled_date: validatedData.scheduled_date,
      amount: validatedData.amount,
      assignee: validatedData.assignee,
      notes: validatedData.notes,
      command_id: validatedData.command_id,
      address: validatedData.address
    };

    console.log('[CreateTask] Datos finales para crear tarea:', taskData);

    // Crear la tarea
    console.log('[CreateTask] Llamando a createTask...');
    try {
      const newTask = await createTask(taskData);
      console.log('[CreateTask] Tarea creada exitosamente:', newTask.id);

      return NextResponse.json({
        success: true,
        task: newTask
      }, { status: 201 });
    } catch (createError: any) {
      console.error('[CreateTask] Error en createTask:', createError);
      return NextResponse.json({
        success: false,
        error: `Error creando tarea: ${createError.message}`
      }, { status: 500 });
    }

  } catch (error) {
    console.error('[CreateTask] Error inesperado:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Datos de entrada inválidos',
        details: error.errors
      }, { status: 400 });
    }

    // Si es un error de la base de datos
    if (error instanceof Error && error.message.includes('Error creating task')) {
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
 * GET endpoint para información sobre la API
 */
export async function GET() {
  return NextResponse.json({
    message: "API de creación de tareas",
    description: "Crea una nueva tarea en el sistema con información automática del lead",
    usage: "Envía una solicitud POST con los datos de la tarea",
    endpoint: "/api/agents/tools/createTask",
    methods: ["POST", "GET"],
    required_fields: [
      "title",
      "type", 
      "lead_id"
    ],
    optional_fields: [
      "description",
      "status",
      "stage", 
      "priority",
      "user_id", // Se obtiene del lead automáticamente si no se especifica
      "site_id", // Se obtiene del lead automáticamente si no se especifica
      "scheduled_date",
      "amount",
      "assignee",
      "notes",
      "command_id",
      "address"
    ],
    task_statuses: ["in_progress", "failed", "pending", "completed"],
    task_stages: "String libre (etapas del customer_journey, ej: 'awareness', 'consideration', 'decision')",
    task_types: "String libre (cualquier tipo personalizado permitido, ej: 'call', 'email', 'demo', 'custom_type')",
    priority_levels: "Número entero (0 = más baja, números más altos = mayor prioridad)",
    automatic_fields: {
      "user_id": "Se obtiene automáticamente del lead si no se especifica",
      "site_id": "Se obtiene automáticamente del lead si no se especifica"
    },
    example_request: {
      title: "Seguimiento de lead",
      description: "Llamar al cliente para confirmar interés",
      type: "call",
      priority: 10,
      lead_id: "abcdef12-3456-7890-abcd-ef1234567890",
      scheduled_date: "2023-12-15T14:00:00Z",
      amount: 1500.00,
      notes: "Cliente muy interesado en el producto enterprise",
      address: {
        street: "123 Main St",
        city: "Ciudad",
        country: "México"
      }
    },
    example_response: {
      success: true,
      task: {
        id: "task_123456",
        title: "Seguimiento de lead",
        description: "Llamar al cliente para confirmar interés",
        type: "call",
        status: "pending",
        stage: "pending",
        priority: 10,
        user_id: "12345678-1234-1234-1234-123456789012", // Obtenido del lead
        site_id: "87654321-4321-4321-4321-210987654321", // Obtenido del lead
        lead_id: "abcdef12-3456-7890-abcd-ef1234567890",
        scheduled_date: "2023-12-15T14:00:00Z",
        notes: "Cliente muy interesado en el producto enterprise",
        amount: 1500.00,
        address: {
          street: "123 Main St",
          city: "Ciudad",
          country: "México"
        },
        created_at: "2023-12-10T10:30:00Z",
        updated_at: "2023-12-10T10:30:00Z"
      }
    }
  });
} 