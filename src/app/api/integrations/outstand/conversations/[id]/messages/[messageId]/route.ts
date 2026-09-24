import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import {
  authorizeOutstandConversation,
  requireOutstandConversationSite,
} from '@/lib/integrations/outstand/conversation-access';
import { deleteLocalOutstandMessage } from '@/lib/integrations/outstand/inbox-sync';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const { id, messageId } = await context.params;
    const siteId = await requireOutstandConversationSite(request);
    const client = getOutstandClient();
    const conversation = await authorizeOutstandConversation(client, id, siteId);
    const result = await client.cancelScheduledConversationMessage(
      id,
      messageId,
    );
    try {
      await deleteLocalOutstandMessage(
        conversation.conversation,
        messageId,
        siteId,
      );
    } catch (syncError) {
      console.error('[Outstand conversations] Message cancelled but local sync failed:', syncError);
    }
    return NextResponse.json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status || 500;
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel scheduled message',
      },
      { status },
    );
  }
}
