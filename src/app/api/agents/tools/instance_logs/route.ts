import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function createInstanceLogCore(params: {
  site_id: string;
  instance_id?: string;
  user_id?: string;
  log_type: string;
  level: string;
  message: string;
  details?: Record<string, any>;
}) {
  const { site_id, instance_id, user_id, log_type, level, message, details } = params;

  if (!site_id || !log_type || !level || !message) {
    throw new Error('site_id, log_type, level, and message are required');
  }

  const { data, error } = await supabaseAdmin
    .from('instance_logs')
    .insert([
      {
        site_id,
        instance_id: instance_id || null,
        user_id: user_id || null,
        log_type,
        level,
        message,
        details: details || null,
        created_at: new Date().toISOString(),
      }
    ])
    .select()
    .single();

  if (error) {
    throw new Error(`Error inserting instance log: ${error.message}`);
  }

  return { success: true, data };
}

export async function listInstanceLogsCore(params: {
  site_id: string;
  instance_id?: string;
  user_id?: string;
  log_type?: string;
  level?: string;
  limit?: number;
  offset?: number;
}) {
  const { site_id, instance_id, user_id, log_type, level, limit = 50, offset = 0 } = params;

  let query = supabaseAdmin.from('instance_logs').select('*');

  if (site_id) {
    query = query.eq('site_id', site_id);
  }
  if (instance_id) {
    query = query.eq('instance_id', instance_id);
  }
  if (user_id) {
    query = query.eq('user_id', user_id);
  }
  if (log_type) {
    query = query.eq('log_type', log_type);
  }
  if (level) {
    query = query.eq('level', level);
  }

  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, error } = await query;

  if (error) {
    throw new Error(`Error getting instance logs: ${error.message}`);
  }

  return { success: true, data };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createInstanceLogCore(body);
    return NextResponse.json(result, { status: 201 });
  } catch (error: any) {
    console.error('Error in instance_logs tool (POST):', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: error.message.includes('are required') ? 400 : 500 }
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
      offset
    });
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error getting instance_logs:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
