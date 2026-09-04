import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tenantId = searchParams.get('tenant_id') || searchParams.get('tenantId') || undefined;
    const network = searchParams.get('network') || undefined;
    const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 100;

    const client = getOutstandClient();
    const result = await client.listAccounts(tenantId, {
      tenantId,
      network,
      limit,
    });

    const accounts = Array.isArray(result?.data) ? result.data : (result?.accounts || []);
    return NextResponse.json({ success: true, data: accounts, accounts });
  } catch (error: any) {
    console.error('[Outstand social-accounts] error:', error);
    const status = error.status || 500;
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to list accounts' },
      { status }
    );
  }
}
