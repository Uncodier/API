import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { saveOnAgentMemory } from '@/lib/services/agent-memory-tools-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const SaveMemorySchema = z.object({
  agent_id: z.string().uuid('Agent ID must be a valid UUID'),
  user_id: z.string().uuid('User ID must be a valid UUID'),
  site_id: z.string().uuid('Site ID is required'),
  content: z.string().min(1, 'Content is required'),
  key: z.string().optional(),
  summary: z.string().optional(),
  type: z.string().optional(),
  instance_id: z.string().optional(),
  client_id: z.string().optional(),
  project_id: z.string().optional(),
  task_id: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = SaveMemorySchema.parse(body);

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

    const result = await saveOnAgentMemory(
      validatedData.agent_id,
      validatedData.user_id,
      validatedData.content,
      {
        key: validatedData.key,
        summary: validatedData.summary,
        type: validatedData.type,
        instance_id: validatedData.instance_id,
        client_id: validatedData.client_id,
        project_id: validatedData.project_id,
        task_id: validatedData.task_id,
      }
    );

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { success: true, memory_id: result.memoryId, message: 'Memory saved successfully' },
      { status: 201 }
    );
  } catch (error) {
    console.error('[SaveMemory] Error:', error);
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
    message: 'Memory Save API',
    usage: 'POST with agent_id, user_id, content',
    endpoint: '/api/agents/tools/memories/save',
  });
}
