import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { updateContentCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const content = await updateContentCore(body);

    return NextResponse.json(
      {
        success: true,
        content,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid input',
          details: error.errors,
        },
        { status: 400 }
      );
    }
    if (error instanceof Error) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 500 }
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  return POST(request);
}