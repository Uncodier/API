import { requireLicensedSocialAccounts, ResourceLicenseError } from '@/lib/billing/licensed-resources';
import { resolveSocialAccounts } from './accounts';
import { resolveOutstandNetwork } from './social-networks';
import type { OutstandClient } from './client';
import type { CreateCommentParams } from './types';

/** Execution only: discovery/history can still display suspended connections. */
export async function authorizePostLicense(client: OutstandClient, siteId: string | undefined, selectors: string[]) {
  if (!siteId) throw new ResourceLicenseError();
  const accounts = await resolveSocialAccounts(client, siteId, selectors);
  await requireLicensedSocialAccounts(siteId, accounts.map(account => account.id));
}

export async function authorizeCommentLicense(client: OutstandClient, siteId: string | undefined,
  postId: string, params: CreateCommentParams) {
  if (!siteId || !params.network || !params.account_username) throw new ResourceLicenseError();
  const network = resolveOutstandNetwork(params.network);
  const { post } = await client.getPost(postId, siteId);
  const matches = post?.socialAccounts?.filter(account => account.username === params.account_username
    && typeof account.network === 'string' && resolveOutstandNetwork(account.network) === network);
  if (!matches || matches.length !== 1 || !matches[0].id) throw new ResourceLicenseError();
  await requireLicensedSocialAccounts(siteId, [matches[0].id]);
}

export async function authorizeConversationLicense(client: OutstandClient, siteId: string | undefined, conversationId: string) {
  if (!siteId) throw new ResourceLicenseError();
  const { conversation } = await client.getConversation(conversationId);
  await requireLicensedSocialAccounts(siteId, [conversation?.socialAccountId]);
}