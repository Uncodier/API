/** Transcription uses Azure directly, independently of chat and image routing. */
export function getAzureTranscriptionConfig(env: NodeJS.Dict<string> = process.env) {
  const endpoint = (env.AZURE_OPENAI_TRANSCRIPTION_ENDPOINT
    ?? env.MICROSOFT_AZURE_OPENAI_ENDPOINT ?? env.AZURE_OPENAI_ENDPOINT)?.trim();
  const apiKey = (env.AZURE_OPENAI_TRANSCRIPTION_API_KEY
    ?? env.MICROSOFT_AZURE_OPENAI_API_KEY ?? env.AZURE_OPENAI_API_KEY)?.trim();
  const deployment = env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT?.trim();
  const apiVersion = (env.AZURE_OPENAI_TRANSCRIPTION_API_VERSION ?? '2024-10-21').trim();
  if (!endpoint || !apiKey || !deployment) {
    throw new Error('Azure transcription is not configured. Set AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT and Azure endpoint/API key credentials.');
  }
  let base: URL;
  try { base = new URL(endpoint); } catch {
    throw new Error('Invalid Azure transcription endpoint configuration');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || base.port || !/\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(base.hostname)
    || !['/', '/openai/v1', '/openai/v1/'].includes(base.pathname)) {
    throw new Error('Invalid Azure transcription endpoint configuration');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(deployment)
    || !/^(v1|preview|\d{4}-\d{2}-\d{2}(?:-preview)?)$/.test(apiVersion)) {
    throw new Error('Invalid Azure transcription deployment or API version configuration');
  }
  return { origin: base.origin, apiKey, deployment, apiVersion };
}