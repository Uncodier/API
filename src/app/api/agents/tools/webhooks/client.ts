import { z } from 'zod';

const BASE_URL = 'https://api.makinari.com';

export interface MakinariWebhook {
  id: string;
  url: string;
  events: string[];
  created_at?: string;
  updated_at?: string;
  status?: string;
}

export class MakinariClient {
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
      throw new Error(`Makinari API Error: ${response.status} ${response.statusText} - ${JSON.stringify(errorBody)}`);
    }

    const data = await response.json();
    return data as T;
  }

  async getWebhooks(): Promise<MakinariWebhook[]> {
    return this.request<MakinariWebhook[]>('/webhooks', {
      method: 'GET',
    });
  }

  async createWebhook(url: string, events: string[]): Promise<MakinariWebhook> {
    return this.request<MakinariWebhook>('/webhooks', {
      method: 'POST',
      body: JSON.stringify({ url, events }),
    });
  }

  async deleteWebhook(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/webhooks/${id}`, {
      method: 'DELETE',
    });
  }
}

export const getMakinariClient = () => {
  const apiKey = process.env.MAKINARI_API_KEY;
  if (!apiKey) {
    throw new Error('MAKINARI_API_KEY is not defined');
  }
  return new MakinariClient(apiKey);
};
