import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const client = getOutstandClient();
    const result = await client.getPostAnalytics(params.id);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
