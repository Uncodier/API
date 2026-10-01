import { listConnectedAccounts } from './accounts';
import type { OutstandClient } from './client';
import { isNonemptyString, isObject, OutstandPostError, upstreamStatus } from './post-errors';

export type ProviderAccount = Record<string, unknown> & { id: string; network: string; username: string };
export type OwnedPost = Record<string, unknown> & { id: string; socialAccounts: ProviderAccount[] };

function assertTenantMetadata(value: Record<string, unknown>, siteId: string) {
  if (['tenant_id', 'tenantId', 'site_id', 'siteId'].some((key) => key in value && value[key] !== siteId)) {
    throw new OutstandPostError(403, 'The post is not accessible for this site.');
  }
}

export function canonicalNetwork(network: string): string {
  const value = network.toLowerCase();
  return value === 'twitter' ? 'x' : value;
}

export async function getOwnedPost(client: OutstandClient, id: string, siteId: string): Promise<OwnedPost> {
  let response: unknown;
  try {
    response = await client.getPost(id, siteId);
  } catch (error) {
    if (upstreamStatus(error) === 404) {
      // A local tag or org-wide provider 404 cannot prove tenant ownership or remote absence.
      throw new OutstandPostError(409,
        'The Outstand record is unavailable and ownership cannot be verified. Keep local content and contact support to verify remote deletion.');
    }
    throw new OutstandPostError(502, 'Unable to verify the Outstand post. No deletion was confirmed.');
  }
  if (!isObject(response) || response.success !== true || response.degraded === true || response.error != null
    || !isObject(response.post) || response.post.id !== id) {
    throw new OutstandPostError(502, 'Outstand returned an invalid post. No deletion was confirmed.');
  }
  const post = response.post;
  assertTenantMetadata(response, siteId);
  assertTenantMetadata(post, siteId);
  if (!Array.isArray(post.socialAccounts) || post.socialAccounts.length === 0 || post.socialAccounts.length > 100) {
    throw new OutstandPostError(409, 'Post account ownership cannot be verified. Keep local content and contact support.');
  }
  let inventory;
  try {
    inventory = await listConnectedAccounts({
      listAccounts: async (...args) => {
        const result = await client.listAccounts(...args);
        if (isObject(result)) {
          assertTenantMetadata(result, siteId);
          const rows = 'data' in result ? result.data : result.accounts;
          if (Array.isArray(rows)) rows.forEach((row) => {
            if (isObject(row)) assertTenantMetadata(row, siteId);
          });
        }
        return result;
      },
    }, siteId);
  } catch {
    throw new OutstandPostError(502, 'Unable to verify site account ownership. No deletion was confirmed.');
  }
  const ids = new Set<string>();
  const accounts = post.socialAccounts.map((row: unknown) => {
    if (!isObject(row) || !isNonemptyString(row.id) || !isNonemptyString(row.network)
      || !isNonemptyString(row.username) || ids.has(row.id)) {
      throw new OutstandPostError(502, 'Outstand returned invalid post accounts. No deletion was confirmed.');
    }
    ids.add(row.id);
    assertTenantMetadata(row, siteId);
    const account = inventory.find((candidate) => candidate.id === row.id);
    if (!account || account.network !== canonicalNetwork(row.network) || account.username !== row.username) {
      throw new OutstandPostError(403, 'The post is not accessible for this site.');
    }
    return { ...row, id: row.id, username: row.username, network: account.network };
  });
  return { ...post, id, socialAccounts: accounts };
}