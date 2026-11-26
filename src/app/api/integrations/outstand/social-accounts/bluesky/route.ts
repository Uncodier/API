import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { isInternalServiceRequest } from '@/lib/security/request-rate-limit';

export async function POST(request: Request) {
  if (!isInternalServiceRequest(request)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }
  try {
    const body = await request.json().catch(() => null);
    const handle = typeof body?.handle === 'string' ? body.handle.trim() : '';
    const appPassword = body?.app_password;
    const tenantId = body?.siteId || body?.tenant_id;

    if (!handle || handle.length > 253 || typeof appPassword !== 'string' || !appPassword || appPassword.length > 128
      || typeof tenantId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(tenantId)) {
      return NextResponse.json(
        { success: false, error: 'Missing handle, app_password, or siteId' },
        { status: 400 }
      );
    }

    const client = getOutstandClient(AbortSignal.timeout(15_000));
    const result = await client.connectBlueskyAccount(
      { handle, app_password: appPassword },
      tenantId
    );

    const account = result?.data;
    if (result?.success !== true || !account || typeof account.id !== 'string' || !account.id || account.network !== 'bluesky'
      || (account.tenant_id != null && account.tenant_id !== tenantId)) {
      return NextResponse.json({ success: false, error: 'Invalid Bluesky connection response' }, { status: 502 });
    }
    const { id, network, username, nickname, accountType, orgId, profile_picture_url, network_unique_id, customer_social_network_id, createdAt } = account;
    return NextResponse.json({ success: true, data: {
      id, network, username, nickname, accountType, orgId, profile_picture_url, network_unique_id, customer_social_network_id, createdAt,
    } });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Could not connect Bluesky. Check your handle and app password.' },
      { status: 502 }
    );
  }
}
