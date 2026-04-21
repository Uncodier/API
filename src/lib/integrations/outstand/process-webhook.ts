import type { OutstandWebhookPayload } from './webhook-types';

/**
 * Handles verified Outstand webhook events. Keep side effects async-friendly
 * (respond 2xx quickly; queue heavy work elsewhere if needed).
 */
export async function processOutstandWebhookPayload(
  payload: OutstandWebhookPayload
): Promise<void> {
  switch (payload.event) {
    case 'post.published':
      console.log('[Outstand webhook] post.published', {
        postId: payload.data.postId,
        orgId: payload.data.orgId,
        accounts: payload.data.socialAccounts?.length ?? 0,
        timestamp: payload.timestamp,
      });
      break;
    case 'post.error':
      console.log('[Outstand webhook] post.error', {
        postId: payload.data.postId,
        orgId: payload.data.orgId,
        errors: payload.data.socialAccounts?.map((a) => ({
          network: a.network,
          username: a.username,
          error: a.error,
        })),
        timestamp: payload.timestamp,
      });
      break;
    case 'account.token_expired':
      console.log('[Outstand webhook] account.token_expired', {
        orgId: payload.data.orgId,
        accountId: payload.data.accountId,
        network: payload.data.network,
        username: payload.data.username,
        error: payload.data.error,
        timestamp: payload.timestamp,
      });
      break;
    case 'test':
      console.log('[Outstand webhook] test', {
        message: payload.data.message,
        endpointId: payload.data.endpointId,
        timestamp: payload.timestamp,
      });
      break;
  }
}
