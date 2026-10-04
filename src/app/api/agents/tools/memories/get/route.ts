import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getMemoriesCore } from './core';

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