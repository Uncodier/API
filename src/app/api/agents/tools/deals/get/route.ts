import { NextRequest, NextResponse } from 'next/server';
import { getDealsCore } from './core';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const site_id = searchParams.get('site_id') || undefined;
    const deal_id = searchParams.get('deal_id') || undefined;
    const stage = searchParams.get('stage') || undefined;
    const status = searchParams.get('status') || undefined;
    const limitParam = searchParams.get('limit');
    const offsetParam = searchParams.get('offset');

    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    const offset = offsetParam ? parseInt(offsetParam, 10) : undefined;

    const result = await getDealsCore({
      site_id,
      deal_id,
      stage,
      status,
      limit,
      offset,
    });

    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}