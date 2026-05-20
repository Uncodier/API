import Portkey from 'portkey-ai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getRequestOptions } from '@/lib/config/analyzer-config';
import type { ProviderProbeResult } from '@/lib/status/types';
import { isAiProbeEnabled } from '@/lib/status/types';

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MESSAGE = 'ping';

function getEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

function hasEnv(...names: string[]): boolean {
  return names.every((n) => !!getEnv(n));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('PROBE_TIMEOUT')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function mapProbeError(err: unknown): { errorCode: string; errorMessage: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('PROBE_TIMEOUT') || msg.includes('timeout')) {
    return { errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'Probe timed out' };
  }
  if (msg.includes('401') || msg.includes('403') || /unauthorized|invalid.*key/i.test(msg)) {
    return { errorCode: 'AUTH_FAILED', errorMessage: 'Authentication failed' };
  }
  if (msg.includes('429') || /rate limit/i.test(msg)) {
    return { errorCode: 'QUOTA_EXCEEDED', errorMessage: 'Rate limited' };
  }
  return { errorCode: 'PROVIDER_ERROR', errorMessage: msg.slice(0, 120) };
}

async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const { errorCode } = mapProbeError(err);
    if (errorCode === 'QUOTA_EXCEEDED') {
      await new Promise((r) => setTimeout(r, 2000));
      return await fn();
    }
    throw err;
  }
}

function skippedResult(model: string): ProviderProbeResult {
  return {
    configured: false,
    liveProbe: false,
    latencyMs: 0,
    model,
    skipped: true,
  };
}

function notProbedResult(model: string, reason: string): ProviderProbeResult {
  return {
    configured: true,
    liveProbe: false,
    latencyMs: 0,
    model,
    errorCode: 'PROBE_DISABLED',
    errorMessage: reason,
  };
}

export async function probePortkeyProvider(
  modelType: 'anthropic' | 'openai' | 'gemini',
): Promise<ProviderProbeResult> {
  const virtualKeyMap: Record<string, string | undefined> = {
    anthropic: getEnv('ANTHROPIC_API_KEY'),
    openai: getEnv('AZURE_OPENAI_API_KEY'),
    gemini: getEnv('GEMINI_API_KEY'),
  };
  const defaultModels: Record<string, string> = {
    anthropic: 'claude-3-haiku-20240307',
    openai: 'gpt-5-nano',
    gemini: 'gemini-1.5-flash',
  };

  const virtualKey = virtualKeyMap[modelType];
  const portkeyKey = getEnv('PORTKEY_API_KEY');
  if (!portkeyKey || !virtualKey) {
    return skippedResult(defaultModels[modelType]);
  }
  if (!isAiProbeEnabled()) {
    return notProbedResult(defaultModels[modelType], 'Live probes disabled locally');
  }

  const start = Date.now();
  try {
    const portkey = new Portkey({
      apiKey: portkeyKey,
      virtualKey,
      baseURL: 'https://api.portkey.ai/v1',
    });
    const requestOptions = getRequestOptions(modelType);
    const model =
      modelType === 'anthropic'
        ? requestOptions.anthropic.model
        : modelType === 'openai'
          ? requestOptions.openai.model
          : requestOptions.gemini.model;

    await retryOnce(() =>
      withTimeout(
        portkey.chat.completions.create({
          messages: [{ role: 'user', content: PROBE_MESSAGE }],
          model,
          max_tokens: 1,
        } as Parameters<typeof portkey.chat.completions.create>[0]),
        PROBE_TIMEOUT_MS,
      ),
    );

    return {
      configured: true,
      liveProbe: true,
      latencyMs: Date.now() - start,
      model,
    };
  } catch (err) {
    const { errorCode, errorMessage } = mapProbeError(err);
    return {
      configured: true,
      liveProbe: false,
      latencyMs: Date.now() - start,
      model: defaultModels[modelType],
      errorCode,
      errorMessage,
    };
  }
}

export async function probeAzureText(): Promise<ProviderProbeResult> {
  const model = getEnv('AZURE_OPENAI_CHAT_DEPLOYMENT') || 'gpt-4o-mini';
  if (!hasEnv('AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_CHAT_DEPLOYMENT')) {
    return skippedResult(model);
  }
  if (!isAiProbeEnabled()) {
    return notProbedResult(model, 'Live probes disabled locally');
  }

  const endpoint = getEnv('AZURE_OPENAI_ENDPOINT')!;
  const apiKey = getEnv('AZURE_OPENAI_API_KEY')!;
  const deployment = getEnv('AZURE_OPENAI_CHAT_DEPLOYMENT')!;
  const apiVersion = getEnv('AZURE_OPENAI_API_VERSION') || '2024-09-01-preview';
  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const start = Date.now();
  try {
    await retryOnce(() =>
      withTimeout(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
          body: JSON.stringify({
            messages: [{ role: 'user', content: PROBE_MESSAGE }],
            max_tokens: 1,
            stream: false,
          }),
        }).then(async (resp) => {
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Azure probe failed: ${resp.status} ${text}`);
          }
        }),
        PROBE_TIMEOUT_MS,
      ),
    );
    return { configured: true, liveProbe: true, latencyMs: Date.now() - start, model: deployment };
  } catch (err) {
    const { errorCode, errorMessage } = mapProbeError(err);
    return {
      configured: true,
      liveProbe: false,
      latencyMs: Date.now() - start,
      model: deployment,
      errorCode,
      errorMessage,
    };
  }
}

export async function probeGeminiText(): Promise<ProviderProbeResult> {
  const model = 'gemini-1.5-flash';
  const apiKey = getEnv('GEMINI_API_KEY');
  if (!apiKey) {
    return skippedResult(model);
  }
  if (!isAiProbeEnabled()) {
    return notProbedResult(model, 'Live probes disabled locally');
  }

  const start = Date.now();
  try {
    await retryOnce(() =>
      withTimeout(
        (async () => {
          const genAI = new GoogleGenerativeAI(apiKey);
          const m = genAI.getGenerativeModel({ model });
          await m.generateContent({
            contents: [{ role: 'user', parts: [{ text: PROBE_MESSAGE }] }],
            generationConfig: { maxOutputTokens: 1 },
          });
        })(),
        PROBE_TIMEOUT_MS,
      ),
    );
    return { configured: true, liveProbe: true, latencyMs: Date.now() - start, model };
  } catch (err) {
    const { errorCode, errorMessage } = mapProbeError(err);
    return {
      configured: true,
      liveProbe: false,
      latencyMs: Date.now() - start,
      model,
      errorCode,
      errorMessage,
    };
  }
}

export async function probeVercelGateway(): Promise<ProviderProbeResult> {
  const model = 'gpt-4o-mini';
  const baseURL = getEnv('VERCEL_AI_GATEWAY_OPENAI');
  const apiKey = getEnv('VERCEL_AI_GATEWAY_API_KEY');
  if (!baseURL || !apiKey) {
    return skippedResult(model);
  }
  if (!isAiProbeEnabled()) {
    return notProbedResult(model, 'Live probes disabled locally');
  }

  const start = Date.now();
  try {
    await retryOnce(() =>
      withTimeout(
        fetch(`${baseURL.replace(/\/$/, '')}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: PROBE_MESSAGE }],
            max_tokens: 1,
          }),
        }).then(async (resp) => {
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Vercel gateway probe failed: ${resp.status} ${text}`);
          }
        }),
        PROBE_TIMEOUT_MS,
      ),
    );
    return { configured: true, liveProbe: true, latencyMs: Date.now() - start, model };
  } catch (err) {
    const { errorCode, errorMessage } = mapProbeError(err);
    return {
      configured: true,
      liveProbe: false,
      latencyMs: Date.now() - start,
      model,
      errorCode,
      errorMessage,
    };
  }
}

/** Image/video/audio: live probe via same text path when only env is set */
export async function probeMediaProvider(
  name: string,
  requiredEnv: string[],
  fallbackProbe: () => Promise<ProviderProbeResult>,
): Promise<ProviderProbeResult> {
  if (!hasEnv(...requiredEnv)) {
    return skippedResult(name);
  }
  return fallbackProbe();
}
