/** Outstand webhook payloads (https://www.outstand.so/docs/webhooks) */

export type OutstandWebhookEventName =
  | 'post.published'
  | 'post.error'
  | 'account.token_expired'
  | 'test';

export interface OutstandWebhookPostPublishedData {
  postId: string;
  orgId: string;
  socialAccounts: Array<{
    accountId: string;
    network: string;
    username: string;
    platformPostId: string;
  }>;
}

export interface OutstandWebhookPostErrorData {
  postId: string;
  orgId: string;
  socialAccounts: Array<{
    accountId: string;
    network: string;
    username: string;
    error: string;
  }>;
}

export interface OutstandWebhookAccountTokenExpiredData {
  orgId: string;
  accountId: number;
  network: string;
  username: string;
  error: string;
}

export interface OutstandWebhookTestData {
  message: string;
  endpointId: number;
}

export type OutstandWebhookPayload =
  | {
      event: 'post.published';
      timestamp: string;
      data: OutstandWebhookPostPublishedData;
    }
  | {
      event: 'post.error';
      timestamp: string;
      data: OutstandWebhookPostErrorData;
    }
  | {
      event: 'account.token_expired';
      timestamp: string;
      data: OutstandWebhookAccountTokenExpiredData;
    }
  | {
      event: 'test';
      timestamp: string;
      data: OutstandWebhookTestData;
    };
