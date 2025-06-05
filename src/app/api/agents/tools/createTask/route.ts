import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createTask } from '@/lib/database/task-db';
import { supabaseAdmin } from '@/lib/database/supabase-server';

/**
 * Función para transformar diferentes formatos de fecha a ISO 8601
 */
function transformToISO8601(dateInput: any): string | null {
  if (!dateInput) return null;
  
  try {
    // Si ya es un string que parece ISO 8601, validarlo
    if (typeof dateInput === 'string' && dateInput.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
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

    // Si es un string, intentar diferentes formatos
    if (typeof dateInput === 'string') {
      let dateStr = dateInput.trim();
      
      // Verificar si es una fecha claramente inválida
      if (dateStr.match(/[a-zA-Z]/) && !dateStr.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)) {
        // Si contiene letras pero no es un formato de fecha conocido, retornar null
        return null;
      }
      
      // Manejar formatos comunes con regex más específicos
      const formats = [
        // YYYY-MM-DD o YYYY/MM/DD
        {
          regex: /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'ymd'
        },
        // DD/MM/YYYY o DD-MM-YYYY (día > 12)
        {
          regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'dmy',
          condition: (parts: string[]) => parseInt(parts[0]) > 12
        },
        // MM/DD/YYYY o MM-DD-YYYY (mes > 12)
        {
          regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'mdy',
          condition: (parts: string[]) => parseInt(parts[1]) > 12
        },
        // DD/MM/YYYY o DD-MM-YYYY (por defecto)
        {
          regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
          order: 'dmy'
        }
      ];

      // Intentar con Date constructor primero para formatos estándar
      let date = new Date(dateStr);
      if (!isNaN(date.getTime()) && dateStr.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)) {
        return date.toISOString();
      }

      // Intentar parsear manualmente formatos específicos
      for (const format of formats) {
        const match = dateStr.match(format.regex);
        if (match) {
          const [, part1, part2, part3, , hour, minute, , second] = match;
          
          // Verificar condición si existe
          if (format.condition && !format.condition([part1, part2, part3])) {
            continue;
          }
          
          let day: number, month: number, year: number;
          
          switch (format.order) {
            case 'ymd':
              year = parseInt(part1);
              month = parseInt(part2);
              day = parseInt(part3);
              break;
            case 'mdy':
              month = parseInt(part1);
              day = parseInt(part2);
              year = parseInt(part3);
              break;
            case 'dmy':
            default:
              day = parseInt(part1);
              month = parseInt(part2);
              year = parseInt(part3);
              break;
          }

          // Validar rangos
          if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) {
            continue;
          }

          // Construir fecha en UTC para evitar problemas de zona horaria
          const h = hour ? parseInt(hour) : 0;
          const m = minute ? parseInt(minute) : 0;
          const s = second ? parseInt(second) : 0;
          
          // Usar UTC para evitar conversiones de zona horaria
          date = new Date(Date.UTC(year, month - 1, day, h, m, s));
          
          if (!isNaN(date.getTime())) {
            return date.toISOString();
          }
        }
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
    console.warn('[CreateTask] Error transformando fecha:', dateInput, error);
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
      console.log('[CreateTask] Fecha transformada:', data.scheduled_date, '->', transformedDate);
    } else {
      console.warn('[CreateTask] No se pudo transformar la fecha:', data.scheduled_date);
      // Remover la fecha si no se puede transformar para evitar error de validación
      delete processed.scheduled_date;
    }
  }
  
  return processed;
}

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

    // Preprocesar los datos para transformar fechas
    const preprocessedData = preprocessTaskData(body);
    console.log('[CreateTask] Datos preprocesados:', JSON.stringify(preprocessedData, null, 2));

    // Validar los datos de entrada
    const validatedData = CreateTaskSchema.parse(preprocessedData);
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
    date_formats: {
      description: "La API acepta múltiples formatos de fecha y los convierte automáticamente a ISO 8601",
      supported_formats: [
        "ISO 8601: '2023-12-15T14:00:00Z'",
        "DD/MM/YYYY: '15/12/2023' o '15/12/2023 14:00'",
        "MM/DD/YYYY: '12/15/2023' o '12/15/2023 14:00'",
        "YYYY-MM-DD: '2023-12-15' o '2023-12-15 14:00'",
        "Timestamp Unix: 1702644000 (segundos) o 1702644000000 (milisegundos)",
        "Formatos nativos de JavaScript: 'Dec 15, 2023', 'December 15, 2023'"
      ],
      note: "Si no se puede parsear la fecha, se omitirá del registro para evitar errores"
    },
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
      scheduled_date: "15/12/2023 14:00", // Formato flexible
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
        scheduled_date: "2023-12-15T14:00:00.000Z", // Convertido a ISO 8601
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