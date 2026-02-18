import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteAgentMemory } from '@/lib/services/agent-memory-tools-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const DeleteMemorySchema = z.object({
  memory_id: z.string().uuid('Memory ID must be a valid UUID'),
  agent_id: z.string().uuid('Agent ID must be a valid UUID'),
  site_id: z.string().uuid('Site ID is required'),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = DeleteMemorySchema.parse(body);

    // Verificar que el agente pertenece al sitio
    const { data: agentData, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('site_id')
      .eq('id', validatedData.agent_id)
      .single();

    if (agentError || !agentData) {
      return NextResponse.json({ success: false, error: 'Agent not found' }, { status: 404 });
    }

    if (agentData.site_id !== validatedData.site_id) {
      return NextResponse.json({ success: false, error: 'El agente no pertenece a este sitio' }, { status: 403 });
    }

    const result = await deleteAgentMemory(
      validatedData.memory_id,
      validatedData.agent_id
    );

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { success: true, message: 'Memory deleted successfully' },
      { status: 200 }
    );
  } catch (error) {
    console.error('[DeleteMemory] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'Invalid input', details: error.errors },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'Memory Delete API',
    usage: 'POST with memory_id and agent_id',
    endpoint: '/api/agents/tools/memories/delete',
  });
}
