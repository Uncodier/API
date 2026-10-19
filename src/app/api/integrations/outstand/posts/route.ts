import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { canAccessSite, getRequestSitePrincipal } from '@/lib/security/site-access';

async function requireSite(request: Request, requestedSite: unknown): Promise<string> {
  const principal = getRequestSitePrincipal(request);
  const siteId = requestedSite || principal.siteId;
  if (typeof siteId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(siteId)) {
    throw Object.assign(new Error('A valid tenant_id is required.'), { status: 400 });
  }
  if ((principal.siteId && principal.siteId !== siteId) || !await canAccessSite(request, siteId)) {
    throw Object.assign(new Error('Site access denied.'), { status: 403 });
  }
  return siteId;
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.accounts)
      || !body.accounts.length || body.accounts.length > 20 || body.accounts.some((id: unknown) => typeof id !== 'string' || !id)) {
      return NextResponse.json({ error: 'Valid account selectors are required.' }, { status: 400 });
    }
    const tenantId = await requireSite(request, searchParams.get('tenant_id') || body.tenant_id);
    
    // Remove tenant_id from body before sending to Outstand if it exists
    if (body.tenant_id) {
      delete body.tenant_id;
    }
    
    const client = getOutstandClient();
    const result = await client.createPost(body, tenantId || undefined);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[Outstand API Error]', error);
    const status = error.status || 500;
    return NextResponse.json({ error: error.message }, { status });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tenantId = await requireSite(request, searchParams.get('tenant_id'));
    const params: any = {};
    searchParams.forEach((value, key) => {
      if (key !== 'tenant_id') {
        params[key] = value;
      }
    });

    const client = getOutstandClient();
    const result = await client.listPosts(params, tenantId || undefined);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[Outstand API Error]', error);
    const status = error.status || 500;
    return NextResponse.json({ error: error.message }, { status });
  }
}
