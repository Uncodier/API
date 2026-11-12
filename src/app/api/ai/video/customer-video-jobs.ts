import { randomUUID } from 'node:crypto';
import { getCachedJson, setCachedJson, sha256 } from '@/lib/security/upstash-rest';
import { CustomerRoutingError, getExecutionRouting, withExecutionRouting, type ExecutionRoutingReference } from '@/lib/services/ai/customer-routing';
import { MediaRequestError } from '@/lib/services/image/media-request-error';
import { customerVideoJob, downloadCustomerVideo } from './customer-video';
import { persistCustomerVideo } from './customer-video-storage';
import { videoSettlement, deliverVideoSettlement } from './customer-video-settlement';
import type { PreparedVideo } from './provider-openrouter';
import type { VideoGenerationResult, VideoRequestBody } from './video-types';
import { saveCustomerVideoJob, loadCustomerVideoJob } from './customer-video-store';

export interface CustomerVideoJob {
  id: string; siteId: string; instanceId?: string; routing: ExecutionRoutingReference;
  request: PreparedVideo; fingerprint: string; eventId: string; operationKey: string;
  createdAt: string; status: 'pending' | 'in_progress' | 'completed' | 'failed';
  upstreamId?: string; generationId?: string; cost?: number; error?: string;
  videos?: VideoGenerationResult['videos'];
  version?: number;
  settlement?: ReturnType<typeof videoSettlement>;
}
const key = (id: string) => `ai-video:job:${id}`;
const TTL = 7 * 24 * 60 * 60;
async function save(job: CustomerVideoJob) {
  await saveCustomerVideoJob(job);
  if (!await setCachedJson(key(job.id), job, TTL)
      || JSON.stringify(await getCachedJson(key(job.id))) !== JSON.stringify(job)) {
    throw new MediaRequestError('Video job persistence unavailable; retry status only', 503);
  }
}
function result(job: CustomerVideoJob): VideoGenerationResult {
  return { provider: 'openrouter', job_id: job.id, status: job.status,
    videos: job.status === 'completed' ? job.videos ?? [] : [], ...(job.error ? { error: job.error } : {}),
    metadata: { model: job.request.model, duration_seconds: job.request.duration,
      aspect_ratio: job.request.aspect_ratio as VideoRequestBody['aspect_ratio'], resolution: job.request.resolution,
      generated_at: job.createdAt, generation_id: job.generationId, cost: job.cost,
      payer: 'customer', receipt_event_id: job.eventId } };
}

/** Redis is a recoverable status cache, not the paid-dispatch deduplication authority. */
export async function startCustomerVideoJob(body: VideoRequestBody, prepared: PreparedVideo, operationId: string) {
  const routing = getExecutionRouting(body.site_id);
  if (routing?.payer !== 'customer' || !/^[A-Za-z0-9:_-]{1,128}$/.test(operationId)) {
    throw new CustomerRoutingError('CUSTOMER_VIDEO_OPERATION_REQUIRED');
  }
  const operationKey = `video:${operationId}`;
  const index = `ai-video:customer-operation:${await sha256(`${body.site_id}:${operationKey}`)}`;
  const fingerprint = await sha256(JSON.stringify({ prepared, instance: body.instance_id, routing }));
  const durable = await loadCustomerVideoJob(body.site_id, { operationKey });
  if (durable) {
    if (durable.fingerprint !== fingerprint) throw new MediaRequestError('Video operation conflicts', 409);
    return result(durable);
  }
  const previousId = await getCachedJson<string>(index);
  if (previousId) {
    const previous = await getCachedJson<CustomerVideoJob>(key(previousId));
    if (!previous || previous.siteId !== body.site_id || previous.fingerprint !== fingerprint) {
      throw new MediaRequestError('Video operation conflicts or requires reconciliation', 409);
    }
    return result(previous);
  }
  const job: CustomerVideoJob = { id: randomUUID(), eventId: randomUUID(), siteId: body.site_id,
    instanceId: body.instance_id, routing, operationKey, fingerprint, request: prepared,
    createdAt: new Date().toISOString(), status: 'pending',
    error: 'Video submission outcome uncertain; retain job_id and retry status only' };
  await save(job);
  if (!await setCachedJson(index, job.id, TTL) || await getCachedJson(index) !== job.id) {
    throw new MediaRequestError('Video admission persistence unavailable', 503);
  }
  try {
    // Durable SQL claim precedes the only paid POST; cache expiry never permits replay.
    const upstream = await customerVideoJob(prepared, { eventId: job.eventId, operationKey });
    job.upstreamId = upstream.id; job.generationId = upstream.generation_id; job.cost = upstream.usage?.cost;
    job.status = upstream.status === 'pending' ? 'pending' : 'in_progress';
    delete job.error;
    if (upstream.status === 'failed' || upstream.status === 'completed') job.settlement = videoSettlement(job, upstream.status);
    await save(job);
  } catch {
    // A failed ACK can still mean the checkpoint committed. Never overwrite it with a stale snapshot.
    const durable = await loadCustomerVideoJob(job.siteId, { id: job.id });
    if (durable) return result(durable);
  }
  return result(job);
}

/** Restore the original pin, never today's site selection or a request JSON payer. */
export async function resumeCustomerVideoJob(job: CustomerVideoJob) {
  // Site authorization is performed by the HTTP boundary. Durable reads/settlement need no provider key.
  if (job.status === 'completed' || job.status === 'failed' || !job.upstreamId) return result(job);
  if (!job.settlement) {
    const upstream = await withExecutionRouting(job.routing, job.siteId, () => customerVideoJob(job.upstreamId!));
    job.generationId = upstream.generation_id ?? job.generationId;
    job.cost = upstream.usage?.cost ?? job.cost;
    if (upstream.status !== 'completed' && upstream.status !== 'failed') {
      if (job.status !== 'in_progress') job.status = upstream.status;
      await save(job); return result(job);
    }
    job.status = 'in_progress';
    job.settlement = videoSettlement(job, upstream.status);
    // Later provider evidence must be reconciled separately, never substituted into this receipt.
    await save(job);
  }
  if (job.settlement.status === 'completed') {
    if (!job.videos?.length) {
      const downloaded = await withExecutionRouting(job.routing, job.siteId, () => downloadCustomerVideo(job.upstreamId!));
      job.videos = [await persistCustomerVideo({ ...downloaded, eventId: job.eventId, siteId: job.siteId, instanceId: job.instanceId,
        prompt: job.request.prompt, model: job.request.model,
        metadata: { job_id: job.id, payer: 'customer', receipt_event_id: job.eventId,
          execution_routing: job.routing, generation_id: job.generationId,
          ...(job.routing.payer === 'customer' ? { connection_id: job.routing.connectionId,
            policy_version: job.routing.policyVersion, credential_version: job.routing.credentialVersion } : {}) } })];
      await save(job);
    }
  }
  await deliverVideoSettlement(job);
  job.status = job.settlement.status;
  if (job.status === 'failed') job.error = 'Customer video generation failed';
  else delete job.error;
  await save(job);
  return result(job);
}