import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createInstancePlanCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createInstancePlanCore(body);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[CreateInstancePlan] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid input', details: error.errors }, { status: 400 });
    }
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    const status = errorMessage === 'Instance not found' ? 404 : (errorMessage === 'La instancia no pertenece a este sitio' ? 403 : 500);
    return NextResponse.json({ success: false, error: errorMessage }, { status });
  }
}