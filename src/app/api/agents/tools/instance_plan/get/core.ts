import { supabaseAdmin } from '@/lib/database/supabase-client';
import { z } from 'zod';
import {
  canReadProcurementWorkflowInstanceAsActor,
  filterAccessibleProcurementWorkflowInstances,
} from '@/lib/services/workflow-robot/procurement-access';

const GetInstancePlansSchema = z.object({
  instance_id: z.string().uuid('Invalid instance_id').optional(),
  site_id: z.string().uuid('Site ID is required'),
  user_id: z.string().uuid('Invalid user_id').optional(),
  agent_id: z.string().uuid('Invalid agent_id').optional(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled', 'paused', 'in_progress', 'active']).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export class InstancePlansReadForbiddenError extends Error {
  constructor() { super('Forbidden'); }
}

/** Scope is supplied by the authenticated route or host closure, never tool filters. */
export async function getInstancePlansCore(
  filters: Record<string, unknown>,
  scope?: { userId: string | null; internal: boolean },
) {
  const validatedFilters = GetInstancePlansSchema.parse(filters);

  let accessibleInstanceIds: string[] | undefined;
  if (!scope?.internal) {
    const userId = scope?.userId ?? null;
    if (validatedFilters.instance_id) {
      if (!await canReadProcurementWorkflowInstanceAsActor(
        validatedFilters.site_id, validatedFilters.instance_id, userId,
      )) throw new InstancePlansReadForbiddenError();
    } else {
      // Authorize metadata-only candidates before reading payloads or counting plans.
      // Page the candidates so the database's default row cap cannot hide accessible plans.
      const instanceIds: string[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data: instances, error } = await supabaseAdmin.from('remote_instances')
          .select('id').eq('site_id', validatedFilters.site_id)
          .order('id', { ascending: true }).range(offset, offset + 999);
        if (error) throw new Error('Cannot verify instance plan access');
        instanceIds.push(...(instances || []).map(instance => instance.id));
        if (!instances || instances.length < 1000) break;
      }
      accessibleInstanceIds = Array.from(await filterAccessibleProcurementWorkflowInstances(
        validatedFilters.site_id, userId, instanceIds,
      ));
      if (accessibleInstanceIds.length === 0) {
        return {
          success: true,
          data: {
            plans: [],
            pagination: { total: 0, count: 0, offset: validatedFilters.offset,
              limit: validatedFilters.limit, has_more: false },
            filters_applied: validatedFilters,
          },
        };
      }
    }
  }

  let query = supabaseAdmin
    .from('instance_plans')
    .select('*', { count: 'exact' });

  if (validatedFilters.instance_id) {
    query = query.eq('instance_id', validatedFilters.instance_id);
  }
  if (accessibleInstanceIds) {
    query = query.in('instance_id', accessibleInstanceIds);
  }
  if (validatedFilters.site_id) {
    query = query.eq('site_id', validatedFilters.site_id);
  }
  if (validatedFilters.user_id) {
    query = query.eq('user_id', validatedFilters.user_id);
  }
  if (validatedFilters.agent_id) {
    query = query.eq('agent_id', validatedFilters.agent_id);
  }
  if (validatedFilters.status) {
    query = query.eq('status', validatedFilters.status);
  }

  query = query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(validatedFilters.offset, validatedFilters.offset + validatedFilters.limit - 1);

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Error fetching instance plans: ${error.message}`);
  }

  return {
    success: true,
    data: {
      plans: data,
      pagination: {
        total: count,
        count: data.length,
        offset: validatedFilters.offset,
        limit: validatedFilters.limit,
        has_more: (count || 0) > validatedFilters.offset + data.length,
      },
      filters_applied: validatedFilters,
    },
  };
}

