import type { OutstandClient } from './client';
import { resolveOutstandNetwork } from './social-networks';

export interface ConnectedSocialAccount {
  id: string;
  network: string;
  username: string;
  isActive: boolean;
}

export type SocialAccountResolutionErrorCode =
  | 'INVALID_SITE_ID'
  | 'INVALID_ACCOUNT_SELECTORS'
  | 'ACCOUNT_PROVIDER_ERROR'
  | 'INVALID_ACCOUNT_RESPONSE'
  | 'ACCOUNT_SCOPE_MISMATCH'
  | 'ACCOUNT_PAGINATION_LIMIT'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_AMBIGUOUS';

export class SocialAccountResolutionError extends Error {
  constructor(public readonly code: SocialAccountResolutionErrorCode, message: string) {
    super(message);
    this.name = 'SocialAccountResolutionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type AccountClient = Pick<OutstandClient, 'listAccounts'>;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalNetwork(value: string): string {
  const normalized = value.trim().toLowerCase();
  const network = resolveOutstandNetwork(normalized);
  // Preserve newly supported provider networks; inherited lookup keys are not aliases.
  return typeof network === 'string' ? network : normalized;
}

function invalidResponse(): never {
  throw new SocialAccountResolutionError(
    'INVALID_ACCOUNT_RESPONSE',
    'Outstand returned incomplete or invalid account data. Retry account discovery before publishing.',
  );
}

function normalizeAccount(row: unknown, siteId: string): ConnectedSocialAccount {
  if (!isRecord(row)) invalidResponse();
  if (row.tenant_id !== siteId || ('tenantId' in row && row.tenantId !== siteId)) {
    throw new SocialAccountResolutionError(
      'ACCOUNT_SCOPE_MISMATCH',
      'Outstand returned accounts outside the authorized site scope. No accounts were selected.',
    );
  }
  if (!nonemptyString(row.id) || !nonemptyString(row.username) || !nonemptyString(row.network)) {
    invalidResponse();
  }
  const network = canonicalNetwork(row.network);
  if (![true, false, 0, 1].includes(row.isActive as boolean | number)) {
    invalidResponse();
  }
  return { id: row.id, network, username: row.username, isActive: row.isActive === true || row.isActive === 1 };
}

function pageNumber(result: Record<string, unknown>, key: string): number | undefined {
  if (!(key in result)) return undefined;
  const value = result[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidResponse();
  return value;
}

/** siteId must come from an authenticated, authorized execution, never tool arguments. */
export async function listConnectedAccounts(client: AccountClient, siteId: string): Promise<ConnectedSocialAccount[]> {
  if (!nonemptyString(siteId) || siteId !== siteId.trim()) {
    throw new SocialAccountResolutionError('INVALID_SITE_ID', 'An authorized site ID is required to load social accounts.');
  }

  const accounts = new Map<string, ConnectedSocialAccount>();
  let offset = 0;
  let expectedTotal: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result: unknown;
    try {
      result = await client.listAccounts(siteId, { tenantId: siteId, limit: PAGE_SIZE, offset });
    } catch {
      throw new SocialAccountResolutionError(
        'ACCOUNT_PROVIDER_ERROR', 'Unable to load social accounts from Outstand. Retry account discovery before publishing.',
      );
    }
    if (!isRecord(result)) invalidResponse();
    if (result.success === false || result.degraded === true || result.error) {
      throw new SocialAccountResolutionError(
        'ACCOUNT_PROVIDER_ERROR', 'Outstand could not load all social accounts. Retry account discovery before publishing.',
      );
    }
    if (result.success !== true) invalidResponse();

    // Canonical data is authoritative, even when empty or malformed.
    const rows = Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : result.accounts;
    if (!Array.isArray(rows)) invalidResponse();
    const total = pageNumber(result, 'total');
    const count = pageNumber(result, 'count');
    const limit = pageNumber(result, 'limit') ?? PAGE_SIZE;
    const responseOffset = pageNumber(result, 'offset') ?? offset;
    if (limit === 0 || limit > PAGE_SIZE || rows.length > limit || responseOffset !== offset
      || (count !== undefined && count !== rows.length)) invalidResponse();
    if (total !== undefined) {
      if (expectedTotal !== undefined && total !== expectedTotal) invalidResponse();
      expectedTotal = total;
    }

    for (const row of rows) {
      const account = normalizeAccount(row, siteId);
      // Repeated IDs can indicate ignored pagination or an unstable provider snapshot.
      if (accounts.has(account.id)) invalidResponse();
      accounts.set(account.id, account);
    }
    offset += rows.length;
    if (expectedTotal !== undefined) {
      if (offset > expectedTotal || (rows.length === 0 && offset < expectedTotal)) invalidResponse();
      if (offset === expectedTotal) return Array.from(accounts.values());
    } else if (rows.length < limit) {
      return Array.from(accounts.values());
    }
  }
  throw new SocialAccountResolutionError(
    'ACCOUNT_PAGINATION_LIMIT', 'Outstand account discovery exceeded its page limit. No accounts were selected; retry or contact support.',
  );
}

export async function resolveSocialAccounts(
  client: AccountClient,
  siteId: string,
  selectors: string[],
): Promise<ConnectedSocialAccount[]> {
  if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > 100
    || !Array.from(selectors).every(nonemptyString)) {
    throw new SocialAccountResolutionError(
      'INVALID_ACCOUNT_SELECTORS', 'Provide between 1 and 100 nonempty social account IDs, usernames, or platform names.',
    );
  }
  const accounts = await listConnectedAccounts(client, siteId);
  const resolved = selectors.map((selector) => {
    // Match each namespace before filtering active accounts: inactive exact matches must not fall through.
    let matches = accounts.filter((account) => account.id === selector);
    if (matches.length === 0) matches = accounts.filter((account) => account.username === selector);
    if (matches.length === 0) {
      const network = canonicalNetwork(selector);
      matches = network ? accounts.filter((account) => account.network === network) : [];
    }
    if (matches.length === 0) {
      throw new SocialAccountResolutionError(
        'ACCOUNT_NOT_FOUND', `No connected social account matches ${JSON.stringify(selector)}. Use social_media_accounts to choose an account ID.`,
      );
    }
    const active = matches.filter((account) => account.isActive);
    if (active.length === 0) {
      throw new SocialAccountResolutionError(
        'ACCOUNT_INACTIVE', `The social account matching ${JSON.stringify(selector)} is inactive. Reconnect it before publishing.`,
      );
    }
    if (active.length > 1) {
      throw new SocialAccountResolutionError(
        'ACCOUNT_AMBIGUOUS', `Multiple active accounts match ${JSON.stringify(selector)}. Use social_media_accounts and select an exact account ID.`,
      );
    }
    return active[0];
  });
  return Array.from(new Map(resolved.map((account) => [account.id, account])).values());
}