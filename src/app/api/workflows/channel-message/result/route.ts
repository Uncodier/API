import { NextResponse } from 'next/server';
import { getCompletedChannelMessageGuidance } from '@/lib/services/workflow-robot/channel-message';
import { readChannelMessageBody, requireChannelMessageService, validChannel,
  validChannelMessageId, validChannelMessageIdentity } from '../request';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const denied = requireChannelMessageService(request);
  if (denied) return denied;
  const body = await readChannelMessageBody(request);
  if (!body || !validChannelMessageIdentity(body) || !validChannel(body.channel) ||
    !Array.isArray(body.runPlanIds) || body.runPlanIds.length > 10 ||
    body.runPlanIds.some((id) => !validChannelMessageId(id))) {
    return NextResponse.json({ success: false, error: 'Invalid channel message result' }, { status: 400 });
  }
  try {
    const guidance = await getCompletedChannelMessageGuidance({
      siteId: body.siteId as string, messageId: body.messageId as string,
      channel: body.channel, runPlanIds: body.runPlanIds,
    });
    return NextResponse.json({ success: true, data: { guidance } });
  } catch (error) {
    console.error('[ChannelMessageWorkflow] Guidance retrieval failed:', error);
    return NextResponse.json({ success: false, error: 'Unable to read channel message result' }, { status: 500 });
  }
}