import { NextResponse } from 'next/server';
import { getOutstandClient } from '@/lib/integrations/outstand/client';
import {
  authorizeOutstandConversation,
  requireOutstandConversationSite,
} from '@/lib/integrations/outstand/conversation-access';
import { recordOutstandMessage } from '@/lib/integrations/outstand/inbox-sync';
import type {
  ListConversationMessagesParams,
  OutstandMessageDirection,
  SendConversationMessageParams,
} from '@/lib/integrations/outstand/types';

const VALID_DIRECTIONS = new Set<OutstandMessageDirection>(['inbound', 'outbound']);

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const direction = searchParams.get('direction');
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;

    if (direction && !VALID_DIRECTIONS.has(direction as OutstandMessageDirection)) {
      return NextResponse.json(
        { success: false, error: 'direction must be inbound or outbound' },
        { status: 400 },
      );
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      return NextResponse.json(
        { success: false, error: 'limit must be an integer from 1 to 200' },
        { status: 400 },
      );
    }

    const params: ListConversationMessagesParams = {
      direction: direction as OutstandMessageDirection | undefined,
      cursor: searchParams.get('cursor') || undefined,
      limit,
    };
    const client = getOutstandClient();
    const siteId = await requireOutstandConversationSite(request);
    await authorizeOutstandConversation(client, id, siteId);
    const result = await client.listConversationMessages(
      id,
      params,
    );
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, 'Failed to list conversation messages');
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const content = typeof body.content === 'string' && body.content.trim()
      ? body.content
      : undefined;
    const mediaUrls = Array.isArray(body.media_urls) ? body.media_urls : undefined;

    if (mediaUrls?.some((url: unknown) => typeof url !== 'string' || !url.trim())) {
      return NextResponse.json(
        { success: false, error: 'media_urls must contain non-empty strings' },
        { status: 400 },
      );
    }
    if (!content && (!mediaUrls || mediaUrls.length === 0)) {
      return NextResponse.json(
        { success: false, error: 'content or media_urls is required' },
        { status: 400 },
      );
    }
    if (
      body.scheduled_at !== undefined
      && (
        typeof body.scheduled_at !== 'string'
        || !Number.isFinite(Date.parse(body.scheduled_at))
        || Date.parse(body.scheduled_at) <= Date.now()
      )
    ) {
      return NextResponse.json(
        { success: false, error: 'scheduled_at must be a future ISO 8601 timestamp' },
        { status: 400 },
      );
    }

    const params: SendConversationMessageParams = {
      content,
      media_urls: mediaUrls,
      scheduled_at: body.scheduled_at,
    };
    const client = getOutstandClient();
    const siteId = await requireOutstandConversationSite(request);
    const conversation = await authorizeOutstandConversation(client, id, siteId);
    const result = await client.sendConversationMessage(
      id,
      params,
    );
    try {
      await recordOutstandMessage(
        result.message,
        conversation.conversation,
        siteId,
      );
    } catch (syncError) {
      console.error('[Outstand conversations] Message accepted but local sync failed:', syncError);
    }
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return errorResponse(error, 'Failed to send conversation message');
  }
}

function errorResponse(error: unknown, fallback: string) {
  const status = (error as Error & { status?: number }).status || 500;
  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : fallback },
    { status },
  );
}
