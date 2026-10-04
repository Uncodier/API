import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getTaskCore } from './core';

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