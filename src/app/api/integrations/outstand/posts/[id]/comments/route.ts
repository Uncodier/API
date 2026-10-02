import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { resolveOutstandNetwork } from '@/lib/integrations/outstand/social-networks';
import { getOwnedPost } from '@/lib/integrations/outstand/post-ownership';
import { canAccessSite } from '@/lib/security/site-access';

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
    let network = rawNetwork
      ? (resolveOutstandNetwork(rawNetwork) || rawNetwork)
      : undefined;
    let username = searchParams.get('username') || undefined;
    const accountIds = searchParams.getAll('account_id');
    const accountId = accountIds[0];
    if (accountIds.length > 1 || (accountId !== undefined && (!accountId.trim() || accountId.length > 512 || !tenantId))) {
      return NextResponse.json({ error: 'A single account_id and tenant_id are required for scoped comments' }, { status: 400 });
    }
    const resolveAuthorNamesValues = searchParams.getAll('resolve_author_names');
    const rawResolveAuthorNames = resolveAuthorNamesValues[0];
    if (resolveAuthorNamesValues.length > 1 || (rawResolveAuthorNames !== undefined
      && rawResolveAuthorNames !== 'true' && rawResolveAuthorNames !== 'false')) {
      return NextResponse.json({ error: 'resolve_author_names must be true or false' }, { status: 400 });
    }
    const resolveAuthorNames = rawResolveAuthorNames === undefined ? undefined : rawResolveAuthorNames === 'true';
    if (resolveAuthorNames === true) headers['Cache-Control'] = 'private, no-store';

    const client = getOutstandClient();
    if (accountId) {
      headers['Cache-Control'] = 'private, no-store';
      if (!await canAccessSite(request, tenantId!)) {
        return NextResponse.json({ error: 'Site access denied' }, { status: 403, headers });
      }
      const post = await getOwnedPost(client, params.id, tenantId!);
      const account = post.socialAccounts.find(value => value.id === accountId);
      if (!account || (network && account.network !== network) || (username && username !== account.username)) {
        return NextResponse.json({ error: 'Comment account does not match this post and network' }, { status: 403, headers });
      }
      // Outstand selects comments by network + username. Do not use that selector
      // unless it uniquely identifies the explicitly authorized account.
      if (post.socialAccounts.filter(value => value.network === account.network && value.username === account.username).length !== 1) {
        return NextResponse.json({ error: 'Comment account selector is ambiguous' }, { status: 409, headers });
      }
      network = account.network;
      username = account.username;
    }
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
