import { NextRequest, NextResponse } from 'next/server';
import { integrationApiRequestCore, type IntegrationApiRequestParams } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { site_id, instance_id, ...params } = body;

    if (!site_id || !params.secret_id || !params.url || !params.method) {
      return NextResponse.json(
        { success: false, error: 'site_id, secret_id, url, and method are required' },
        { status: 400 }
      );
    }

    const result = await integrationApiRequestCore(site_id, instance_id || null, params as IntegrationApiRequestParams);
    
    const status = result.status || (result.success ? 200 : 400);
    return NextResponse.json(result, { status });
  } catch (error: any) {
    console.error('[IntegrationApiRequest] ❌ Error processing request:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
