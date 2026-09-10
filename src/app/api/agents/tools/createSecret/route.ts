import { NextRequest, NextResponse } from 'next/server';
import { createSecretCore } from './core';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { site_id, instance_id, ...params } = body;

    if (!site_id) {
      return NextResponse.json(
        { success: false, error: 'site_id is required' },
        { status: 400 }
      );
    }

    const result = await createSecretCore(site_id, instance_id || null, params);
    
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (error: any) {
    console.error('[CreateSecret] ❌ Error processing request:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Internal server error'
      },
      { status: 500 }
    );
  }
}
