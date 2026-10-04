import { NextRequest, NextResponse } from 'next/server';
import { BacklogCoreParams, executeBacklogCore } from './core';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BacklogCoreParams;
    const result = await executeBacklogCore(body);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to execute requirement_backlog';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}