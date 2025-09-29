/*
  UnifiedAIService
  - One entry point to consume local AI routes: /api/ai/text, /image, /audio, /video
  - Provider-aware with intelligent fallbacks
  - All code and comments in English per project rules
*/

export type AIProvider = 'azure' | 'gemini' | 'vercel';

export interface TextRequestOptions {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  provider?: AIProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface ImageRequestOptions {
  prompt: string;
  provider?: Exclude<AIProvider, 'gemini'>; // not implemented yet
  size?: '256x256' | '512x512' | '1024x1024';
  n?: number;
  quality?: 'standard' | 'hd';
}

export interface AudioRequestOptions {
  text: string;
  provider?: 'vercel'; // only vercel implemented
  voice?: string;
  format?: 'mp3' | 'wav' | 'ogg';
  model?: string;
}

export interface VideoRequestOptions {
  prompt: string;
  provider?: string;
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
  const url = isServer() ? path : path; // keep relative
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  return fetch(url, {
    method: init.method || 'POST',
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

export class UnifiedAIService {
  // Intelligent provider order per resource
  private static providerOrder = {
    text: ['azure', 'gemini', 'vercel'] as AIProvider[],
    image: ['azure', 'vercel'] as AIProvider[],
    audio: ['vercel'] as AIProvider[],
    video: [] as AIProvider[],
  };

  static async generateText(opts: TextRequestOptions) {
    const preferred = opts.provider ? [opts.provider] : this.providerOrder.text;
    let lastError: any = null;

    for (const provider of preferred) {
      try {
        const res = await doFetch('/api/ai/text', {
          body: { ...opts, provider },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `Text generation failed: ${res.status}`);
        return data;
      } catch (err: any) {
        lastError = err;
        // continue to next provider
      }
    }
    throw lastError || new Error('All text providers failed');
  }

  static async generateImage(opts: ImageRequestOptions) {
    const preferred = opts.provider ? [opts.provider] : this.providerOrder.image;
    let lastError: any = null;

    for (const provider of preferred) {
      try {
        const res = await doFetch('/api/ai/image', {
          body: { ...opts, provider },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `Image generation failed: ${res.status}`);
        return data;
      } catch (err: any) {
        lastError = err;
      }
    }
    throw lastError || new Error('All image providers failed');
  }

  static async synthesizeAudio(opts: AudioRequestOptions): Promise<ArrayBuffer> {
    const provider = opts.provider || 'vercel';
    // Only vercel implemented; still keep hook for future fallbacks
    const res = await fetch('/api/ai/audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...opts, provider }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Audio synthesis failed: ${res.status}`);
    }
    return res.arrayBuffer();
  }

  static async generateVideo(opts: VideoRequestOptions) {
    // Currently not implemented on server (returns 501). Still passthrough for forward-compat.
    const res = await doFetch('/api/ai/video', { body: opts });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Video generation failed: ${res.status}`);
    return data;
  }
}

export default UnifiedAIService;



