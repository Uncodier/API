import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { resolveOutstandNetwork } from '@/lib/integrations/outstand/social-networks';

export async function POST(
  request: Request,
  context: { params: Promise<{ network: string }> }
) {
  try {
    const { network } = await context.params;
    const outstandNetwork = resolveOutstandNetwork(network);
    if (!outstandNetwork) {
      return NextResponse.json(
        { success: false, error: `Invalid network type: ${network}` },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { searchParams } = new URL(request.url);
    const tenantId = searchParams.get('siteId') || searchParams.get('tenant_id') || body.tenant_id || body.siteId;
    const redirectUri = body.redirect_uri;

    const client = getOutstandClient();
    const result = await client.getSocialAuthUrl(outstandNetwork, {
      redirect_uri: redirectUri,
      tenant_id: tenantId || undefined,
    });

    return NextResponse.json({
      success: true,
      data: {
        auth_url: result?.data?.auth_url,
      },
    });
  } catch (error: any) {
    console.error('[Outstand auth-url] error:', error);
    const message = error instanceof Error ? error.message : 'Failed to get auth URL';
    const status = message.includes('OUTSTAND_API_KEY') ? 500 : 502;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
