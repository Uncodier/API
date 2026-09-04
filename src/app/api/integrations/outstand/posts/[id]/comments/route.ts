import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { resolveOutstandNetwork } from '@/lib/integrations/outstand/social-networks';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { searchParams } = new URL(request.url);
    const tenantId = searchParams.get('tenant_id');
    const params = await context.params;
    const body = await request.json();
    
    const client = getOutstandClient();
    const result = await client.publishComment(params.id, body, tenantId || undefined);
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error.status || 500;
    return NextResponse.json({
      error: error.message,
      upstream_status: error.upstreamStatus,
    }, { status });
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = await context.params;
    const { searchParams } = new URL(request.url);
    const tenantId = searchParams.get('tenant_id');
    const rawNetwork = searchParams.get('network');
    const network = rawNetwork
      ? (resolveOutstandNetwork(rawNetwork) || rawNetwork)
      : undefined;
    const username = searchParams.get('username') || undefined;

    const client = getOutstandClient();
    const result = await client.getComments(params.id, { network, username }, tenantId || undefined);
    return NextResponse.json(result);
  } catch (error: any) {
    const status = error.status || 500;
    return NextResponse.json({
      error: error.message,
      upstream_status: error.upstreamStatus,
    }, { status });
  }
}
