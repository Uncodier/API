import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionToken: string }> }
) {
  try {
    const { sessionToken } = await context.params;
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Missing session token' }, { status: 400 });
    }

    const client = getOutstandClient();
    const result = await client.getPendingSocialAccounts(sessionToken);
    return NextResponse.json({
      success: true,
      data: result?.data || result,
    });
  } catch (error: any) {
    console.error('[Outstand pending accounts] error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to get pending accounts' },
      { status: 500 }
    );
  }
}
