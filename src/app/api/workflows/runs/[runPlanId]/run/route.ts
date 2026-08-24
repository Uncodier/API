import { NextRequest, NextResponse } from 'next/server';
import { runWorkflowPlan } from '@/lib/services/workflow-robot/run-plan';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ runPlanId: string }> },
) {
  try {
    const { runPlanId } = await params;
    const result = await runWorkflowPlan(runPlanId);
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
