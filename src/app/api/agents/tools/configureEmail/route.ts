import { NextRequest, NextResponse } from 'next/server';
import { configureEmailCore, ConfigureEmailBody } from './core';

/**
 * POST /api/agents/tools/configureEmail
 * Body: { site_id, action, ...params }
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ConfigureEmailBody;
    const { site_id, action } = body;

    if (!site_id) {
      return NextResponse.json(
        { success: false, error: 'site_id is required' },
        { status: 400 }
      );
    }
    if (!action) {
      return NextResponse.json(
        { success: false, error: 'action is required' },
        { status: 400 }
      );
    }

    const result = await configureEmailCore(body);
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (error: any) {
    console.error('[configureEmail] Request error:', error);
    return NextResponse.json(
      {
        success: false,
        action: undefined,
        error: error?.message ?? 'Internal server error',
      },
      { status: 500 }
    );
  }
}
