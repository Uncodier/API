import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const body = await request.json();
    const tenantId = searchParams.get('tenant_id') || body.tenant_id;
    
    // Remove tenant_id from body before sending to Outstand if it exists
    if (body.tenant_id) {
      delete body.tenant_id;
    }
    
    console.log('[Outstand API Payload]', JSON.stringify(body, null, 2));
    
    const client = getOutstandClient();
    const result = await client.createPost(body, tenantId || undefined);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[Outstand API Error]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tenantId = searchParams.get('tenant_id');
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
