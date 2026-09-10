import { NextRequest, NextResponse } from 'next/server';
import { listSiteSecretsCore, type ListSiteSecretsParams } from './core';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const site_id = searchParams.get('site_id');
    const instance_id = searchParams.get('instance_id');
    const provider = searchParams.get('provider');
    const use_case = searchParams.get('use_case');

    if (!site_id) {
      return NextResponse.json(
        { success: false, error: 'site_id is required' },
        { status: 400 }
      );
    }

    const params: ListSiteSecretsParams = {};
    if (provider) params.provider = provider;
    if (use_case) params.use_case = use_case;

    const result = await listSiteSecretsCore(site_id, instance_id, params);
    
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (error: any) {
    console.error('[ListSiteSecrets] ❌ Error processing request:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
