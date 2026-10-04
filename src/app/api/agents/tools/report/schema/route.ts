import { NextRequest, NextResponse } from 'next/server';
import { getSchemaCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { site_id, user_id } = body;

    if (!site_id || !user_id) {
      return NextResponse.json(
        { success: false, error: 'site_id and user_id are required' },
        { status: 400 }
      );
    }

    return NextResponse.json(getSchemaCore(site_id, user_id));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}