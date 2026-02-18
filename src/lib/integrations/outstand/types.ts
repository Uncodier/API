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
  platform_post_id?: string;
  account_username?: string;
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
