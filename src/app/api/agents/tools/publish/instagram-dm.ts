import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { authorizeOutstandConversation } from '@/lib/integrations/outstand/conversation-access';
import { recordOutstandMessage } from '@/lib/integrations/outstand/inbox-sync';

export interface InstagramDirectMessageParams {
  conversation_id: string;
  media_urls?: string[];
  scheduled_at?: string;
}

export function validateInstagramDirectMessage(
  params: InstagramDirectMessageParams | undefined,
  text: string | undefined,
  assetIds: string[] | undefined,
  urls: string[] | undefined,
): string | null {
  if (!params) return null;
  if (!params.conversation_id?.trim()) {
    return 'instagram_dm.conversation_id is required.';
  }

  const mediaUrls = params.media_urls || [];
  if (mediaUrls.some((url) => typeof url !== 'string' || !/^https:\/\//i.test(url))) {
    return 'instagram_dm.media_urls must contain public HTTPS URLs.';
  }
  const hasTextUrl = urls?.some((url) => typeof url === 'string' && url.trim());
  if (
    !text?.trim()
    && !hasTextUrl
    && mediaUrls.length === 0
    && (!assetIds || assetIds.length === 0)
  ) {
    return 'An Instagram DM requires text, urls, instagram_dm.media_urls, or uploaded assets.';
  }
  if (params.scheduled_at) {
    const scheduledTime = Date.parse(params.scheduled_at);
    if (!Number.isFinite(scheduledTime) || scheduledTime <= Date.now()) {
      return 'instagram_dm.scheduled_at must be a future ISO 8601 timestamp.';
    }
  }

  return null;
}

export async function publishInstagramDirectMessage(input: {
  siteId: string;
  text?: string;
  assetIds?: string[];
  params: InstagramDirectMessageParams;
}) {
  const client = getOutstandClient();
  const conversation = await authorizeOutstandConversation(
    client,
    input.params.conversation_id,
    input.siteId,
  );
  const uploadedMediaUrls = await Promise.all(
    (input.assetIds || []).map(async (assetId) => {
      const media = await client.getMedia(assetId, input.siteId);
      const url = media?.data?.url || media?.url;
      if (typeof url !== 'string' || !url) {
        throw new Error(`Outstand media ${assetId} does not have a public URL`);
      }
      return url;
    }),
  );
  const mediaUrls = Array.from(new Set([
    ...(input.params.media_urls || []),
    ...uploadedMediaUrls,
  ]));

  const result = await client.sendConversationMessage(
    input.params.conversation_id,
    {
      ...(input.text?.trim() ? { content: input.text } : {}),
      ...(mediaUrls.length > 0 ? { media_urls: mediaUrls } : {}),
      ...(input.params.scheduled_at
        ? { scheduled_at: input.params.scheduled_at }
        : {}),
    },
  );

  try {
    await recordOutstandMessage(result.message, conversation.conversation, input.siteId);
  } catch (error) {
    console.error('[publish] Outstand DM accepted but local inbox sync failed:', error);
  }

  return result;
}
