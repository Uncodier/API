import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { analyzeICPTotalCountCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await analyzeICPTotalCountCore(body);
    return NextResponse.json(result, {
      status: result.success ? 200 : 500,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid parameters',
          details: error.errors,
        },
        { status: 400 }
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
