import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { updateAssetCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const asset = await updateAssetCore(body);

    return NextResponse.json({
      success: true,
      asset,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid input',
        details: error.errors,
      }, { status: 400 });
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'Asset not found') {
      return NextResponse.json({ success: false, error: errorMessage }, { status: 404 });
    }
    if (errorMessage === 'No tienes permiso para actualizar este asset') {
      return NextResponse.json({ success: false, error: errorMessage }, { status: 403 });
    }

    return NextResponse.json({
      success: false,
      error: errorMessage,
    }, { status: 500 });
  }
}
