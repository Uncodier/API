import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import {
  listAuthorizedOutstandConversations,
  requireOutstandConversationSite,
} from '@/lib/integrations/outstand/conversation-access';
import type {
  ListConversationsParams,
  OutstandConversationStatus,
} from '@/lib/integrations/outstand/types';

const VALID_STATUSES = new Set<OutstandConversationStatus>(['active', 'archived']);

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const siteId = await requireOutstandConversationSite(request);
    const network = searchParams.get('network');
    const status = searchParams.get('status');
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;

    if (network && network !== 'instagram') {
      return NextResponse.json(
        { success: false, error: 'Conversations currently support Instagram only' },
        { status: 400 },
      );
    }
    if (status && !VALID_STATUSES.has(status as OutstandConversationStatus)) {
      return NextResponse.json(
        { success: false, error: 'status must be active or archived' },
        { status: 400 },
      );
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      return NextResponse.json(
        { success: false, error: 'limit must be an integer from 1 to 100' },
        { status: 400 },
      );
    }

    const params: ListConversationsParams = {
      social_account_id: searchParams.get('social_account_id') || undefined,
      network: network as 'instagram' | undefined,
      status: status as OutstandConversationStatus | undefined,
      cursor: searchParams.get('cursor') || undefined,
      limit,
    };
    const result = await listAuthorizedOutstandConversations(
      getOutstandClient(),
      params,
      siteId,
    );
    return NextResponse.json(result);
  } catch (error) {
    const status = (error as Error & { status?: number }).status || 500;
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list conversations',
      },
      { status },
    );
  }
}
