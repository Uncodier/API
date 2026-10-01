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
  const headers: Record<string, string> = {};
  try {
    const params = await context.params;
    const { searchParams } = new URL(request.url);
    const tenantId = searchParams.get('tenant_id');
    const rawNetwork = searchParams.get('network');
    const network = rawNetwork
      ? (resolveOutstandNetwork(rawNetwork) || rawNetwork)
      : undefined;
    const username = searchParams.get('username') || undefined;
    const resolveAuthorNamesValues = searchParams.getAll('resolve_author_names');
    const rawResolveAuthorNames = resolveAuthorNamesValues[0];
    if (resolveAuthorNamesValues.length > 1 || (rawResolveAuthorNames !== undefined
      && rawResolveAuthorNames !== 'true' && rawResolveAuthorNames !== 'false')) {
      return NextResponse.json({ error: 'resolve_author_names must be true or false' }, { status: 400 });
    }
    const resolveAuthorNames = rawResolveAuthorNames === undefined ? undefined : rawResolveAuthorNames === 'true';
    if (resolveAuthorNames === true) headers['Cache-Control'] = 'private, no-store';

    const client = getOutstandClient();
    const result = await client.getComments(params.id, {
      network, username, resolve_author_names: resolveAuthorNames,
    }, tenantId || undefined);
    return NextResponse.json(result, { headers });
  } catch (error: any) {
    const status = error.status || 500;
    return NextResponse.json({
      error: error.message,
      upstream_status: error.upstreamStatus,
    }, { status, headers });
  }
}
