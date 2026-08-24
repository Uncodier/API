import { NextRequest, NextResponse } from 'next/server';
import { syncWorkflowDefinition } from '@/lib/services/workflow-robot/materialize';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { instanceId } = await params;
    const result = await syncWorkflowDefinition(instanceId);
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[WorkflowSyncTriggers]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to sync triggers' },
      { status: 500 },
    );
  }
}
