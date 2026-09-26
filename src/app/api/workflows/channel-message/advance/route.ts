import { NextResponse } from 'next/server';
import { advanceBoundedChannelMessageRun } from '@/lib/services/workflow-robot/bounded-channel-execution';
import { readChannelMessageBody, requireChannelMessageService,
  validChannelMessageId, validChannelMessageIdentity } from '../request';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const denied = requireChannelMessageService(request);
  if (denied) return denied;
  const body = await readChannelMessageBody(request);
  if (!body || !validChannelMessageIdentity(body) || !validChannelMessageId(body.runPlanId)) {
    return NextResponse.json({ success: false, error: 'Invalid channel message run' }, { status: 400 });
  }
  try {
    const status = await advanceBoundedChannelMessageRun({
      siteId: body.siteId as string, messageId: body.messageId as string, runPlanId: body.runPlanId,
    });
    if (status === 'forbidden') {
      return NextResponse.json({ success: false, error: 'Channel message run is not accessible' }, { status: 403 });
    }
    return NextResponse.json({ success: true, data: { status } });
  } catch (error) {
    console.error('[ChannelMessageWorkflow] Advance failed:', error);
    return NextResponse.json({ success: false, error: 'Unable to advance channel message run' }, { status: 500 });
  }
}