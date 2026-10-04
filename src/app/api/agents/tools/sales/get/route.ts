import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSalesCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await getSalesCore(body);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('[GetSales] Error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Invalid filters', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    message: "Sales query API",
    usage: "POST with filters",
    filters: ["customer_id", "site_id", "status", "limit", "offset"]
  });
}