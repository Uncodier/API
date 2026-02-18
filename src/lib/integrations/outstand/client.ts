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
      throw new Error(`Outstand API Error: ${response.status} ${response.statusText} - ${JSON.stringify(errorBody)}`);
    }

    const data = await response.json();
    return data as T;
  }

  // --- Posts ---

  async createPost(params: CreatePostParams): Promise<{ success: boolean; post: OutstandPost }> {
    return this.request('/posts/', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async listPosts(params: ListPostsParams = {}): Promise<{ success: boolean; posts: OutstandPost[]; pagination: any }> {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) query.append(key, String(value));
    });
    
    return this.request(`/posts?${query.toString()}`, {
      method: 'GET',
    });
  }

  async getPost(id: string): Promise<{ success: boolean; post: OutstandPost }> {
    return this.request(`/posts/${id}`, {
      method: 'GET',
    });
  }

  async getPostAnalytics(id: string): Promise<PostAnalytics> {
    return this.request(`/posts/${id}/analytics`, {
      method: 'GET',
    });
  }

  async deletePost(id: string): Promise<{ success: boolean; message: string }> {
    return this.request(`/posts/${id}`, {
      method: 'DELETE',
    });
  }

  // --- Comments ---

  async publishComment(postId: string, params: CreateCommentParams): Promise<CommentResponse> {
    return this.request(`/posts/${postId}/replies`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getComments(postId: string, params: { network?: string; username?: string } = {}): Promise<any> { 
    const query = new URLSearchParams();
    if (params.network) query.append('network', params.network);
    if (params.username) query.append('username', params.username);

    return this.request(`/posts/${postId}/replies?${query.toString()}`, {
      method: 'GET',
    });
  }

  // --- Media ---

  async getUploadUrl(filename: string, contentType?: string): Promise<UploadUrlResponse> {
    return this.request('/media/upload', {
      method: 'POST',
      body: JSON.stringify({ filename, content_type: contentType }),
    });
  }

  async confirmUpload(id: string, size?: number): Promise<ConfirmUploadResponse> {
    return this.request(`/media/${id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ size }),
    });
  }

  async getMedia(id: string): Promise<any> {
    return this.request(`/media/${id}`, {
      method: 'GET',
    });
  }

  async listMedia(limit: number = 50, offset: number = 0): Promise<any> {
    return this.request(`/media?limit=${limit}&offset=${offset}`, {
      method: 'GET',
    });
  }

  async deleteMedia(id: string): Promise<{ success: boolean }> {
    return this.request(`/media/${id}`, {
      method: 'DELETE',
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
