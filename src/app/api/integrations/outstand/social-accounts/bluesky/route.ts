import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const handle = body.handle;
    const appPassword = body.app_password;
    const tenantId = body.siteId || body.tenant_id;

    if (!handle || !appPassword || !tenantId) {
      return NextResponse.json(
        { success: false, error: 'Missing handle, app_password, or siteId' },
        { status: 400 }
      );
    }

    const client = getOutstandClient();
    const result = await client.connectBlueskyAccount(
      { handle, app_password: appPassword },
      tenantId
    );

    return NextResponse.json({ success: true, data: result?.data || result });
  } catch (error: any) {
    console.error('[Outstand bluesky] error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to connect Bluesky account' },
      { status: 500 }
    );
  }
}
