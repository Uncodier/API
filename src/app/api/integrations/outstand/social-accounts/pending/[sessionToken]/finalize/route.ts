import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionToken: string }> }
) {
  try {
    const { sessionToken } = await context.params;
    const body = await request.json().catch(() => ({}));
    const selectedPageIds = body.selectedPageIds || body.accountIds;

    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Missing session token' }, { status: 400 });
    }
    if (!Array.isArray(selectedPageIds) || selectedPageIds.length === 0) {
      return NextResponse.json({ success: false, error: 'At least one account ID must be provided' }, { status: 400 });
    }

    const client = getOutstandClient();
    const result = await client.finalizePendingSocialAccounts(sessionToken, selectedPageIds);
    return NextResponse.json({
      success: true,
      data: result?.data || result,
    });
  } catch (error: any) {
    console.error('[Outstand finalize] error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to finalize connection' },
      { status: 500 }
    );
  }
}
