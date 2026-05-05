import { NextResponse } from 'next/server';
import { getMessagesCore } from './core';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversation_id');
    const siteId = url.searchParams.get('site_id');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const debug = url.searchParams.get('debug') === 'true';

    if (!siteId) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required' } },
        { status: 400 }
      );
    }

    const result = await getMessagesCore({
      site_id: siteId,
      conversation_id: conversationId ?? undefined,
      lead_id: url.searchParams.get('lead_id') ?? undefined,
      role: url.searchParams.get('role') ?? undefined,
      interaction: url.searchParams.get('interaction') ?? undefined,
      custom_data_status: url.searchParams.get('custom_data_status') ?? undefined,
      limit,
      offset
    });

    return NextResponse.json({
      ...result,
      debug: debug ? { query_params: { conversationId, siteId }, mode: conversationId ? 'conversation' : 'site_wide' } : undefined
    });
  } catch (err: any) {
    const message = err?.message ?? 'An error occurred while processing the request';
    const code = message.startsWith('INVALID_REQUEST') ? 400 : message.startsWith('NOT_FOUND') ? 404 : message.startsWith('DATABASE_ERROR') ? 500 : 500;
    return NextResponse.json(
      { success: false, error: { code: message.split(':')[0] || 'INTERNAL_SERVER_ERROR', message: message.replace(/^[A-Z_]+:\s*/, '') } },
      { status: code }
    );
  }
}
