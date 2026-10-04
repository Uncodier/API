import { NextRequest, NextResponse } from 'next/server';
import { createOpenRouterClient, resolveOpenRouterModel, isOpenRouterReasoningModel } from '@/lib/services/ai/openrouter';
import {
  enforceRequestRateLimit,
  getAuthenticatedRateIdentity,
  isInternalServiceRequest,
} from '@/lib/security/request-rate-limit';

type Provider = 'openrouter';

interface TextRequestBody {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  provider?: Provider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export async function POST(request: NextRequest) {
  try {
    const identity = getAuthenticatedRateIdentity(request);
    const limited = await enforceRequestRateLimit(request, {
      namespace: 'ai-text-principal',
      identity,
      limit: isInternalServiceRequest(request) ? 300 : 30,
      windowSeconds: 60,
      failClosed: true,
    });
    if (limited) return limited;

    const body = (await request.json()) as TextRequestBody;
    const { messages, provider = 'openrouter', model, temperature, maxTokens, topP } = body || {};
    if (provider !== 'openrouter') {
      return NextResponse.json({ error: 'Only provider openrouter is supported' }, { status: 400 });
    }

    if (
      !Array.isArray(messages)
      || messages.length === 0
      || messages.length > 50
      || messages.some((message) => (
        !message
        || !['system', 'user', 'assistant'].includes(message.role)
        || typeof message.content !== 'string'
        || message.content.length === 0
      ))
    ) {
      return NextResponse.json({ error: 'Parameter "messages" is required (non-empty array)' }, { status: 400 });
    }
    const totalInputCharacters = messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );
    if (totalInputCharacters > 100_000) {
      return NextResponse.json(
        { error: 'Combined message content exceeds 100000 characters' },
        { status: 413 },
      );
    }
    const safeMaxTokens = Math.min(8_192, Math.max(1, Math.trunc(maxTokens || 2_048)));
    const safeTemperature = temperature === undefined
      ? undefined
      : Math.min(2, Math.max(0, temperature));
    const safeTopP = topP === undefined
      ? undefined
      : Math.min(1, Math.max(0, topP));

    if (model !== undefined && typeof model !== 'string') {
      return NextResponse.json({ error: 'model must be a string' }, { status: 400 });
    }
    const modelId = resolveOpenRouterModel(model);
    const data = await createOpenRouterClient().chat.completions.create({
      model: modelId, messages, max_tokens: safeMaxTokens, stream: false,
      ...(isOpenRouterReasoningModel(modelId) ? {} : { temperature: safeTemperature, top_p: safeTopP }),
    });
    // Keep content/raw aliases; provider from OpenRouter is the upstream provider.
    return NextResponse.json({ ...data, gateway: 'openrouter',
      provider: (data as any).provider || 'openrouter',
      content: data.choices?.[0]?.message?.content ?? '', raw: data });
  } catch (error: any) {
    console.error('[text api] Text generation failed');
    return NextResponse.json(
      { error: 'Failed to process text generation request' },
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
        provider: "'openrouter' (default and only provider)",
        model: 'optional OpenRouter model id',
        temperature: 'number',
        maxTokens: 'number',
        topP: 'number'
      },
    },
    providers: ['openrouter'],
    env: {
      requiredForOpenRouter: ['OPENROUTER_API_KEY'],
    },
  });
}


