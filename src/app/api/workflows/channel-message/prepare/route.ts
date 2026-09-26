import { NextResponse } from 'next/server';
import { prepareChannelMessageRuns } from '@/lib/services/workflow-robot/channel-message';
import { readChannelMessageBody, requireChannelMessageService, validChannel,
  validChannelMessageIdentity } from '../request';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const denied = requireChannelMessageService(request);
  if (denied) return denied;
  const body = await readChannelMessageBody(request);
  if (!body || !validChannelMessageIdentity(body) || !validChannel(body.channel) ||
    typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000 ||
    (body.conversationId !== undefined &&
      (typeof body.conversationId !== 'string' || body.conversationId.length > 256))) {
    return NextResponse.json({ success: false, error: 'Invalid channel message' }, { status: 400 });
  }
  try {
    const runs = await prepareChannelMessageRuns({
      siteId: body.siteId as string, messageId: body.messageId as string,
      channel: body.channel, message: body.message, conversationId: body.conversationId as string | undefined,
    });
    return NextResponse.json({ success: true, data: { runs } });
  } catch (error) {
    console.error('[ChannelMessageWorkflow] Preparation failed:', error);
    return NextResponse.json({ success: false, error: 'Unable to prepare channel message runs' }, { status: 500 });
  }
}