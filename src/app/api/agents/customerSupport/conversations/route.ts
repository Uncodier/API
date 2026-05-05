import { NextResponse } from 'next/server';
import { getConversationsCore } from './core';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const leadId = url.searchParams.get('lead_id');
    const visitorId = url.searchParams.get('visitor_id');
    const userId = url.searchParams.get('user_id');
    const siteId = url.searchParams.get('site_id');
    const agentId = url.searchParams.get('agent_id');
    const limit = parseInt(url.searchParams.get('limit') || '10');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const debug = url.searchParams.get('debug') === 'true';

    const result = await getConversationsCore({
      lead_id: leadId ?? undefined,
      visitor_id: visitorId ?? undefined,
      user_id: userId ?? undefined,
      site_id: siteId ?? undefined,
      agent_id: agentId ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      channel: url.searchParams.get('channel') ?? undefined,
      custom_data_status: url.searchParams.get('custom_data_status') ?? undefined,
      limit,
      offset
    });

    return NextResponse.json({
      ...result,
      debug: debug ? { query_params: { leadId, visitorId, userId, siteId, agentId } } : undefined
    });
  } catch (err: any) {
    const message = err?.message ?? 'An error occurred while processing the request';
    const code = message.startsWith('INVALID_REQUEST') ? 400 : message.startsWith('DATABASE_ERROR') ? 500 : 500;
    return NextResponse.json(
      { success: false, error: { code: message.split(':')[0] || 'INTERNAL_SERVER_ERROR', message: message.replace(/^[A-Z_]+:\s*/, '') } },
      { status: code }
    );
  }
}
