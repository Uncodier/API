import { z } from 'zod';
import { ConnectorError } from './types';
import { invalidProviderResponse, type ComposioClient } from './composio-transport';
import { inputValue, opaqueCursor, pageSchema, providerId, providerValue, safeText, scopesSchema, toolkitSlug } from './composio-validation';

const accountSchema = z.object({
  id: providerId, toolkit: z.object({ slug: toolkitSlug }),
  auth_config: z.object({ id: providerId, is_disabled: z.boolean() }),
  status: z.string().regex(/^[A-Z_]{1,50}$/), user_id: providerId.optional(), alias: safeText(200).nullish(),
  is_disabled: z.boolean(),
  experimental: z.object({ account_type: z.enum(['PRIVATE', 'SHARED']) }).optional(),
  data: z.object({ base_url: z.unknown().optional() }).nullish(),
  state: z.object({ authScheme: z.string().optional(), val: z.object({ scope: z.unknown().optional(), full: z.unknown().optional() }) }).optional(),
});

function normalizeAccount(data: z.infer<typeof accountSchema>) {
  // scope is provider-granted state, never the auth-config's requested scope ceiling.
  const rawScope = data.state?.val.scope;
  const scopes = rawScope == null ? [] : providerValue(scopesSchema,
    typeof rawScope === 'string' ? rawScope.split(/[\s,]+/).filter(Boolean) : rawScope);
  // Composio may mask state.val.full to "http..." even on exact-account GET.
  // The mask alone proves nothing; require the provider's exact resolved base URL.
  const origin = 'https://api.supabase.com';
  const full = data.state?.val.full, resolved = data.data?.base_url;
  const hosted = (full === origin && (resolved === undefined || resolved === origin))
    || (full === 'http...' && resolved === origin);
  return {
    id: data.id, toolkitSlug: data.toolkit.slug, authConfigId: data.auth_config.id,
    // Project-scoped PAT dispatch requires a positive live origin/scheme proof. Never return the state or URL.
    hostedSupabasePat: data.toolkit.slug === 'supabase' && data.state?.authScheme === 'API_KEY' && hosted,
    // Unreported grants are unknown, not proof of either an empty grant or permission.
    scopesKnown: rawScope != null, oauth2: data.state?.authScheme === 'OAUTH2', apiKeyAuth: data.state?.authScheme === 'API_KEY',
    status: data.status, userId: data.user_id, scopes: [...new Set(scopes)], name: data.alias || undefined,
    authConfigDisabled: data.auth_config.is_disabled, disabled: data.is_disabled, accountType: data.experimental?.account_type,
  };
}

export type ComposioAccount = ReturnType<typeof normalizeAccount>;

export async function getAccount(client: ComposioClient, id: string): Promise<ComposioAccount> {
  inputValue(providerId, id);
  const data = providerValue(accountSchema, await client.request(`/connected_accounts/${id}`));
  if (data.id !== id) invalidProviderResponse();
  return normalizeAccount(data);
}

/** One bounded private-account page only. Never adopts accounts or traverses the project implicitly. */
export async function listAccounts(client: ComposioClient, userId: string, cursor?: string) {
  inputValue(providerId, userId);
  if (cursor !== undefined) inputValue(opaqueCursor, cursor);
  const params = new URLSearchParams({ user_ids: userId, limit: '100' });
  if (cursor) params.set('cursor', cursor);
  const data = providerValue(pageSchema(accountSchema), await client.request(`/connected_accounts?${params}`));
  if (data.items.some(item => (item.user_id !== undefined && item.user_id !== userId) || item.experimental?.account_type === 'SHARED')) {
    invalidProviderResponse();
  }
  return { items: data.items.map(normalizeAccount), next_cursor: data.next_cursor ?? null, total_items: data.total_items ?? null };
}

/** Missing deprecated user_id requires a second provider-filtered exact-account ownership proof. */
export async function verifyAccountIdentity(client: ComposioClient, expected: {
  accountId: string; userId: string; toolkitSlug: string; authConfigId: string;
}): Promise<ComposioAccount> {
  inputValue(z.object({ accountId: providerId, userId: providerId, toolkitSlug, authConfigId: providerId }).strict(), expected);
  const account = await getAccount(client, expected.accountId);
  const matches = (item: ComposioAccount) => item.id === expected.accountId && item.toolkitSlug === expected.toolkitSlug
    && item.authConfigId === expected.authConfigId && item.accountType !== 'SHARED' && !item.authConfigDisabled && !item.disabled;
  if (!matches(account) || (account.userId !== undefined && account.userId !== expected.userId)) identityError();
  if (account.userId === undefined) {
    const params = new URLSearchParams({ user_ids: expected.userId, connected_account_ids: expected.accountId, limit: '1' });
    const data = providerValue(pageSchema(accountSchema, 1), await client.request(`/connected_accounts?${params}`));
    if (data.items.length !== 1 || data.next_cursor) identityError();
    const filtered = normalizeAccount(data.items[0]);
    if (!matches(filtered) || (filtered.userId !== undefined && filtered.userId !== expected.userId)) identityError();
    // The list proves ownership, not absence of grants. A reduced list DTO must not
    // downgrade an explicitly reported scope list to unknown (or erase broader grants).
    if (account.status !== 'ACTIVE') throw new ConnectorError('CONNECTOR_NOT_ACTIVE', 'The connected account is not active.', 409);
    if (account.scopesKnown && filtered.scopesKnown && (account.scopes.length !== filtered.scopes.length ||
      account.scopes.some(scope => !filtered.scopes.includes(scope)))) identityError();
    // Ownership is the only fact this filtered list may supply. Never elevate the
    // exact detail's account type, credential scheme, hosted origin or OAuth grant.
    if (filtered.status !== 'ACTIVE') throw new ConnectorError('CONNECTOR_NOT_ACTIVE', 'The connected account is not active.', 409);
    if (!account.scopesKnown && filtered.scopesKnown) identityError();
  }
  if (account.status !== 'ACTIVE') throw new ConnectorError('CONNECTOR_NOT_ACTIVE', 'The connected account is not active.', 409);
  return account;
}

function identityError(): never {
  throw new ConnectorError('CONNECTOR_ACCOUNT_MISMATCH', 'The provider account identity could not be verified.', 409);
}

const callbackSchema = z.string().max(2048).url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash
    && url.pathname === '/connectors/callback';
});
const linkSchema = z.object({ connected_account_id: providerId, redirect_url: z.string().max(4096).url(), expires_at: z.string().datetime({ offset: true }) });

/** Caller has already bound actor/nonce/credential revision in a durable pending attempt. */
export async function createAuthLink(client: ComposioClient, options: { authConfigId: string; userId: string; callbackUrl: string }) {
  const input = inputValue(z.object({ authConfigId: providerId, userId: providerId, callbackUrl: callbackSchema }).strict(), options);
  const data = providerValue(linkSchema, await client.request('/connected_accounts/link', { method: 'POST', body: {
    auth_config_id: input.authConfigId, user_id: input.userId, callback_url: input.callbackUrl,
  } }), true);
  const redirect = new URL(data.redirect_url);
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.port || redirect.hash
    || !['connect.composio.dev', 'backend.composio.dev'].includes(redirect.hostname)
    || Date.parse(data.expires_at) <= Date.now()) invalidProviderResponse(true);
  // link_token and other provider fields deliberately never escape this module.
  return { accountId: data.connected_account_id, redirectUrl: redirect.toString(), expiresAt: data.expires_at };
}

/** session_uri is an opaque single-use proof, not a URL to fetch or a claim to decode. */
export async function completeAuth(client: ComposioClient, options: { sessionUri: string; userId: string }) {
  const input = inputValue(z.object({ sessionUri: safeText(4096).min(1), userId: providerId }).strict(), options);
  const data = providerValue(z.object({ connected_account_id: providerId, toolkit_slug: toolkitSlug }),
    await client.request('/connected_accounts/complete_auth', { method: 'POST', body: { session_uri: input.sessionUri, user_id: input.userId } }), true);
  // Caller must compare the exact pending account/toolkit and atomically finalize.
  return { accountId: data.connected_account_id, toolkitSlug: data.toolkit_slug };
}

/** Best-effort upstream revocation; never substitutes delete or claims an async job completed. */
export async function revokeAccount(client: ComposioClient, id: string): Promise<{ id: string; status: 'REVOKED' }> {
  inputValue(providerId, id);
  const data = providerValue(z.object({
    revoked_tokens: z.array(z.enum(['access_token', 'refresh_token', 'credential'])).max(3),
    connected_account: z.object({ id: providerId, status: z.literal('REVOKED') }),
  }), await client.request(`/connected_accounts/${id}/revoke`, { method: 'POST' }), true);
  if (data.connected_account.id !== id) invalidProviderResponse(true);
  return data.connected_account;
}