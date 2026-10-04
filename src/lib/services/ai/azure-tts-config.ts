export const DEFAULT_AZURE_TTS_DEPLOYMENT = 'tts-hd';
export const DEFAULT_AZURE_TTS_VOICE = 'alloy';
export const DEFAULT_AZURE_TTS_API_VERSION = '2025-04-01-preview';
export const AZURE_TTS_MAX_CHARS = 4096;

export class TTSServiceError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'TTSServiceError';
  }
}

/** Dedicated speech resource only: never inherit a chat deployment or gateway key. */
export function getAzureTtsConfig(env: NodeJS.Dict<string> = process.env) {
  const endpoint = env.AZURE_TTS_ENDPOINT?.trim();
  const apiKey = env.AZURE_TTS_API_KEY?.trim();
  const deployment = (env.AZURE_TTS_DEPLOYMENT ?? DEFAULT_AZURE_TTS_DEPLOYMENT).trim();
  const apiVersion = (env.AZURE_TTS_API_VERSION ?? DEFAULT_AZURE_TTS_API_VERSION).trim();
  const voice = (env.AZURE_TTS_VOICE ?? DEFAULT_AZURE_TTS_VOICE).trim();
  if (!endpoint || !apiKey) {
    throw new TTSServiceError('Azure TTS is not configured: set AZURE_TTS_ENDPOINT and AZURE_TTS_API_KEY', 503);
  }
  let base: URL;
  try { base = new URL(endpoint); } catch {
    throw new TTSServiceError('Invalid Azure TTS endpoint configuration', 503);
  }
  // Do not forward a resource key to arbitrary hosts, URLs with userinfo or redirects.
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || base.port || !/\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(base.hostname)
    || !['/', '/openai/v1', '/openai/v1/'].includes(base.pathname)) {
    throw new TTSServiceError('Invalid Azure TTS endpoint configuration', 503);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(deployment)
    || !/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(apiVersion) || !voice) {
    throw new TTSServiceError('Invalid Azure TTS deployment, API version or voice configuration', 503);
  }
  return { origin: base.origin, apiKey, deployment, apiVersion, voice };
}