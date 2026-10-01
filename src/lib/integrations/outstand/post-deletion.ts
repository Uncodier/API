import type { OutstandClient } from './client';
import { isNonemptyString, isObject, OutstandPostError } from './post-errors';
import { canonicalNetwork, type OwnedPost, type ProviderAccount } from './post-ownership';

const REMOTE_NETWORKS = new Set([
  'x', 'linkedin', 'facebook', 'threads', 'youtube', 'pinterest', 'google_business', 'vimeo', 'reddit', 'bluesky',
]);

function uncertain(): never {
  throw new OutstandPostError(409,
    'Remote publication or deletion is uncertain. Keep local content and verify the post in Outstand before retrying.');
}

/** Explicit per-account deleted state is the only already-deleted proof we accept. */
export function accountsRequiringDeletion(post: OwnedPost): ProviderAccount[] {
  const published: ProviderAccount[] = [];
  const identities = new Set<string>();
  let pending = false;
  let deleted = false;
  for (const account of post.socialAccounts) {
    const identity = JSON.stringify([account.network, account.username]);
    if (identities.has(identity)) uncertain();
    identities.add(identity);
    switch (account.status) {
      case 'deleted':
        deleted = true;
        break;
      case 'published':
        if (!isNonemptyString(account.platformPostId)) uncertain();
        if (!REMOTE_NETWORKS.has(account.network)) {
          throw new OutstandPostError(409,
            'Remote deletion is unsupported for a published account. Keep local content and remove the post on the platform manually.');
        }
        published.push(account);
        break;
      case 'pending':
      case 'failed':
        // The provider documents explicit nulls here; omitted fields are not absence proof.
        if (account.platformPostId !== null || account.publishedAt !== null) uncertain();
        pending ||= account.status === 'pending';
        break;
      default:
        uncertain();
    }
  }
  if (pending) {
    // Do not race an immediate/in-progress publish or a schedule due within this request's deadline.
    const safelyScheduled = typeof post.scheduledAt === 'string'
      && Date.parse(post.scheduledAt) > Date.now() + 75_000;
    if (published.length || deleted || post.publishedAt !== null || (post.isDraft !== true && !safelyScheduled)) uncertain();
  }
  if (!published.length && !deleted && post.publishedAt !== null) uncertain();
  return published;
}

export function confirmRemoteResults(response: unknown, published: ProviderAccount[], all: ProviderAccount[]) {
  const invalid = () => new OutstandPostError(502,
    'Outstand returned incomplete remote deletion confirmation. Keep local content and inspect the post before retrying.');
  if (!isObject(response) || typeof response.success !== 'boolean' || response.degraded === true || response.error != null
    || !Array.isArray(response.results) || response.results.length === 0 || response.results.length > all.length) {
    throw invalid();
  }
  const confirmed = new Set<string>();
  for (const result of response.results) {
    if (!isObject(result) || !isNonemptyString(result.network) || !isNonemptyString(result.username)
      || (result.platform_post_id !== null && !isNonemptyString(result.platform_post_id))
      || (result.status !== 'deleted' && result.status !== 'failed')
      || (result.error !== null && typeof result.error !== 'string')) throw invalid();
    const account = all.find((item) => item.network === canonicalNetwork(result.network as string)
      && item.username === result.username);
    if (!account || confirmed.has(account.id)) throw invalid();
    if (result.status === 'failed') {
      throw new OutstandPostError(409,
        'Remote deletion failed for one or more accounts. The Outstand record was kept; verify each platform before retrying.');
    }
    if (result.error !== null || (account.status !== 'published' && account.status !== 'deleted')
      || (account.platformPostId != null && account.platformPostId !== result.platform_post_id)) throw invalid();
    confirmed.add(account.id);
  }
  if (response.success !== true || published.some((account) => !confirmed.has(account.id))) throw invalid();
}

export async function deleteOwnedPost(client: OutstandClient, post: OwnedPost, siteId: string, remote: boolean) {
  if (remote) {
    const published = accountsRequiringDeletion(post);
    if (published.length) {
      let response: unknown;
      try {
        response = await client.deleteRemotePost(post.id, siteId);
      } catch {
        throw new OutstandPostError(502,
          'Remote deletion could not be confirmed. The Outstand record was kept; inspect the post before retrying.');
      }
      confirmRemoteResults(response, published, post.socialAccounts);
    }
  }
  let result: unknown;
  try {
    result = await client.deletePost(post.id, siteId);
  } catch {
    throw new OutstandPostError(502,
      'Outstand record deletion could not be confirmed. Keep local content and inspect the post before retrying.');
  }
  if (!isObject(result) || result.success !== true || !isNonemptyString(result.message)
    || result.degraded === true || ('results' in result) || result.error != null) {
    throw new OutstandPostError(502, 'Outstand did not confirm record deletion. Keep local content and contact support.');
  }
  return { success: true, post_id: post.id, delete_remote: remote };
}