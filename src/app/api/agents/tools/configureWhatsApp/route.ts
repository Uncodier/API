import { NextRequest, NextResponse } from 'next/server';
import { configureWhatsAppCore, ConfigureWhatsAppBody, ConfigureWhatsAppResult } from './core';

/**
 * POST /api/agents/tools/configureWhatsApp
 * Body: { site_id, action, ...params }
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ConfigureWhatsAppBody;
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

    const result = await configureWhatsAppCore(body);
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (error: unknown) {
    console.error('[configureWhatsApp] Request error:', error);
    const result: ConfigureWhatsAppResult = {
      success: false,
      action: 'get_config',
      error: error instanceof Error ? error.message : 'Internal server error',
    };
    return NextResponse.json(result, { status: 500 });
  }
}
