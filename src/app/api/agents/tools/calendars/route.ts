import { NextRequest, NextResponse } from 'next/server';
import { calendarsCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await calendarsCore(body);
    const failed = result && typeof result === 'object' && 'success' in result && result.success === false;
    return NextResponse.json(result, { status: failed ? 400 : 200 });
  } catch (error: any) {
    console.error('Calendars tool error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
