import { readResponseWithLimit } from '@/lib/security/limited-response';
import { getExecutionRouting, resolveCustomerDispatch, CustomerRoutingError } from '@/lib/services/ai/customer-routing';
import type { VideoRequestBody } from './video-types';
import type { PreparedVideo, OpenRouterVideoJob } from './provider-openrouter';
import { beginCustomerInference } from '@/lib/services/billing/customer-inference-receipts';
import { validateCustomerMp4 } from './customer-mp4';
export { validateCustomerMp4 } from './customer-mp4';

async function request(path: string, body?: object) {
  const routing = getExecutionRouting();
  if (routing?.payer !== 'customer') throw new CustomerRoutingError('CUSTOMER_ROUTE_REQUIRED');
  const selected = await resolveCustomerDispatch(routing, 'video');
  const response = await fetch(`https://openrouter.ai/api/v1/videos${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${selected.apiKey}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new CustomerRoutingError('CUSTOMER_VIDEO_UPSTREAM_FAILED');
  return response;
}

export async function prepareCustomerVideo(body: VideoRequestBody): Promise<PreparedVideo> {
  const routing = getExecutionRouting(body.site_id)!;
  const selected = await resolveCustomerDispatch(routing, 'video');
  if (body.model && body.model !== selected.modelId) throw new CustomerRoutingError('CUSTOMER_MODEL_BINDING_MISMATCH');
  if (body.reference_images?.length || body.first_frame_url || body.last_frame_url || body.quality) {
    throw new CustomerRoutingError('CUSTOMER_VIDEO_OPTIONS_UNSUPPORTED');
  }
  const catalog = JSON.parse((await readResponseWithLimit(await request('/models'), 4*1024*1024)).toString());
  const model = catalog.data?.find((item: any) => item.id === selected.modelId);
  const duration = body.duration_seconds ?? 4, ratio = body.aspect_ratio ?? '16:9';
  if (!model?.supported_durations?.includes(duration) || !model.supported_aspect_ratios?.includes(ratio)
      || (body.resolution && !model.supported_resolutions?.includes(body.resolution))) {
    throw new CustomerRoutingError('CUSTOMER_VIDEO_PARAMETERS_UNAVAILABLE');
  }
  return { model: selected.modelId, prompt: body.prompt, duration, aspect_ratio: ratio,
    ...(body.resolution ? { resolution: body.resolution } : {}) };
}

export async function customerVideoJob(bodyOrId: PreparedVideo | string, intent?: { eventId: string; operationKey: string }): Promise<OpenRouterVideoJob> {
  if (typeof bodyOrId === 'string' && !/^[\w-]{1,200}$/.test(bodyOrId)) throw new CustomerRoutingError('INVALID_VIDEO_JOB');
  if (typeof bodyOrId !== 'string') {
    const routing = getExecutionRouting();
    if (routing?.payer !== 'customer' || !intent) throw new CustomerRoutingError('CUSTOMER_VIDEO_INTENT_REQUIRED');
    const selected = await resolveCustomerDispatch(routing, 'video');
    if (selected.modelId !== bodyOrId.model) throw new CustomerRoutingError('CUSTOMER_MODEL_BINDING_MISMATCH');
    await beginCustomerInference({ routing, capability: 'video', requestedModel: bodyOrId.model, ...intent });
  }
  // Video documents provider-specific passthrough, not chat fallback controls.
  const response = typeof bodyOrId === 'string' ? await request(`/${bodyOrId}`) : await request('', bodyOrId);
  const job = JSON.parse((await readResponseWithLimit(response, 1024*1024)).toString());
  if (!job || typeof job.id !== 'string' || !/^[\w-]{1,200}$/.test(job.id) || !['pending','in_progress','completed','failed'].includes(job.status)
      || (typeof bodyOrId === 'string' && job.id !== bodyOrId)) throw new CustomerRoutingError('INVALID_VIDEO_JOB');
  return { id: job.id, status: job.status,
    generation_id: typeof job.generation_id === 'string' && /^[\w-]{1,200}$/.test(job.generation_id) ? job.generation_id : undefined,
    usage: typeof job.usage?.cost === 'number' && Number.isFinite(job.usage.cost) && job.usage.cost >= 0
      ? { cost: job.usage.cost } : undefined };
}

export async function downloadCustomerVideo(id: string) {
  if(!/^[\w-]{1,200}$/.test(id))throw new CustomerRoutingError('INVALID_VIDEO_JOB');
  const response=await request(`/${id}/content?index=0`);
  if(response.headers.get('content-type')?.split(';')[0]!=='video/mp4')throw new Error('Unsupported customer video format');
  const buffer=await readResponseWithLimit(response,100*1024*1024);validateCustomerMp4(buffer);
  return {buffer,mimeType:'video/mp4'};
}