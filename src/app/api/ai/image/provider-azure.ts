import { getAzureImageConfig } from '@/lib/services/image/azure-image-config';
import { MediaRequestError } from '@/lib/services/image/media-request-error';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { readResponseWithLimit } from '@/lib/security/limited-response';
import { persistGeneratedImage } from './image-storage';
import type { GenerateImageOptions, ImageGenerationResult, ImageRatio } from './image-types';

const RATIO_SIZES: Record<ImageRatio, string> = {
  '1:1': '1024x1024', '4:3': '1536x1152', '3:4': '1152x1536',
  '16:9': '1536x864', '9:16': '864x1536', '3:2': '1536x1024', '2:3': '1024x1536',
};

function imageParameters(options: GenerateImageOptions, deployment: string) {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 4) {
    throw new MediaRequestError('n must be an integer between 1 and 4', 400);
  }
  if (options.ratio !== undefined && !Object.hasOwn(RATIO_SIZES, options.ratio)) {
    throw new MediaRequestError('Unsupported image aspect ratio', 400);
  }
  const size = options.size ?? (options.ratio ? RATIO_SIZES[options.ratio] : '1024x1024');
  if (size === 'auto') {
    if (options.ratio) throw new MediaRequestError('Omit size to use aspect_ratio', 400);
  } else {
    const match = /^(\d{3,4})x(\d{3,4})$/.exec(size);
    const width = Number(match?.[1]); const height = Number(match?.[2]);
    if (!match || width % 16 || height % 16 || width > 3840 || height > 3840
      || width * height < 655_360 || width * height > 8_294_400
      || width / height > 3 || height / width > 3) {
      throw new MediaRequestError('Unsupported Azure image size: use multiples of 16, 655360–8294400 pixels, edges up to 3840 and ratio up to 3:1', 400);
    }
    if (options.ratio) {
      const [w, h] = options.ratio.split(':').map(Number);
      if (width * h !== height * w) {
        throw new MediaRequestError('size conflicts with aspect_ratio; omit size to use the ratio', 400);
      }
    }
  }
  const quality = options.quality === 'standard' ? 'medium'
    : options.quality === 'hd' ? 'high' : options.quality ?? 'auto';
  // Deployment aliases are not model IDs. Azure validates capabilities of overrides.
  if (typeof quality !== 'string' || !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(quality)) {
    throw new MediaRequestError('Unsupported Azure image quality', 400);
  }
  return { model: deployment, prompt: options.prompt, n: options.count, size, quality, output_format: 'png' };
}

async function referenceImage(value: string): Promise<Blob> {
  try {
    const url = await assertSafeRemoteUrl(value);
    const response = await fetch(url, {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
    });
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!response.ok || !mime || !['image/png', 'image/jpeg'].includes(mime)) throw new Error();
    const buffer = await readResponseWithLimit(response, 20 * 1024 * 1024);
    if (!buffer.length) throw new Error();
    return new Blob([new Uint8Array(buffer)], { type: mime });
  } catch {
    throw new MediaRequestError('Unable to read reference image: use a public HTTPS PNG or JPEG under 20 MiB', 400);
  }
}

/** Direct Azure API; no OpenRouter calls, credential forwarding, retries or fallback. */
export async function generateWithAzure(options: GenerateImageOptions): Promise<ImageGenerationResult> {
  const config = getAzureImageConfig();
  const deployment = options.model ?? config.deployment;
  if (typeof deployment !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(deployment)) {
    throw new MediaRequestError('model must be an Azure deployment name, not a qualified OpenRouter model ID', 400);
  }
  const parameters = imageParameters(options, deployment);
  if (options.referenceImages !== undefined
    && (!Array.isArray(options.referenceImages) || options.referenceImages.length > 4)) {
    throw new MediaRequestError('reference_images must contain at most 4 URLs', 400);
  }
  const editing = !!options.referenceImages?.length;
  const operation = editing ? 'edits' : 'generations';
  const datedApi = /^\d{4}-/.test(config.apiVersion);
  const url = new URL(datedApi
    ? `/openai/deployments/${encodeURIComponent(deployment)}/images/${operation}`
    : `/openai/v1/images/${operation}`, config.origin);
  url.searchParams.set('api-version', config.apiVersion);
  let body: string | FormData = JSON.stringify(parameters);
  if (editing) {
    const form = new FormData();
    for (const [name, value] of Object.entries(parameters)) form.set(name, String(value));
    // At most four bounded downloads in parallel: 30s references + 180s inference
    // leaves persistence/billing headroom within the service's 240s timeout.
    const references = await Promise.all(options.referenceImages!.map(referenceImage));
    for (let index = 0; index < references.length; index++) {
      const image = references[index];
      form.append('image[]', image, `reference-${index}.${image.type === 'image/png' ? 'png' : 'jpg'}`);
    }
    body = form;
  }
  let response: { data?: Array<{ b64_json?: string }>; id?: string };
  try {
    const result = await fetch(url, {
      method: 'POST', headers: {
        'api-key': config.apiKey,
        ...(!editing ? { 'Content-Type': 'application/json' } : {}),
      },
      body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(180_000),
    });
    if (!result.ok) throw new MediaRequestError(`Azure image request failed (${result.status})`);
    response = JSON.parse((await readResponseWithLimit(result, 90 * 1024 * 1024)).toString('utf8'));
  } catch (error) {
    if (error instanceof MediaRequestError) throw error;
    throw new MediaRequestError('Azure image request failed or timed out; generation outcome may be uncertain');
  }
  if (!response || !Array.isArray(response.data) || !response.data.length || response.data.length > options.count) {
    throw new MediaRequestError('Azure returned an invalid image count');
  }
  for (const image of response.data) {
    if (!image || typeof image.b64_json !== 'string' || !image.b64_json.length
      || image.b64_json.length > 22 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json)
      || image.b64_json.length % 4 !== 0
      || !Buffer.from(image.b64_json, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new MediaRequestError('Azure returned an invalid base64 image');
    }
  }
  const generationId = typeof response.id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(response.id)
    ? response.id : undefined;
  const images = [];
  for (const image of response.data) {
    images.push(await persistGeneratedImage({
      base64Data: image.b64_json!, mimeType: 'image/png', siteId: options.siteId,
      instanceId: options.instanceId, provider: 'azure', prompt: options.prompt,
      model: deployment, generationId,
    }));
  }
  // Azure usage tokens are not invoice dollars. Never report an invented cost.
  return { provider: 'azure', images, metadata: { model: deployment, generation_id: generationId } };
}