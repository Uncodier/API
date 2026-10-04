import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getInstancePlansCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getInstancePlansCore(body);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[GetInstancePlan] Error:', error);
    if (error instanceof z.ZodError) {
        return NextResponse.json({ success: false, error: 'Invalid filters', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
  }
}