import { customerMediaJson } from './customer-media-transport';
import { CustomerRoutingError, getExecutionRouting } from './customer-routing';
import { validateCustomerPng } from './customer-image-artifact';

export interface CustomerImageOptions {
  siteId: string;
  prompt: string;
  count?: number;
  size?: string;
  ratio?: string;
  quality?: 'auto' | 'low' | 'medium' | 'high';
  operationKey?: string;
  persist?: boolean;
  instanceId?: string;
  model?: string;
}

/** Not a verification bypass: resolver requires connection-specific evidence.
 * Public requests require durable operation admission and strict persistence.
 * No reference-image/streaming/provider-override support.
 */
export async function generateCustomerImageArtifacts(options: CustomerImageOptions) {
  const routing = getExecutionRouting(options.siteId);
  if (routing?.payer !== 'customer') throw new CustomerRoutingError('CUSTOMER_ROUTE_REQUIRED');
  const count = options.count ?? 1;
  if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 10000
      || !Number.isInteger(count) || count < 1 || count > 4
      || (options.size !== undefined && !/^\d{3,4}x\d{3,4}$/.test(options.size))
      || (options.ratio !== undefined && !['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'].includes(options.ratio))
      || (options.quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(options.quality))) {
    throw new CustomerRoutingError('INVALID_CUSTOMER_IMAGE_OPTIONS');
  }
  return customerMediaJson({ capability: 'image', operationKey: options.operationKey, expectedModel: options.model, body: {
    prompt: options.prompt, n: count, output_format: 'png',
    ...(options.size ? { size: options.size } : {}),
    ...(options.ratio ? { aspect_ratio: options.ratio } : {}),
    ...(options.quality ? { quality: options.quality } : {}),
    provider: { allow_fallbacks: false },
  }, async validate(data, model, eventId) {
    if (!Array.isArray(data.data) || !data.data.length || data.data.length > count) throw new Error('Invalid image count');
    const images = data.data.map((image: any) => {
      if (!image || (image.media_type !== undefined && image.media_type !== 'image/png')) throw new Error('Invalid image type');
      return { b64_json: validateCustomerPng(image.b64_json, options.size, options.ratio), media_type: 'image/png' as const };
    });
    if (options.persist) {
      const { persistCustomerImage } = await import('./customer-image-persistence');
      const saved = [];
      for (const image of images) saved.push(await persistCustomerImage({ base64Data: image.b64_json,
        siteId: options.siteId, instanceId: options.instanceId, model, eventId, routing, generationId: data.id }));
      return { images: saved, model, usage: data.usage, generationId: data.id, receiptEventId: eventId };
    }
    return { images, model, usage: data.usage, generationId: data.id, receiptEventId: eventId };
  } });
}