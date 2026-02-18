import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = await request.json();
    const client = getOutstandClient();
    const result = await client.confirmUpload(params.id, body.size);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
