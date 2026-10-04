import { z } from 'zod';
import { getTasks, getTaskStats } from '@/lib/database/task-db';
import {
  readRedisJson,
  writeRedisJson,
} from '@/lib/services/redis-json-cache';

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
 * Core logic for getTask - callable from route or assistant protocol
 */
export async function getTaskCore(filters: Record<string, unknown>) {
  const validatedFilters = GetTasksSchema.parse(filters);
  const filterObj = { ...validatedFilters };
  const cacheKey = `cache:task-list:${Buffer.from(
    JSON.stringify(filterObj),
  ).toString('base64url')}`;

  if (!validatedFilters.include_archived && filterObj.status === 'archived') {
    throw new Error('No se pueden obtener tareas archivadas cuando include_archived es false');
  }
  if (!validatedFilters.include_completed && filterObj.stage === 'completed') {
    throw new Error('No se pueden obtener tareas completadas cuando include_completed es false');
  }

  const cached = await readRedisJson<Record<string, unknown>>(cacheKey);
  if (cached) return cached;

  const [tasksResult, stats] = await Promise.all([
    getTasks(filterObj),
    getTaskStats(filterObj),
  ]);

  const result = {
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
  await writeRedisJson(cacheKey, result, 5);
  return result;
}