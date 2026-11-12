import { supabaseAdmin } from '@/lib/database/supabase-client';
import { MediaRequestError } from '@/lib/services/image/media-request-error';
import type { CustomerVideoJob } from './customer-video-jobs';

export async function saveCustomerVideoJob(job: CustomerVideoJob) {
  const { data, error } = await supabaseAdmin.rpc('openrouter_customer_video_save', { p_job: job });
  if (error || !data || data.id !== job.id || data.eventId !== job.eventId || data.status !== job.status
      || data.upstreamId !== job.upstreamId || !Number.isSafeInteger(data.version)) {
    throw new MediaRequestError('Durable video persistence unavailable; retry status only', 503);
  }
  job.version = data.version;
}

export async function loadCustomerVideoJob(siteId: string, lookup: { id: string } | { operationKey: string }): Promise<CustomerVideoJob | null> {
  const { data, error } = await supabaseAdmin.rpc('openrouter_customer_video_load', {
    p_site_id: siteId, p_job_id: 'id' in lookup ? lookup.id : null,
    p_operation_key: 'operationKey' in lookup ? lookup.operationKey : null,
  });
  if (error) throw new MediaRequestError('Durable video status unavailable; retry status only', 503);
  if (!data) return null;
  if (data.siteId !== siteId || data.routing?.payer !== 'customer' || data.routing.siteId !== siteId
      || ('id' in lookup ? data.id !== lookup.id : data.operationKey !== lookup.operationKey)) {
    throw new MediaRequestError('Durable video ownership mismatch', 403);
  }
  return data as CustomerVideoJob;
}