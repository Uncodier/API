import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

type Provider = 'azure' | 'gemini' | 'vercel';

interface TextRequestBody {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  provider?: Provider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

function getEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[text api] Missing environment variable ${name}`);
  }
  return value;
}

function toAzureMessages(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): any[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function toGeminiContents(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

async function generateWithAzure(options: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}) {
  const endpoint = getEnv('AZURE_OPENAI_ENDPOINT');
  const apiKey = getEnv('AZURE_OPENAI_API_KEY');
  const deployment = getEnv('AZURE_OPENAI_CHAT_DEPLOYMENT'); // e.g. "gpt-4o-mini"
  const apiVersion = getEnv('AZURE_OPENAI_API_VERSION') || '2024-09-01-preview';

  if (!endpoint || !apiKey || !deployment) {
    throw new Error('Azure OpenAI text generation is not configured');
  }

  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      messages: toAzureMessages(options.messages),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Azure text generation failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return { provider: 'azure', content, raw: data };
}

async function generateWithGemini(options: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}) {
  const apiKey = getEnv('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('Gemini is not configured');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelId = options.model || 'models/gemini-1.5-pro';
  const model = genAI.getGenerativeModel({ model: modelId });
  const result = await model.generateContent({
    contents: toGeminiContents(options.messages),
    generationConfig: {
      temperature: options.temperature,
      maxOutputTokens: options.maxTokens,
      topP: options.topP,
    },
  } as any);

  const text = result?.response?.text?.() ?? '';
  return { provider: 'gemini', content: text, raw: result }; 
}

async function generateWithVercelGateway(options: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}) {
  const baseURL = getEnv('VERCEL_AI_GATEWAY_OPENAI');
  const apiKey = getEnv('VERCEL_AI_GATEWAY_API_KEY');
  if (!baseURL || !apiKey) {
    throw new Error('Vercel AI Gateway is not configured');
  }

  const resp = await fetch(`${baseURL.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options.model || 'gpt-4o-mini',
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Vercel Gateway text generation failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return { provider: 'vercel', content, raw: data };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as TextRequestBody;
    const { messages, provider = 'azure', model, temperature, maxTokens, topP } = body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Parameter "messages" is required (non-empty array)' }, { status: 400 });
    }

    if (provider === 'azure') {
      try {
        const result = await generateWithAzure({ messages, temperature, maxTokens, topP });
        return NextResponse.json(result);
      } catch (err) {
        console.warn('[text api] Azure provider failed, trying Vercel fallback...', err);
        const fallback = await generateWithVercelGateway({ messages, model, temperature, maxTokens, topP });
        return NextResponse.json({ ...fallback, fallbackFrom: 'azure' });
      }
    }

    if (provider === 'gemini') {
      try {
        const result = await generateWithGemini({ messages, model, temperature, maxTokens, topP });
        return NextResponse.json(result);
      } catch (err) {
        console.warn('[text api] Gemini provider failed, trying Vercel fallback...', err);
        const fallback = await generateWithVercelGateway({ messages, model, temperature, maxTokens, topP });
        return NextResponse.json({ ...fallback, fallbackFrom: 'gemini' });
      }
    }

    if (provider === 'vercel') {
      const result = await generateWithVercelGateway({ messages, model, temperature, maxTokens, topP });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: `Unsupported provider: ${provider}` }, { status: 400 });
  } catch (error: any) {
    console.error('[text api] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to process request' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'AI Text Generation API',
    usage: {
      method: 'POST',
      body: {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Write a haiku.' }
        ],
        provider: "'azure' | 'gemini' | 'vercel' (default: 'azure')",
        model: 'optional model id (provider specific)',
        temperature: 'number',
        maxTokens: 'number',
        topP: 'number'
      },
    },
    providers: ['azure', 'gemini', 'vercel'],
    env: {
      requiredForAzure: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_CHAT_DEPLOYMENT'],
      requiredForGemini: ['GEMINI_API_KEY'],
      requiredForVercelFallback: ['VERCEL_AI_GATEWAY_OPENAI', 'VERCEL_AI_GATEWAY_API_KEY'],
    },
  });
}


