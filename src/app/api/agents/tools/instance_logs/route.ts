import { NextRequest, NextResponse } from 'next/server';
import {
  createInstanceLogCore,
  listInstanceLogsCore,
  type CreateInstanceLogParams,
} from '@/lib/tools/instance-log-core';

export type { CreateInstanceLogParams };
export { createInstanceLogCore, listInstanceLogsCore };

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createInstanceLogCore(body);
    return NextResponse.json(result, { status: 201 });
  } catch (error: any) {
    console.error('Error in instance_logs tool (POST):', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: error.message.includes('are required') ? 400 : 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const site_id = url.searchParams.get('site_id');
    const instance_id = url.searchParams.get('instance_id');
    const user_id = url.searchParams.get('user_id');
    const log_type = url.searchParams.get('log_type');
    const level = url.searchParams.get('level');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');

    if (!site_id) {
      return NextResponse.json({ success: false, error: 'site_id is required' }, { status: 400 });
    }

    const result = await listInstanceLogsCore({
      site_id,
      instance_id: instance_id || undefined,
      user_id: user_id || undefined,
      log_type: log_type || undefined,
      level: level || undefined,
      limit,
      offset,
    });
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error getting instance_logs:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 },
    );
  }
}
