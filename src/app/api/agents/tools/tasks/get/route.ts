import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getTasks, getTaskStats } from '@/lib/database/task-db';

/**
 * Esquema para validar los filtros de búsqueda de tareas
 */
const GetTasksSchema = z.object({
  lead_id: z.string().uuid('Lead ID debe ser un UUID válido').optional(),
  user_id: z.string().uuid('ID de usuario debe ser un UUID válido').optional(),
  site_id: z.string().uuid('Site ID es requerido'),
  visitor_id: z.string().uuid('ID de visitante debe ser un UUID válido').optional(),
  assignee: z.string().uuid('ID de asignado debe ser un UUID válido').optional(),
  command_id: z.string().uuid('ID de comando debe ser un UUID válido').optional(),
  type: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  stage: z.string().optional(),
  priority: z.number().int().optional(),
  scheduled_date_from: z.string().datetime('Fecha debe ser ISO 8601').optional(),
  scheduled_date_to: z.string().datetime('Fecha debe ser ISO 8601').optional(),
  completed_date_from: z.string().datetime('Fecha debe ser ISO 8601').optional(),
  completed_date_to: z.string().datetime('Fecha debe ser ISO 8601').optional(),
  created_date_from: z.string().datetime('Fecha debe ser ISO 8601').optional(),
  created_date_to: z.string().datetime('Fecha debe ser ISO 8601').optional(),
  search: z.string().optional(),
  sort_by: z.enum(['created_at', 'updated_at', 'scheduled_date', 'completed_date', 'priority', 'title', 'type', 'status']).optional().default('created_at'),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
  limit: z.number().int().min(1).max(500).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
  include_completed: z.boolean().optional().default(true),
  include_archived: z.boolean().optional().default(false)
});

/**
 * Tipos de tareas válidos (referencia para documentación; la DB acepta cualquier type)
 */
const VALID_TASK_TYPES = [
  'follow_up',
  'marketing_campaign',
  'sales_demo',
  'content_creation',
  'lead_qualification',
  'customer_support',
  'meeting_preparation',
  'market_research',
  'product_feedback',
  'administrative',
  'website_visit',
  'demo',
  'meeting',
  'email',
  'call',
  'quote',
  'contract',
  'payment',
  'referral',
  'feedback',
];

/**
 * Core logic for getTask - callable from route or assistant protocol
 */
export async function getTaskCore(filters: Record<string, unknown>) {
  const validatedFilters = GetTasksSchema.parse(filters);
  const filterObj = { ...validatedFilters };

  if (!validatedFilters.include_archived && filterObj.status === 'archived') {
    throw new Error('No se pueden obtener tareas archivadas cuando include_archived es false');
  }
  if (!validatedFilters.include_completed && filterObj.stage === 'completed') {
    throw new Error('No se pueden obtener tareas completadas cuando include_completed es false');
  }

  const [tasksResult, stats] = await Promise.all([
    getTasks(filterObj),
    getTaskStats(filterObj),
  ]);

  return {
    success: true,
    data: {
      tasks: tasksResult.tasks,
      pagination: {
        total: tasksResult.total,
        count: tasksResult.tasks.length,
        offset: filterObj.offset,
        limit: filterObj.limit,
        has_more: tasksResult.hasMore,
      },
      filters_applied: {
        ...validatedFilters,
        ...(validatedFilters.user_id && { user_id: validatedFilters.user_id }),
        ...(validatedFilters.site_id && { site_id: validatedFilters.site_id }),
        ...(validatedFilters.lead_id && { lead_id: validatedFilters.lead_id }),
        ...(validatedFilters.type && { type: validatedFilters.type }),
        ...(validatedFilters.status && { status: validatedFilters.status }),
        ...(validatedFilters.stage && { stage: validatedFilters.stage }),
        ...(validatedFilters.priority && { priority: validatedFilters.priority }),
        ...(validatedFilters.search && { search: validatedFilters.search }),
      },
      summary: {
        total_tasks: stats.total,
        by_status: stats.byStatus,
        by_stage: stats.byStage,
        by_priority: stats.byPriority,
        by_type: stats.byType,
        overdue_tasks: stats.overdue,
        due_today: stats.dueToday,
        due_this_week: stats.dueThisWeek,
      },
    },
  };
}

/**
 * POST endpoint para obtener tareas con filtros
 */
export async function POST(request: NextRequest) {
  try {
    console.log('[GetTask] Iniciando búsqueda de tareas');

    const body = await request.json();
    console.log('[GetTask] Filtros recibidos:', JSON.stringify(body, null, 2));

    const result = await getTaskCore(body);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('[GetTask] Error inesperado:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Filtros de entrada inválidos',
        details: error.errors
      }, { status: 400 });
    }

    if (error instanceof Error && error.message.includes('No se pueden obtener')) {
      return NextResponse.json({
        success: false,
        error: error.message
      }, { status: 400 });
    }

    if (error instanceof Error && error.message.includes('Error getting tasks')) {
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
    message: "API de consulta de tareas",
    description: "Obtiene tareas del sistema con filtros avanzados. Principalmente diseñada para trabajar con lead_id.",
    usage: "Envía una solicitud POST con los filtros deseados",
    endpoint: "/api/agents/tools/tasks/get",
    methods: ["POST", "GET"],
    primary_filter: "lead_id",
    optional_filters: [
      "lead_id",
      "user_id",
      "site_id", 
      "visitor_id",
      "assignee",
      "command_id",
      "type",
      "status",
      "stage",
      "priority",
      "scheduled_date_from",
      "scheduled_date_to",
      "completed_date_from", 
      "completed_date_to",
      "created_date_from",
      "created_date_to",
      "search",
      "sort_by",
      "sort_order",
      "limit",
      "offset",
      "include_completed",
      "include_archived"
    ],
    valid_task_types: VALID_TASK_TYPES,
    task_statuses: ["active", "inactive", "archived"],
    task_stages: "String libre (etapas del customer_journey, ej: 'pending', 'in_progress', 'completed')",
    priority_levels: "Número entero (0 = más baja, números más altos = mayor prioridad)",
    sort_fields: ["created_at", "updated_at", "scheduled_date", "completed_date", "priority", "title", "type", "status"],
    sort_orders: ["asc", "desc"],
    pagination: {
      default_limit: 50,
      max_limit: 500,
      default_offset: 0
    },
    recommended_usage: [
      {
        name: "Obtener tareas de un lead específico",
        example: {
          lead_id: "abcdef12-3456-7890-abcd-ef1234567890",
          sort_by: "created_at",
          sort_order: "desc"
        }
      },
      {
        name: "Obtener tareas activas de un lead",
        example: {
          lead_id: "abcdef12-3456-7890-abcd-ef1234567890",
          status: "active",
          include_completed: false
        }
      },
      {
        name: "Obtener tareas pendientes de un lead",
        example: {
          lead_id: "abcdef12-3456-7890-abcd-ef1234567890",
          stage: "pending",
          sort_by: "priority",
          sort_order: "desc"
        }
      }
    ],
    example_request: {
      lead_id: "abcdef12-3456-7890-abcd-ef1234567890",
      status: "active",
      sort_by: "scheduled_date",
      sort_order: "asc",
      limit: 20,
      include_completed: false
    },
    example_response: {
      success: true,
      data: {
        tasks: [
          {
            id: "task_123456",
            title: "Seguimiento de lead",
            description: "Llamar al cliente para confirmar interés",
            type: "follow_up",
            status: "active",
            stage: "pending",
            priority: 10,
            user_id: "12345678-1234-1234-1234-123456789012",
            site_id: "87654321-4321-4321-4321-210987654321",
            lead_id: "abcdef12-3456-7890-abcd-ef1234567890",
            scheduled_date: "2024-01-15T14:00:00Z",
            notes: "Cliente muy interesado en el producto enterprise",
            created_at: "2024-01-10T10:30:00Z",
            updated_at: "2024-01-10T10:30:00Z"
          }
        ],
        pagination: {
          total: 1,
          count: 1,
          offset: 0,
          limit: 20,
          has_more: false
        },
        filters_applied: {
          lead_id: "abcdef12-3456-7890-abcd-ef1234567890",
          status: "active"
        },
        summary: {
          total_tasks: 42,
          by_status: { active: 35, inactive: 5, archived: 2 },
          by_stage: { pending: 20, in_progress: 12, completed: 10 },
          by_priority: { "0": 8, "5": 22, "10": 10, "20": 2 },
          overdue_tasks: 3,
          due_today: 5,
          due_this_week: 18
        }
      }
    }
  });
} 