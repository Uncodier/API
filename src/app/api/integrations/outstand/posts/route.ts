import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const client = getOutstandClient();
    const result = await client.createPost(body);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const params: any = {};
    searchParams.forEach((value, key) => {
      params[key] = value;
    });

    const client = getOutstandClient();
    const result = await client.listPosts(params);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
