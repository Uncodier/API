import { v5 as uuidv5 } from 'uuid';

export const COMMENT_NETWORKS = ['facebook', 'instagram', 'threads', 'linkedin', 'x', 'youtube'];
export const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
export const networkName = (value: unknown): string => text(value).toLowerCase() === 'twitter' ? 'x' : text(value).toLowerCase();

export class SocialCommentError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function commentMetadata(value: unknown, origin?: string): Record<string, any> | null {
  const data = record(value);
  if (data.source !== 'comment') return null;
  const network = networkName(origin || data.network || data.channel);
  if (!COMMENT_NETWORKS.includes(network) || data.outstand_conversation_id
    || !text(data.publisher_account_id) || !text(data.outstand_post_id)
    || !text(data.platform_comment_id)) {
    throw new SocialCommentError('Comment account, post, network and platform comment identity are required', 400);
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(data.outstand_post_id)) {
    throw new SocialCommentError('Invalid Outstand post ID', 400);
  }
  if ((data.network && networkName(data.network) !== network)
    || (data.channel && networkName(data.channel) !== network)) {
    throw new SocialCommentError('Comment network mismatch', 400);
  }
  const result: Record<string, any> = { source: 'comment', channel: network, network };
  for (const key of ['publisher_account_id', 'publisher_username', 'outstand_post_id',
    'platform_post_id', 'platform_post_url', 'platform_comment_id', 'parent_comment_id',
    'root_comment_id', 'content_id', 'author_id', 'author_identity_status', 'origin_message_id']) {
    if (text(data[key])) result[key] = text(data[key]);
  }
  if (network === 'linkedin') result.author_identity_status = 'resolve_on_read';
  else for (const key of ['author_name', 'author_username', 'social_handle', 'profile_url']) {
    if (text(data[key])) result[key] = text(data[key]);
  }
  return result;
}

export function sameCommentScope(left: Record<string, any>, right: Record<string, any>): boolean {
  return ['source', 'network', 'publisher_account_id', 'outstand_post_id', 'author_id']
    .every(key => (left[key] || undefined) === (right[key] || undefined));
}

export function commentConversationId(siteId: string, data: Record<string, any>): string {
  // An unknown author is isolated to this exact comment, never joined by name/time.
  return uuidv5(JSON.stringify(['social-comment-conversation-v1', siteId, data.network,
    data.publisher_account_id, data.outstand_post_id,
    data.author_id ? ['author', data.author_id] : ['unavailable-author-comment', data.platform_comment_id],
  ]), uuidv5.URL);
}

export function conversationMetadata(data: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {
    source: 'comment', channel: data.network, network: data.network, channel_delivery: true,
    comment_generated_title: data.post_title || 'Social post comments',
    ...(data.author_id ? { comment_grouping_version: 1 } : { comment_grouping_status: 'author_unavailable' }),
  };
  for (const key of ['publisher_account_id', 'publisher_username', 'outstand_post_id', 'author_id',
    'platform_post_id', 'platform_post_url', 'content_id', 'post_title', 'post_text', 'post_image_url']) {
    if (text(data[key])) result[key] = data[key];
  }
  if (data.network !== 'linkedin') for (const key of ['author_name', 'author_username', 'social_handle']) {
    if (text(data[key])) result[key] = data[key];
  }
  return result;
}

export function replyMetadata(data: Record<string, any>, sourceMessageId: string): Record<string, any> {
  return {
    ...conversationMetadata(data), reply_to_message_id: sourceMessageId,
    reply_to_comment_id: data.platform_comment_id,
    ...(data.parent_comment_id ? { parent_comment_id: data.parent_comment_id } : {}),
    ...(data.root_comment_id ? { root_comment_id: data.root_comment_id } : {}),
  };
}

export function safePreviewUrl(value: unknown): string | undefined {
  try {
    const url = new URL(text(value));
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}