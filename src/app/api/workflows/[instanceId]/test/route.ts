import { NextRequest, NextResponse } from 'next/server';
import { materializeRunFromGraph } from '@/lib/services/workflow-robot/materialize';
import { runWorkflowPlan } from '@/lib/services/workflow-robot/run-plan';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { instanceId } = await params;
    const body = await request.json().catch(() => ({}));
    const materialized = await materializeRunFromGraph({
      instance_id: instanceId,
      trigger_payload: body.payload || { test: true },
      dry_run: true,
    });
    const result = await runWorkflowPlan(materialized.run_plan_id);
    return NextResponse.json({ success: true, dry_run: true, ...materialized, ...result });
  } catch (error: any) {
    console.error('[WorkflowTest]', error);
    return NextResponse.json({ success: false, error: error.message || 'Test failed' }, { status: 500 });
  }
}
