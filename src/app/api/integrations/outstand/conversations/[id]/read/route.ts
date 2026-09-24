import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import {
  authorizeOutstandConversation,
  requireOutstandConversationSite,
} from '@/lib/integrations/outstand/conversation-access';
import { markLocalOutstandConversationRead } from '@/lib/integrations/outstand/inbox-sync';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const siteId = await requireOutstandConversationSite(request);
    const client = getOutstandClient();
    const conversation = await authorizeOutstandConversation(client, id, siteId);
    const result = await client.markConversationRead(id);
    try {
      await markLocalOutstandConversationRead(
        {
          ...conversation.conversation,
          unreadCount: result.unreadCount,
        },
        siteId,
      );
    } catch (syncError) {
      console.error('[Outstand conversations] Read receipt sent but local sync failed:', syncError);
    }
    return NextResponse.json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status || 500;
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to mark conversation as read',
      },
      { status },
    );
  }
}
