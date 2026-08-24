import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { instanceId } = await params;
    const { data, error } = await supabaseAdmin
      .from('workflow_runs')
      .select('id, run_plan_id, template_plan_id, trigger_id, status, dry_run, payload, created_at, updated_at')
      .eq('instance_id', instanceId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true, runs: data || [] });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
