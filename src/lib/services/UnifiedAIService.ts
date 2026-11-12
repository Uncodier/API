/*
  UnifiedAIService
  - One entry point to consume local AI routes: /api/ai/text, /image, /audio, /video
  - Azure owns images; OpenRouter owns the other AI capabilities
  - All code and comments in English per project rules
*/

import type { ImageRequestBody } from '@/app/api/ai/image/image-types';

export type AIProvider = 'openrouter';

export interface TextRequestOptions {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  provider?: AIProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  site_id?: string;
}

export type ImageRequestOptions = ImageRequestBody;

export interface AudioRequestOptions {
  text: string;
  provider?: AIProvider;
  voice?: string;
  format?: 'mp3' | 'pcm';
  model?: string;
  site_id?: string;
}

export interface VideoRequestOptions {
  prompt: string;
  site_id: string;
  instance_id?: string;
  provider?: AIProvider;
  model?: string;
  duration_seconds?: number;
  aspect_ratio?: string;
  resolution?: string;
  reference_images?: string[];
  first_frame_url?: string;
  last_frame_url?: string;
  job_id?: string;
}

interface FetcherInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: any;
}

function isServer(): boolean {
  return typeof window === 'undefined';
}

async function doFetch(path: string, init: FetcherInit): Promise<Response> {
  const url = isServer() ? new URL(path, process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:3000').toString() : path;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  let body = init.body;
  if (isServer()) {
    const { getExecutionRouting } = await import('./ai/customer-routing');
    const { executionRoutingHeaders } = await import('./ai/customer-routing-http');
    const requestedSite = body?.site_id ?? new URL(url).searchParams.get('site_id') ?? undefined;
    const routing = getExecutionRouting(requestedSite);
    headers['x-api-key'] = process.env.SERVICE_API_KEY || '';
    if (routing) {
      Object.assign(headers, await executionRoutingHeaders(routing, { path: new URL(url).pathname }));
      if (body) body = { ...body, site_id: routing.siteId };
    }
  }
  return fetch(url, {
    method: init.method || 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
  });
}

export class UnifiedAIService {
  private static assertProvider(provider?: string) {
    if (provider !== undefined && provider !== 'openrouter') throw new Error('Only OpenRouter is supported');
  }

  static async generateText(opts: TextRequestOptions) {
    this.assertProvider(opts.provider);
    const res = await doFetch('/api/ai/text', { body: { ...opts, provider: 'openrouter' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Text generation failed: ${res.status}`);
    return data;
  }

  static async generateImage(opts: ImageRequestOptions) {
    if (opts.provider !== undefined && opts.provider !== 'azure') throw new Error('Only Azure is supported for images');
    const res = await doFetch('/api/ai/image', { body: { ...opts, provider: 'azure' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Image generation failed: ${res.status}`);
    return data;
  }

  static async synthesizeAudio(opts: AudioRequestOptions): Promise<ArrayBuffer> {
    this.assertProvider(opts.provider);
    const res = await doFetch('/api/ai/audio', { body: opts });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Audio synthesis failed: ${res.status}`);
    }
    return res.arrayBuffer();
  }

  static async generateVideo(opts: VideoRequestOptions) {
    this.assertProvider(opts.provider);
    if (opts.job_id) {
      const query = new URLSearchParams({ site_id: opts.site_id, job_id: opts.job_id });
      const res = await doFetch(`/api/ai/video?${query}`, { method: 'GET' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Video status failed: ${res.status}`);
      return data;
    }
    const res = await doFetch('/api/ai/video', { body: { ...opts, provider: opts.provider || 'openrouter' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Video generation failed: ${res.status}`);
    return data;
  }
}

export default UnifiedAIService;



