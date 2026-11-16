import { randomUUID } from 'node:crypto';
import { getCachedJson, setCachedJson, sha256 } from '@/lib/security/upstash-rest';
import { CreditService } from '@/lib/services/billing/CreditService';
import { MediaRequestError } from '@/lib/services/image/openrouter-media';
import { downloadOpenRouterVideo, pollOpenRouterVideo, type PreparedVideo } from './provider-openrouter';
import { downloadGeminiVideo, pollGeminiVideo, submitGeminiVideo, type GeminiPreparedVideo } from './provider-gemini';
import { persistGeneratedVideo } from './video-storage';
import type { VideoGenerationResult, VideoRequestBody } from './video-types';
import { recordTelemetry } from '@/lib/status/telemetry';
import { getVideoObservationKey } from '@/lib/status/handlers/ai/passive-probes';
import { assertPlatformInference } from '@/lib/services/ai/customer-routing';
import { resumeCustomerVideoJob, type CustomerVideoJob } from './customer-video-jobs';
import { loadCustomerVideoJob } from './customer-video-store';
import { routingStorageEnabled } from '@/lib/integrations/openrouter/types';

// Records survive request timeouts/restarts. All functions run under the site's
// fail-closed distributed lock in route.ts. Never use process-local job ownership.
const RETENTION_SECONDS = 7 * 24 * 60 * 60;
interface Job {
  // Untagged records are legacy OpenRouter jobs: resume only, never resubmit.
  provider?: 'gemini' | 'openrouter';
  id: string;
  siteId: string;
  instanceId?: string;
  fingerprint: string;
  upstreamId?: string;
  request: PreparedVideo | GeminiPreparedVideo;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: string;
  billingStarted?: boolean;
  billed?: boolean;
  error?: string;
  submissionRejected?: boolean;
  videos?: VideoGenerationResult['videos'];
  generationId?: string;
  cost?: number;
}
const jobKey = (id: string) => `ai-video:job:${id}`;
const activeKey = (site: string) => `ai-video:active:${site}`;

async function observeVideo(model: string, status: 'up' | 'down' | 'degraded', label: string, start: number, provider: 'gemini' | 'openrouter' = 'gemini') {
  await recordTelemetry(getVideoObservationKey(model, provider), status, label, Date.now() - start).catch(() => {});
}

function customerSubmissionError(error: unknown, model: string): boolean {
  if (!(error instanceof MediaRequestError)) return false;
  // The media wrapper retains HTTP status only in this fixed message; never inspect raw provider bodies.
  const httpStatus = /^Gemini video request failed \((\d{3})\)$/.exec(error.message)?.[1];
  // A received client rejection is not an ambiguous transport outcome. Do not
  // strand site admission after bad credentials, permissions or exhausted quota.
  const rejectedStatuses = [400, 401, 402, 403, 404, 422, 429];
  return (httpStatus !== undefined && rejectedStatuses.includes(Number(httpStatus)))
    || [400, 401, 402, 403, 422, 429].includes(error.status)
    || ((httpStatus === '404' || error.status === 404) && model !== (process.env.GEMINI_VIDEO_MODEL?.trim() || 'gemini-omni-1.2-flash'))
    || error.message === 'Gemini video is not configured: set GEMINI_API_KEY'
    || error.message === 'Gemini video generation is not configured';
}

async function save(job: Job) {
  if (!await setCachedJson(jobKey(job.id), job, RETENTION_SECONDS)) {
    throw new MediaRequestError('Video job persistence unavailable; retain job_id and retry status only', 503);
  }
  // setCachedJson historically returns true if unconfigured. Require read-back.
  const stored = await getCachedJson<Job>(jobKey(job.id));
  if (!stored || JSON.stringify(stored) !== JSON.stringify(job)) {
    throw new MediaRequestError('Video job persistence unavailable; retain job_id and retry status only', 503);
  }
}

function result(job: Job): VideoGenerationResult {
  return {
    provider: job.provider ?? 'openrouter', job_id: job.id, status: job.status,
    videos: job.billed ? job.videos || [] : [],
    ...(job.error ? { error: job.error } : {}),
    ...(job.provider === 'gemini' && job.status === 'failed' && job.submissionRejected === true && !job.upstreamId
      ? { submission_rejected: true } : {}),
    metadata: {
      model: job.request.model, duration_seconds: job.request.duration,
      aspect_ratio: job.request.aspect_ratio as VideoRequestBody['aspect_ratio'],
      resolution: job.request.resolution, generated_at: job.createdAt,
      generation_id: job.generationId, cost: job.cost,
    },
  };
}

export async function startVideoJob(body: VideoRequestBody, prepared: GeminiPreparedVideo): Promise<VideoGenerationResult> {
  assertPlatformInference('video');
  if (body.provider !== undefined && body.provider !== 'gemini') {
    throw new MediaRequestError('OpenRouter video requires authorized customer BYOK routing', 400);
  }
  const fingerprint = await sha256(JSON.stringify({ prepared, instance: body.instance_id }));
  const active = await getCachedJson<string>(activeKey(body.site_id));
  if (active) {
    const previous = await getCachedJson<Job>(jobKey(active));
    if (!previous) throw new MediaRequestError('Active video job unavailable; retry status later', 503);
    if (previous.fingerprint === fingerprint && !previous.submissionRejected) return result(previous);
    if (previous.status !== 'completed' && previous.status !== 'failed') {
      if (previous.fingerprint !== fingerprint) throw new MediaRequestError('Another video job is already running for this site', 409);
      return result(previous);
    }
  }
  const job: Job = {
    provider: 'gemini', id: randomUUID(), siteId: body.site_id, instanceId: body.instance_id,
    // Input image bytes are only needed for this one submit, not for polling.
    // Never persist multi-megabyte inline images in the job cache.
    fingerprint, request: { model: prepared.model, prompt: prepared.prompt, duration: prepared.duration,
      aspect_ratio: prepared.aspect_ratio, resolution: prepared.resolution },
    status: 'pending', createdAt: new Date().toISOString(),
    error: 'Video submission outcome uncertain; retain job_id and contact support before resubmitting',
  };
  await save(job);
  if (!await setCachedJson(activeKey(body.site_id), job.id, RETENTION_SECONDS)
    || await getCachedJson<string>(activeKey(body.site_id)) !== job.id) {
    throw new MediaRequestError('Video job admission persistence unavailable', 503);
  }
  const start = Date.now();
  let upstreamFailed = false;
  try {
    const submitted = await submitGeminiVideo(prepared);
    job.upstreamId = submitted.id;
    delete job.error;
    job.status = submitted.status === 'completed' ? 'in_progress' : submitted.status;
    upstreamFailed = submitted.status === 'failed';
    if (upstreamFailed) job.error = 'Gemini video generation failed';
    await save(job);
    if (upstreamFailed) await observeVideo(prepared.model, 'down', 'Video upstream generation failed', start);
  } catch (error) {
    // Keep pending ownership: never retry an ambiguous POST or create another paid job.
    job.error = 'Video submission outcome uncertain; retain job_id and contact support before resubmitting';
    const rejected = customerSubmissionError(error, prepared.model);
    if (rejected) {
      job.status = 'failed';
      job.submissionRejected = true;
      job.error = 'Gemini rejected the video request or configuration; correct it before submitting a new job';
    }
    await save(job).catch(() => undefined);
    if (!rejected) {
      await observeVideo(prepared.model, upstreamFailed ? 'down' : 'degraded',
        upstreamFailed ? 'Video upstream generation failed' : 'Video submission completion is uncertain', start);
    }
  }
  return result(job);
}

export async function resumeVideoJob(siteId: string, id: string): Promise<VideoGenerationResult> {
  const start = Date.now();
  const cached = await getCachedJson<Job | CustomerVideoJob>(jobKey(id));
  const stored = cached && !('routing' in cached) ? cached
    : cached || routingStorageEnabled() ? await loadCustomerVideoJob(siteId, { id }) : null;
  if (!stored || stored.siteId !== siteId) throw new MediaRequestError('Video job not found', 404);
  if ('routing' in stored) return resumeCustomerVideoJob(stored);
  assertPlatformInference('video');
  const job = stored;
  if (!job || job.siteId !== siteId) throw new MediaRequestError('Video job not found', 404);
  if (job.status === 'completed' || job.status === 'failed' || !job.upstreamId) return result(job);
  if (job.billingStarted && !job.billed) {
    return { ...result(job), error: 'Video billing outcome requires reconciliation; do not resubmit' };
  }
  const provider = job.provider ?? 'openrouter';
  const upstream = provider === 'gemini'
    ? await pollGeminiVideo(job.upstreamId) : await pollOpenRouterVideo(job.upstreamId);
  job.generationId = upstream.generation_id;
  job.cost = upstream.usage?.cost;
  if (upstream.status === 'failed') {
    job.status = 'failed'; job.error = `${provider === 'gemini' ? 'Gemini' : 'OpenRouter'} video generation failed`;
    await observeVideo(job.request.model, 'down', 'Video upstream generation failed', start, provider);
    await save(job);
    return result(job);
  }
  if (upstream.status !== 'completed') {
    job.status = upstream.status;
    await save(job);
    return result(job);
  }
  if (!job.videos?.length) {
    try {
      const downloaded = provider === 'gemini'
        ? await downloadGeminiVideo(job.upstreamId) : await downloadOpenRouterVideo(job.upstreamId);
      job.videos = [await persistGeneratedVideo({
        ...downloaded, siteId, instanceId: job.instanceId, prompt: job.request.prompt,
        model: job.request.model, provider,
        metadata: {
          job_id: job.id, generation_id: job.generationId, cost: job.cost,
          duration_seconds: job.request.duration, aspect_ratio: job.request.aspect_ratio, resolution: job.request.resolution,
        },
      })];
      await save(job);
    } catch (error) {
      await observeVideo(job.request.model, 'down', 'Video completion failed during download or persistence', start, provider);
      throw error;
    }
  }
  // Existing billing RPC has no idempotency key. Persist intent first, and refuse
  // automatic re-deduction after a crash/uncertain RPC outcome. Reconcile manually.
  job.billingStarted = true;
  await save(job);
  const deduction = await CreditService.deductCredits(
    siteId, (job.request.duration / 60) * CreditService.PRICING.VIDEO_GENERATION_MINUTE,
    'video_generation', `${provider === 'gemini' ? 'Gemini' : 'OpenRouter'} video generation`, {
      job_id: job.id, provider, model: job.request.model,
      generation_id: job.generationId, cost: job.cost,
    },
  );
  if (!deduction.success) {
    job.error = 'Video billing requires reconciliation; do not resubmit';
    await save(job);
    return result(job);
  }
  job.billed = true; job.status = 'completed'; delete job.error;
  await save(job);
  await observeVideo(job.request.model, 'up', 'Video generation completed with persistence and billing', start, provider);
  return result(job);
}