import {
  canAccessSite,
  getRequestSitePrincipal,
} from '@/lib/security/site-access';
import type { OutstandClient } from './client';
import type {
  GetConversationResponse,
  ListConversationsParams,
  ListConversationsResponse,
} from './types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface OutstandAccount {
  id?: string;
  tenant_id?: string;
}

export class OutstandConversationAccessError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'OutstandConversationAccessError';
  }
}

export async function requireOutstandConversationSite(
  request: Request,
): Promise<string> {
  const { searchParams } = new URL(request.url);
  const requestedSiteId =
    searchParams.get('tenant_id')
    || searchParams.get('tenantId')
    || searchParams.get('site_id')
    || searchParams.get('siteId');
  const principal = getRequestSitePrincipal(request);
  const siteId = requestedSiteId || principal.siteId;

  if (!siteId || !UUID_PATTERN.test(siteId)) {
    throw new OutstandConversationAccessError(
      'A valid tenant_id is required',
      400,
    );
  }
  if (principal.siteId && principal.siteId !== siteId) {
    throw new OutstandConversationAccessError(
      'You do not have access to this site',
      403,
    );
  }
  if (!await canAccessSite(request, siteId)) {
    throw new OutstandConversationAccessError(
      'You do not have access to this site',
      403,
    );
  }
  return siteId;
}

export async function listOutstandInstagramAccountIds(
  client: OutstandClient,
  siteId: string,
): Promise<Set<string>> {
  const accountIds = new Set<string>();
  const limit = 100;

  for (let offset = 0; ; offset += limit) {
    const response = await client.listAccounts(siteId, {
      tenantId: siteId,
      network: 'instagram',
      limit,
      offset,
    });
    const accounts: OutstandAccount[] = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.accounts)
        ? response.accounts
        : [];

    for (const account of accounts) {
      if (account.tenant_id === siteId && account.id) {
        accountIds.add(account.id);
      }
    }

    const total = typeof response?.total === 'number'
      ? response.total
      : accounts.length;
    if (
      accounts.length === 0
      || accounts.length < limit
      || offset + accounts.length >= total
    ) {
      break;
    }
  }

  return accountIds;
}

export async function authorizeOutstandConversation(
  client: OutstandClient,
  conversationId: string,
  siteId: string,
): Promise<GetConversationResponse> {
  const conversation = await client.getConversation(conversationId);
  const accountIds = await listOutstandInstagramAccountIds(client, siteId);
  if (!accountIds.has(conversation.conversation.socialAccountId)) {
    throw new OutstandConversationAccessError('Conversation not found', 404);
  }
  return conversation;
}

export async function listAuthorizedOutstandConversations(
  client: OutstandClient,
  params: ListConversationsParams,
  siteId: string,
): Promise<ListConversationsResponse> {
  const accountIds = await listOutstandInstagramAccountIds(client, siteId);
  if (params.social_account_id) {
    if (!accountIds.has(params.social_account_id)) {
      throw new OutstandConversationAccessError('Social account not found', 404);
    }
    return client.listConversations(params);
  }
  if (accountIds.size === 0) {
    return {
      success: true,
      data: [],
      pagination: {
        hasMore: false,
        nextCursor: null,
        limit: params.limit || 25,
      },
    };
  }

  const response = await client.listConversations(params);
  return {
    ...response,
    data: response.data.filter((conversation) => (
      accountIds.has(conversation.socialAccountId)
    )),
  };
}
