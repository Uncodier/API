import { NextRequest, NextResponse } from 'next/server';
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getMemoriesCore(body);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('[GetMemories] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'Invalid input', details: error.errors },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'Memory List API',
    usage: 'POST with agent_id and optional filters',
    endpoint: '/api/agents/tools/memories/get',
  });
}
