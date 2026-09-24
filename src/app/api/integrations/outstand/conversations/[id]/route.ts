import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import {
  authorizeOutstandConversation,
  requireOutstandConversationSite,
} from '@/lib/integrations/outstand/conversation-access';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Conversation ID is required' },
        { status: 400 },
      );
    }

    const siteId = await requireOutstandConversationSite(request);
    const result = await authorizeOutstandConversation(
      getOutstandClient(),
      id,
      siteId,
    );
    return NextResponse.json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status || 500;
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get conversation',
      },
      { status },
    );
  }
}
