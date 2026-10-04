import { NextRequest, NextResponse } from 'next/server';
import { runReportQuery } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await runReportQuery(body);
    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}