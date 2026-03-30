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

const BASE_URL = 'https://api.outstand.so/v1';

export class OutstandClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${BASE_URL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });
    
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      // Si el error es una validación simple que regresa texto:
      if (typeof errorBody === 'string') {
        throw new Error(`Outstand API Error: ${response.status} ${response.statusText} - ${errorBody}`);
      }
      throw new Error(`Outstand API Error: ${response.status} ${response.statusText} - ${JSON.stringify(errorBody)}`);
    }

    // Manejar casos donde la respuesta no es JSON o está vacía
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

    return this.request(`/posts?${query.toString()}`, {
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

  async listAccounts(tenantId?: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return this.request('/social-accounts', {
      method: 'GET',
      headers,
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
    const query = new URLSearchParams();
    if (params.network) query.append('network', params.network);
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
