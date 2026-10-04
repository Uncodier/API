import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { updateInstancePlanCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await updateInstancePlanCore(body);
    return NextResponse.json(result);

  } catch (error) {
    console.error('[UpdateInstancePlan] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid input', details: error.errors }, { status: 400 });
    }
    const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
    const status = errorMessage === 'Plan not found' ? 404 : (errorMessage === 'No tienes permiso para actualizar este plan' ? 403 : 500);
    return NextResponse.json({ success: false, error: errorMessage }, { status });
  }
}