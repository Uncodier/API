import { NextRequest, NextResponse } from 'next/server';
import { syncWorkflowDefinition } from '@/lib/services/workflow-robot/materialize';
import { authorizeWorkflowInstanceWrite } from '@/lib/services/workflow-robot/route-access';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { instanceId } = await params;
    const denied = await authorizeWorkflowInstanceWrite(request, instanceId);
    if (denied) return denied;
    const result = await syncWorkflowDefinition(instanceId);
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[WorkflowSyncTriggers]', error);
    return NextResponse.json(
      { success: false, error: 'Failed to sync triggers' },
      { status: 500 },
    );
  }
}
