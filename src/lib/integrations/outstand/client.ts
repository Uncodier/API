import { 
  CreatePostParams, 
  ListPostsParams, 
  OutstandPost, 
  PostAnalytics, 
  CreateCommentParams, 
  CommentResponse, 
  UploadUrlResponse, 
  ConfirmUploadResponse 
} from './types';
import { mergeCommentResults, networksFromPost, usernameFromPost } from './comments';

const BASE_URL = 'https://api.outstand.so/v1';

export class OutstandClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${BASE_URL}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...(options.headers as Record<string, string> | undefined),
    };
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, { ...options, headers });
    
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const details = typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody);
      const error = new Error(
        `Outstand API Error: ${response.status} ${response.statusText} - ${details}`
      ) as Error & { status?: number; upstreamStatus?: number };
      error.upstreamStatus = response.status;
      error.status = response.status >= 500 ? 502 : response.status;
      throw error;
    }

    const text = await response.text();
    if (!text) return {} as T;
    
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      return text as unknown as T;
    }
  }

  // --- Posts ---

  async createPost(params: CreatePostParams, tenantId?: string): Promise<{ success: boolean; post: OutstandPost }> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request('/posts/', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
  }

  async listPosts(params: ListPostsParams = {}, tenantId?: string): Promise<{ success: boolean; posts: OutstandPost[]; pagination: any }> {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) query.append(key, String(value));
    });
    
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    const qs = query.toString();
    const endpoint = qs ? `/posts?${qs}` : '/posts';

    return this.request(endpoint, {
      method: 'GET',
      headers,
    });
  }

  async getPost(id: string, tenantId?: string): Promise<{ success: boolean; post: OutstandPost }> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }
    
    return this.request(`/posts/${id}`, {
      method: 'GET',
      headers,
    });
  }

  async getPostAnalytics(id: string, tenantId?: string): Promise<PostAnalytics> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request(`/posts/${id}/analytics`, {
      method: 'GET',
      headers,
    });
  }

  async deletePost(id: string, tenantId?: string): Promise<{ success: boolean; message: string }> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request(`/posts/${id}`, {
      method: 'DELETE',
      headers,
    });
  }

  // --- Accounts ---

  async listAccounts(
    tenantId?: string,
    params: { network?: string; tenantId?: string; limit?: number } = {}
  ): Promise<any> {
    const query = new URLSearchParams();
    const resolvedTenant = params.tenantId || tenantId;
    if (resolvedTenant) query.append('tenantId', resolvedTenant);
    if (params.network) query.append('network', params.network);
    if (params.limit) query.append('limit', String(params.limit));

    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    const qs = query.toString();
    return this.request(`/social-accounts${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers,
    });
  }

  async getSocialAuthUrl(
    network: string,
    params: { redirect_uri?: string; tenant_id?: string } = {}
  ): Promise<{ success: boolean; data?: { auth_url?: string } }> {
    const body: Record<string, unknown> = {};
    if (params.redirect_uri) body.redirect_uri = params.redirect_uri;
    if (params.tenant_id) body.tenant_id = params.tenant_id;

    return this.request(`/social-networks/${network}/auth-url`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getPendingSocialAccounts(sessionToken: string): Promise<any> {
    return this.request(`/social-accounts/pending/${sessionToken}`, {
      method: 'GET',
    });
  }

  async finalizePendingSocialAccounts(sessionToken: string, accountIds: string[]): Promise<any> {
    return this.request(`/social-accounts/pending/${sessionToken}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ accountIds }),
    });
  }

  async connectBlueskyAccount(
    params: { handle: string; app_password: string },
    tenantId?: string
  ): Promise<any> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request('/social-accounts/bluesky', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
  }

  // --- Comments ---

  async publishComment(postId: string, params: CreateCommentParams, tenantId?: string): Promise<CommentResponse> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request(`/posts/${postId}/replies`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
  }

  async getComments(postId: string, params: { network?: string; username?: string } = {}, tenantId?: string): Promise<any> {
    const post = (!params.network || !params.username)
      ? (await this.getPost(postId, tenantId))?.post
      : undefined;

    const networks = params.network ? [params.network] : networksFromPost(post);
    if (networks.length === 0) {
      const error = new Error('Unable to resolve network for this post. Pass ?network=') as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const username = params.username || usernameFromPost(post, networks[0]);
    const results = await Promise.all(
      networks.map((network) => this.fetchComments(postId, {
        network,
        username: usernameFromPost(post, network) || username,
      }, tenantId))
    );

    return results.length === 1 ? results[0] : mergeCommentResults(results);
  }

  private async fetchComments(
    postId: string,
    params: { network: string; username?: string },
    tenantId?: string
  ): Promise<any> {
    const query = new URLSearchParams();
    query.append('network', params.network);
    if (params.username) query.append('username', params.username);

    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request(`/posts/${postId}/replies?${query.toString()}`, {
      method: 'GET',
      headers,
    });
  }

  // --- Media ---

  async getUploadUrl(filename: string, contentType?: string, tenantId?: string): Promise<UploadUrlResponse> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request('/media/upload', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename, content_type: contentType }),
    });
  }

  async confirmUpload(id: string, size?: number, tenantId?: string): Promise<ConfirmUploadResponse> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request(`/media/${id}/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ size }),
    });
  }

  async getMedia(id: string, tenantId?: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request(`/media/${id}`, {
      method: 'GET',
      headers,
    });
  }

  async listMedia(limit: number = 50, offset: number = 0, tenantId?: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request(`/media?limit=${limit}&offset=${offset}`, {
      method: 'GET',
      headers,
    });
  }

  async deleteMedia(id: string, tenantId?: string): Promise<{ success: boolean }> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request(`/media/${id}`, {
      method: 'DELETE',
      headers,
    });
  }
}

export const getOutstandClient = () => {
  const apiKey = process.env.OUTSTAND_API_KEY;
  if (!apiKey) {
    throw new Error('OUTSTAND_API_KEY is not defined');
  }
  return new OutstandClient(apiKey);
};
