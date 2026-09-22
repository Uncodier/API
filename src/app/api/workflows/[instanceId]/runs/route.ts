import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  readRedisJson,
  writeRedisJson,
} from '@/lib/services/redis-json-cache';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { instanceId } = await params;
    const cacheKey = `cache:workflow-runs:${instanceId}`;
    const cached = await readRedisJson<Record<string, unknown>>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const { data, error } = await supabaseAdmin
      .from('workflow_runs')
      .select('id, run_plan_id, template_plan_id, trigger_id, status, dry_run, payload, created_at, updated_at')
      .eq('instance_id', instanceId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const responseBody = {
      success: true,
      runs: data || [],
      retry_after_ms: 2_000,
    };
    await writeRedisJson(cacheKey, responseBody, 2);
    return NextResponse.json(responseBody);
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
