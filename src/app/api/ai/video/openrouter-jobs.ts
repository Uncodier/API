import { randomUUID } from 'node:crypto';
import { getCachedJson, setCachedJson, sha256 } from '@/lib/security/upstash-rest';
import { CreditService } from '@/lib/services/billing/CreditService';
import { MediaRequestError } from '@/lib/services/image/openrouter-media';
import { downloadOpenRouterVideo, pollOpenRouterVideo, submitOpenRouterVideo, type PreparedVideo } from './provider-openrouter';
import { persistGeneratedVideo } from './video-storage';
import type { VideoGenerationResult, VideoRequestBody } from './video-types';

// Records survive request timeouts/restarts. All functions run under the site's
// fail-closed distributed lock in route.ts. Never use process-local job ownership.
const RETENTION_SECONDS = 7 * 24 * 60 * 60;
interface Job {
  id: string;
  siteId: string;
  instanceId?: string;
  fingerprint: string;
  upstreamId?: string;
  request: PreparedVideo;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: string;
  billingStarted?: boolean;
  billed?: boolean;
  error?: string;
  videos?: VideoGenerationResult['videos'];
  generationId?: string;
  cost?: number;
}
const jobKey = (id: string) => `ai-video:job:${id}`;
const activeKey = (site: string) => `ai-video:active:${site}`;

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
    provider: 'openrouter', job_id: job.id, status: job.status,
    videos: job.billed ? job.videos || [] : [],
    ...(job.error ? { error: job.error } : {}),
    metadata: {
      model: job.request.model, duration_seconds: job.request.duration,
      aspect_ratio: job.request.aspect_ratio as VideoRequestBody['aspect_ratio'],
      resolution: job.request.resolution, generated_at: job.createdAt,
      generation_id: job.generationId, cost: job.cost,
    },
  };
}

export async function startVideoJob(body: VideoRequestBody, prepared: PreparedVideo): Promise<VideoGenerationResult> {
  const fingerprint = await sha256(JSON.stringify({ prepared, instance: body.instance_id }));
  const active = await getCachedJson<string>(activeKey(body.site_id));
  if (active) {
    const previous = await getCachedJson<Job>(jobKey(active));
    if (!previous) throw new MediaRequestError('Active video job unavailable; retry status later', 503);
    if (previous.fingerprint === fingerprint) return result(previous);
    if (previous.status !== 'completed' && previous.status !== 'failed') {
      if (previous.fingerprint !== fingerprint) throw new MediaRequestError('Another video job is already running for this site', 409);
      return result(previous);
    }
  }
  const job: Job = {
    id: randomUUID(), siteId: body.site_id, instanceId: body.instance_id,
    fingerprint, request: prepared, status: 'pending', createdAt: new Date().toISOString(),
    error: 'Video submission outcome uncertain; retain job_id and contact support before resubmitting',
  };
  await save(job);
  if (!await setCachedJson(activeKey(body.site_id), job.id, RETENTION_SECONDS)
    || await getCachedJson<string>(activeKey(body.site_id)) !== job.id) {
    throw new MediaRequestError('Video job admission persistence unavailable', 503);
  }
  try {
    const submitted = await submitOpenRouterVideo(prepared);
    job.upstreamId = submitted.id;
    delete job.error;
    job.status = submitted.status === 'completed' ? 'in_progress' : submitted.status;
    if (submitted.status === 'failed') job.error = 'OpenRouter video generation failed';
    await save(job);
  } catch {
    // Keep pending ownership: never retry an ambiguous POST or create another paid job.
    job.error = 'Video submission outcome uncertain; retain job_id and contact support before resubmitting';
    await save(job).catch(() => undefined);
  }
  return result(job);
}

export async function resumeVideoJob(siteId: string, id: string): Promise<VideoGenerationResult> {
  const job = await getCachedJson<Job>(jobKey(id));
  if (!job || job.siteId !== siteId) throw new MediaRequestError('Video job not found', 404);
  if (job.status === 'completed' || job.status === 'failed' || !job.upstreamId) return result(job);
  if (job.billingStarted && !job.billed) {
    return { ...result(job), error: 'Video billing outcome requires reconciliation; do not resubmit' };
  }
  const upstream = await pollOpenRouterVideo(job.upstreamId);
  job.generationId = upstream.generation_id;
  job.cost = upstream.usage?.cost;
  if (upstream.status === 'failed') {
    job.status = 'failed'; job.error = 'OpenRouter video generation failed';
    await save(job);
    return result(job);
  }
  if (upstream.status !== 'completed') {
    job.status = upstream.status;
    await save(job);
    return result(job);
  }
  if (!job.videos?.length) {
    const downloaded = await downloadOpenRouterVideo(job.upstreamId);
    job.videos = [await persistGeneratedVideo({
      ...downloaded, siteId, instanceId: job.instanceId, prompt: job.request.prompt,
      model: job.request.model, provider: 'openrouter',
      metadata: {
        job_id: job.id, generation_id: job.generationId, cost: job.cost,
        duration_seconds: job.request.duration, aspect_ratio: job.request.aspect_ratio, resolution: job.request.resolution,
      },
    })];
    await save(job);
  }
  // Existing billing RPC has no idempotency key. Persist intent first, and refuse
  // automatic re-deduction after a crash/uncertain RPC outcome. Reconcile manually.
  job.billingStarted = true;
  await save(job);
  const deduction = await CreditService.deductCredits(
    siteId, (job.request.duration / 60) * CreditService.PRICING.VIDEO_GENERATION_MINUTE,
    'video_generation', 'OpenRouter video generation', {
      job_id: job.id, provider: 'openrouter', model: job.request.model,
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
  return result(job);
}