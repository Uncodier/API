import { NextRequest, NextResponse } from 'next/server';
import { runWorkflowPlan } from '@/lib/services/workflow-robot/run-plan';
import { authorizeWorkflowRunWrite } from '@/lib/services/workflow-robot/route-access';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runPlanId: string }> },
) {
  try {
    const { runPlanId } = await params;
    const denied = await authorizeWorkflowRunWrite(request, runPlanId);
    if (denied) return denied;
    const result = await runWorkflowPlan(runPlanId);
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[WorkflowRunResume]', error);
    return NextResponse.json({ success: false, error: 'Failed to run workflow' }, { status: 500 });
  }
}
