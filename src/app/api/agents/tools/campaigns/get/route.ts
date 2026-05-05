import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCampaignCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getCampaignCore(body);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid input',
        details: error.errors,
      }, { status: 400 });
    }
    if (error instanceof Error) {
      return NextResponse.json({
        success: false,
        error: error.message,
      }, { status: 500 });
    }
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
    }, { status: 500 });
  }
}
