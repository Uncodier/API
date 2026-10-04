import { MediaRequestError } from './media-request-error';

/** Image settings are separate from chat deployment/version settings. */
export function getAzureImageConfig(env: NodeJS.Dict<string> = process.env) {
  const endpoint = (env.AZURE_OPENAI_IMAGE_ENDPOINT
    ?? env.MICROSOFT_AZURE_OPENAI_ENDPOINT ?? env.AZURE_OPENAI_ENDPOINT)?.trim();
  const apiKey = (env.AZURE_OPENAI_IMAGE_API_KEY
    ?? env.MICROSOFT_AZURE_OPENAI_API_KEY ?? env.AZURE_OPENAI_API_KEY)?.trim();
  const deployment = (env.AZURE_OPENAI_IMAGE_DEPLOYMENT ?? 'gpt-image-2.5-sunburst').trim();
  const apiVersion = (env.AZURE_OPENAI_IMAGE_API_VERSION ?? 'preview').trim();
  if (!endpoint || !apiKey || !deployment) {
    throw new MediaRequestError('Azure image generation is not configured', 503);
  }
  let base: URL;
  try { base = new URL(endpoint); } catch {
    throw new MediaRequestError('Invalid Azure image endpoint configuration', 503);
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || base.port || !/\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(base.hostname)
    || !['/', '/openai/v1', '/openai/v1/'].includes(base.pathname)) {
    throw new MediaRequestError('Invalid Azure image endpoint configuration', 503);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(deployment)
    || !/^(v1|preview|\d{4}-\d{2}-\d{2}(?:-preview)?)$/.test(apiVersion)) {
    throw new MediaRequestError('Invalid Azure image deployment or API version configuration', 503);
  }
  return { origin: base.origin, apiKey, deployment, apiVersion };
}