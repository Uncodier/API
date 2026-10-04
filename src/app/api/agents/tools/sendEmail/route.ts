import { NextRequest, NextResponse } from 'next/server';
import { sendEmailCore } from './core';

/**
 * HTTP endpoint for sending emails from agent
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await sendEmailCore(body);

    if (!result.success && result.error) {
      const status = result.error.code === 'INVALID_REQUEST' ? 400
        : result.error.code === 'SITE_CONFIG_NOT_FOUND' ? 404
        : 500;
      return NextResponse.json({ success: false, error: result.error }, { status });
    }

    const status = result.status === 'skipped' ? 200 : 201;
    return NextResponse.json(result, { status });
  } catch (error: any) {
    console.error(`[SEND_EMAIL] Critical error:`, error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: error.message } },
      { status: 500 }
    );
  }
}