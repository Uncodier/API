/** Outstand webhook payloads (https://www.outstand.so/docs/webhooks) */

export type OutstandWebhookEventName =
  | 'post.published'
  | 'post.error'
  | 'account.token_expired'
  | 'conversation.started'
  | 'message.received'
  | 'message.sent'
  | 'message.failed'
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

interface OutstandConversationEventData {
  conversationId: string;
  orgId: string;
  network: 'instagram';
}

export interface OutstandWebhookConversationStartedData
  extends OutstandConversationEventData {
  participantId: string;
}

export interface OutstandWebhookMessageReceivedData
  extends OutstandConversationEventData {
  messageId: string;
  content: string | null;
  senderId: string;
  sentAt: string;
}

export interface OutstandWebhookMessageSentData
  extends OutstandConversationEventData {
  messageId: string;
  platformMessageId: string;
}

export interface OutstandWebhookMessageFailedData
  extends OutstandConversationEventData {
  messageId: string;
  error: string;
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
      event: 'conversation.started';
      timestamp: string;
      data: OutstandWebhookConversationStartedData;
    }
  | {
      event: 'message.received';
      timestamp: string;
      data: OutstandWebhookMessageReceivedData;
    }
  | {
      event: 'message.sent';
      timestamp: string;
      data: OutstandWebhookMessageSentData;
    }
  | {
      event: 'message.failed';
      timestamp: string;
      data: OutstandWebhookMessageFailedData;
    }
  | {
      event: 'test';
      timestamp: string;
      data: OutstandWebhookTestData;
    };
