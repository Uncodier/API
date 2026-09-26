import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';
import { canAccessSite } from '@/lib/security/site-access';
import {
  readRedisJson,
  writeRedisJson,
} from '@/lib/services/redis-json-cache';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { instanceId } = await params;
    if (!hasAuthenticatedPrincipal(request)) {
      return NextResponse.json({ error: 'Authentication is required' }, { status: 401 });
    }
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(instanceId)) {
      return NextResponse.json({ error: 'Invalid workflow instance' }, { status: 400 });
    }
    const { data: instance, error: instanceError } = await supabaseAdmin.from('remote_instances')
      .select('site_id').eq('id', instanceId).maybeSingle();
    if (instanceError) throw instanceError;
    if (!instance || !await canAccessSite(request, instance.site_id)) {
      return NextResponse.json({ error: 'Workflow is not accessible' }, { status: 403 });
    }
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
