import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const client = getOutstandClient();
    
    // Check if it's upload init or confirm
    // This route handles upload init
    if (!body.filename) {
        return NextResponse.json({ error: 'Filename required' }, { status: 400 });
    }
    
    const result = await client.getUploadUrl(body.filename, body.content_type);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get('limit')) || 50;
    const offset = Number(searchParams.get('offset')) || 0;
    
    const client = getOutstandClient();
    const result = await client.listMedia(limit, offset);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
