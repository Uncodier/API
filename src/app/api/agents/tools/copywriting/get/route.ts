import { NextRequest, NextResponse } from 'next/server';
import { getCopywritings, CopywritingFilters } from '@/lib/database/copywriting-db';

export async function getCopywritingsCore(filters: CopywritingFilters) {
  return getCopywritings(filters);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const site_id = searchParams.get('site_id');
    const user_id = searchParams.get('user_id');
    const copy_type = searchParams.get('copy_type') as any;
    const status = searchParams.get('status') as any;
    const search = searchParams.get('search') || undefined;
    const copywriting_id = searchParams.get('copywriting_id') || undefined;
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : undefined;
    const offset = searchParams.get('offset') ? parseInt(searchParams.get('offset')!) : undefined;

    if (!site_id && !copywriting_id) {
      return NextResponse.json(
        { success: false, error: 'Missing site_id or copywriting_id' },
        { status: 400 }
      );
    }

    const filters: CopywritingFilters = {
      site_id: site_id || undefined,
      user_id: user_id || undefined,
      copy_type,
      status,
      search,
      copywriting_id,
      limit,
      offset,
    };

    const result = await getCopywritingsCore(filters);
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
