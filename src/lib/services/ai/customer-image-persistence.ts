import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { uploadGeneratedImage } from '@/app/api/ai/image/image-storage';
import type { ExecutionRoutingReference } from './customer-routing';

/** Unlike legacy best-effort assets, customer acceptance requires durable receipt linkage. */
export async function persistCustomerImage(input: {
  base64Data: string; siteId: string; model: string; eventId: string;
  routing: ExecutionRoutingReference; generationId?: string; instanceId?: string;
}) {
  if (input.routing.payer !== 'customer' || input.routing.siteId !== input.siteId) throw new Error('Invalid image owner');
  const uploaded = await uploadGeneratedImage({ base64Data: input.base64Data, mimeType: 'image/png', siteId: input.siteId });
  if (!uploaded.path || !uploaded.url || uploaded.size <= 0) throw new Error('Image persistence was not acknowledged');
  const artifactId = randomUUID();
  const { error } = await supabaseAdmin.from('assets').insert({
    id: artifactId, site_id: input.siteId, name: `customer_image_${artifactId}.png`,
    file_path: uploaded.url, file_type: 'image/png', file_size: uploaded.size, is_public: true,
    ...(input.instanceId ? { instance_id: input.instanceId } : {}),
    metadata: { provider: 'openrouter', payer: 'customer', model: input.model,
      storage_path: uploaded.path, bucket: 'generative_images', receipt_event_id: input.eventId,
      generation_id: input.generationId, connection_id: input.routing.connectionId,
      policy_version: input.routing.policyVersion, credential_version: input.routing.credentialVersion },
  });
  if (error) throw new Error('Customer image asset persistence failed');
  return { url: uploaded.url, b64_json: null, artifact_id: artifactId, receipt_event_id: input.eventId };
}