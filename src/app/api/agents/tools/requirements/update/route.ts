import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { RemoteToolError } from '@/lib/mcp/remote-client';
import { updateRequirementCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await updateRequirementCore(body);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid input',
        details: error.errors,
      }, { status: 400 });
    }

    if (error instanceof RemoteToolError) {
      return NextResponse.json(error.data || {
        success: false,
        error: error.message
      }, { status: error.status });
    }

    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    const status = errorMessage === 'Requirement not found' ? 404 : (errorMessage === 'No tienes permiso para actualizar este requerimiento' ? 403 : 500);
    return NextResponse.json({
      success: false,
      error: errorMessage,
    }, { status: status });
  }
}

export async function PUT(request: NextRequest) {
  return POST(request);
}