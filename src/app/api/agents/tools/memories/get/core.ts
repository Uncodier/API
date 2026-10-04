import { z } from 'zod';
import { getAgentMemories } from '@/lib/services/agent-memory-tools-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const GetMemoriesSchema = z.object({
  agent_id: z.string().uuid('Agent ID must be a valid UUID'),
  site_id: z.string().uuid('Site ID is required'),
  search_query: z.string().optional(),
  type: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  instance_id: z.string().optional(),
  client_id: z.string().optional(),
  project_id: z.string().optional(),
  task_id: z.string().optional(),
});

export async function getMemoriesCore(filters: any) {
  const validatedFilters = GetMemoriesSchema.parse(filters);

  // Verificar que el agente pertenece al sitio
  const { data: agentData, error: agentError } = await supabaseAdmin
    .from('agents')
    .select('site_id')
    .eq('id', validatedFilters.agent_id)
    .single();

  if (agentError || !agentData) {
    throw new Error('Agent not found');
  }

  if (agentData.site_id !== validatedFilters.site_id) {
    throw new Error('El agente no pertenece a este sitio');
  }

  const result = await getAgentMemories(validatedFilters.agent_id, {
    search_query: validatedFilters.search_query,
    type: validatedFilters.type,
    limit: validatedFilters.limit,
    instance_id: validatedFilters.instance_id,
    client_id: validatedFilters.client_id,
    project_id: validatedFilters.project_id,
    task_id: validatedFilters.task_id,
    site_id: validatedFilters.site_id,
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to fetch memories');
  }

  return {
    success: true,
    data: {
      memories: result.memories || [],
      count: result.memories?.length || 0,
      filters_applied: validatedFilters,
    },
  };
}

