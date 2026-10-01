import { isObject } from './post-errors';
import type { OwnedPost } from './post-ownership';

const text = (value: unknown) => typeof value === 'string' ? value : null;

/** Exclude provider internals, credentials, and raw platform error details from GET. */
export function publicPost(post: OwnedPost) {
  return {
    id: post.id,
    publishedAt: text(post.publishedAt),
    scheduledAt: text(post.scheduledAt),
    createdAt: text(post.createdAt),
    isDraft: post.isDraft === true,
    socialAccounts: post.socialAccounts.map((account) => ({
      id: account.id,
      nickname: text(account.nickname),
      network: account.network,
      username: account.username,
      status: typeof account.status === 'string' && ['pending', 'published', 'failed', 'deleted'].includes(account.status)
        ? account.status : 'unknown',
      platformPostId: text(account.platformPostId),
      platformPostUrl: text(account.platformPostUrl),
      publishedAt: text(account.publishedAt),
      error: account.error == null ? null : 'The platform reported an error. Check Outstand for details.',
    })),
    containers: Array.isArray(post.containers) ? post.containers.filter(isObject).map((container) => ({
      id: text(container.id),
      content: text(container.content),
      media: Array.isArray(container.media) ? container.media.filter(isObject).map((media) => ({
        url: text(media.url), filename: text(media.filename),
      })) : [],
    })) : [],
  };
}