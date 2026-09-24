export interface OutstandPost {
  id: string;
  orgId: string;
  publishedAt: string | null;
  scheduledAt: string | null;
  isDraft: boolean;
  createdAt: string;
  socialAccounts: OutstandSocialAccount[];
  containers: OutstandContainer[];
}

export interface OutstandSocialAccount {
  id?: string;
  nickname?: string;
  network?: string;
  username?: string;
  status?: string;
  error?: any;
  platformPostId?: string;
  publishedAt?: string;
}

export interface OutstandContainer {
  id?: string;
  content: string;
  media?: OutstandMediaItem[];
}

export interface OutstandMediaItem {
  id?: string | number;
  url: string;
  filename: string;
}

export interface CreatePostParams {
  content?: string; // Either content or containers
  containers?: {
    content: string;
    media?: { id: string }[];
  }[];
  accounts: string[]; // references by network name or username
  scheduledAt?: string; // ISO 8601
  threads?: any;
  instagram?: any;
  youtube?: any;
  tiktok?: any;
  tenant_id?: string; // Optional tenant ID from payload
}

export interface ListPostsParams {
  social_account_id?: string;
  created_after?: string;
  created_before?: string;
  scheduled_after?: string;
  scheduled_before?: string;
  limit?: number;
  offset?: number;
}

export interface PostAnalytics {
  post: {
    id: string;
    publishedAt: string;
    createdAt: string;
  };
  metrics_by_account: {
    social_account: {
      id: string;
      nickname: string;
      network: string;
      username: string;
    };
    platform_post_id: string;
    published_at: string;
    metrics: {
      likes: number;
      comments: number;
      shares: number;
      views: number;
      impressions: number;
      reach: number;
      engagement_rate: number;
      platform_specific: any;
    };
  }[];
  aggregated_metrics: {
    total_likes: number;
    total_comments: number;
    total_shares: number;
    total_views: number;
    total_impressions: number;
    total_reach: number;
    average_engagement_rate: number;
  };
}

export interface CreateCommentParams {
  content: string;
  network?: string;
  platform_post_id?: string;
  account_username?: string;
  parent_comment_id?: string;
}

export interface CommentResponse {
  success: boolean;
  reply_id: string;
}

export interface UploadUrlResponse {
  success: boolean;
  data: {
    id: string;
    upload_url: string;
    expires_in: number;
  };
}

export interface ConfirmUploadResponse {
  success: boolean;
  data: {
    id: string;
    filename: string;
    url: string;
    content_type: string;
    size: number;
    status: string;
    created_at: string;
    expires_at: string;
  };
}

export interface OutstandError {
  success: false;
  error: string;
  details?: any;
  message?: string;
}

export type OutstandConversationStatus = 'active' | 'archived';
export type OutstandMessageDirection = 'inbound' | 'outbound';
export type OutstandMessageStatus =
  | 'received'
  | 'pending'
  | 'sent'
  | 'read'
  | 'failed';

export interface OutstandConversation {
  id: string;
  orgId: string;
  socialAccountId: string;
  network: 'instagram';
  platformConversationId: string;
  participantId: string;
  participantDisplayName: string | null;
  participantProfilePicture: string | null;
  lastMessageAt: string;
  lastInboundAt: string;
  unreadCount: number;
  status: OutstandConversationStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OutstandConversationMessage {
  id: string;
  conversationId: string;
  platformMessageId: string | null;
  direction: OutstandMessageDirection;
  senderId: string | null;
  content: string | null;
  mediaUrls: string[];
  status: OutstandMessageStatus;
  error: string | null;
  scheduledAt: string | null;
  platformSentAt: string | null;
  createdAt: string;
}

export interface CursorPagination {
  hasMore: boolean;
  nextCursor: string | number | null;
  limit: number;
}

export interface ListConversationsParams {
  social_account_id?: string;
  network?: 'instagram';
  status?: OutstandConversationStatus;
  cursor?: string | number;
  limit?: number;
}

export interface ListConversationMessagesParams {
  direction?: OutstandMessageDirection;
  cursor?: string | number;
  limit?: number;
}

export interface SendConversationMessageParams {
  content?: string;
  media_urls?: string[];
  scheduled_at?: string;
}

export interface ListConversationsResponse {
  success: boolean;
  data: OutstandConversation[];
  pagination: CursorPagination;
}

export interface GetConversationResponse {
  success: boolean;
  conversation: OutstandConversation;
}

export interface ListConversationMessagesResponse {
  success: boolean;
  data: OutstandConversationMessage[];
  pagination: CursorPagination;
}

export interface SendConversationMessageResponse {
  success: boolean;
  message: OutstandConversationMessage;
}
