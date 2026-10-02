import { getOutstandClient } from '@/lib/integrations/outstand/client';
import { getOwnedPost } from '@/lib/integrations/outstand/post-ownership';
import { networkName, SocialCommentError, text } from './metadata';

/** Called only after the caller has authorized site access. Never trust a username as ownership proof. */
export async function authorizeCommentAccount(siteId: string, data: Record<string, any>) {
  const client = getOutstandClient();
  let post;
  try { post = await getOwnedPost(client, data.outstand_post_id, siteId); } catch {
    throw new SocialCommentError('Unable to verify comment post ownership', 503);
  }
  const account = post.socialAccounts.find(row => row.id === data.publisher_account_id
    && networkName(row.network) === data.network);
  if (!account || !text(account.username)) throw new SocialCommentError('Comment publishing account mismatch', 403);
  const platformPostId = text(account.platformPostId) || text(account.platform_post_id);
  if (data.platform_post_id && platformPostId !== data.platform_post_id) {
    throw new SocialCommentError('Comment platform post mismatch', 403);
  }
  return { client, username: account.username, platformPostId };
}