import type { VideoRequestBody, VideoGenerationResult as ApiResult, VideoAspectRatio } from '@/app/api/ai/video/video-types';
import { randomUUID } from 'node:crypto';
import { getExecutionRouting, getCustomerOperationKey, type ExecutionRoutingReference } from '@/lib/services/ai/customer-routing';
import { executionRoutingHeaders } from '@/lib/services/ai/customer-routing-http';

export type AspectRatio = VideoAspectRatio;
export type VideoQuality = 'preview' | 'standard' | 'pro';
export type VideoGenerationParams = VideoRequestBody & { executionRouting?: ExecutionRoutingReference; operationId?: string };
export interface VideoGenerationResult extends Omit<ApiResult, 'metadata'> {
  success: boolean;
  fallbackFrom?: string;
  metadata?: ApiResult['metadata'];
}

/** Async-first wrapper. Pending success means accepted, never a completed video. */
export class VideoGenerationService {
  static async generateVideo(params: VideoGenerationParams): Promise<VideoGenerationResult> {
    if (params.provider !== undefined && params.provider !== 'openrouter') {
      return { success: false, provider: 'openrouter', videos: [], error: 'Unsupported video provider' };
    }
    if (params.job_id) return this.getVideoJob(params.site_id, params.job_id);
    return this.call({ ...params, provider: params.provider ?? 'openrouter' });
  }

  static async getVideoJob(siteId: string, jobId: string): Promise<VideoGenerationResult> {
    return this.call({ site_id: siteId, job_id: jobId, prompt: '', provider: 'openrouter' });
  }

  private static async call(params: VideoGenerationParams): Promise<VideoGenerationResult> {
    const provider = params.provider ?? 'openrouter';
    const url = new URL('/api/ai/video', process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:3000');
    if (params.job_id) {
      url.searchParams.set('site_id', params.site_id);
      url.searchParams.set('job_id', params.job_id);
    }
    try {
      const routing = params.executionRouting ?? getExecutionRouting(params.site_id);
      const stableOperation = params.operationId ?? getCustomerOperationKey();
      if (routing?.payer === 'customer' && !params.job_id && !stableOperation) {
        return { success: false, provider, videos: [], error: 'Customer video generation requires a stable operationId' };
      }
      const operationId = stableOperation ?? randomUUID();
      const { executionRouting: _routing, operationId: _operation, ...body } = params;
      const response = await fetch(url, {
        method: params.job_id ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.SERVICE_API_KEY || '',
          'Idempotency-Key': operationId,
          ...(routing ? await executionRoutingHeaders(routing, { path: url.pathname, operationId }) : {}) },
        body: params.job_id ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        return { success: false, provider, videos: [], job_id: params.job_id, error: `Video API request failed (${response.status}); retry status only if a job_id exists` };
      }
      const data = await response.json() as ApiResult;
      return {
        ...data,
        success: data.status !== 'failed' && !data.error
          && (data.status === 'pending' || data.status === 'in_progress' || Boolean(data.videos?.length)),
      };
    } catch {
      return { success: false, provider, videos: [], job_id: params.job_id, error: 'Video API request failed or timed out; do not resubmit an uncertain generation' };
    }
  }
}