import { supabaseAdmin } from '@/lib/database/supabase-client';
import { recordTelemetry } from '@/lib/status/telemetry';
import { CATALOG_INDEX_QUEUE_MESSAGES, CATALOG_INDEX_QUEUE_TELEMETRY } from '@/lib/status/catalog-index-evidence';

async function findExhaustedJobs() {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = supabaseAdmin.from('catalog_embedding_jobs')
      .select('status').eq('status', 'exhausted').limit(1).abortSignal(controller.signal);
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => { resolve(null); controller.abort(); }, 1_500);
    });
    return await Promise.race([query, timeout]);
  } finally { clearTimeout(timer); }
}

/** Called only after the enabled catalog cron verifies its secret. Observes, never revives, jobs. */
export async function observeCatalogIndexQueue(): Promise<void> {
  const start = Date.now();
  let evidence: 'clear' | 'exhausted' | 'unavailable' = 'unavailable';
  try {
    const sample = await findExhaustedJobs();
    if (sample && !sample.error && Array.isArray(sample.data)) {
      if (sample.data.length === 0) evidence = 'clear';
      else if (sample.data.length === 1 && sample.data[0]?.status === 'exhausted') evidence = 'exhausted';
    }
  } catch { /* An unavailable read is not an empty queue. */ }

  if (evidence !== 'clear') {
    // Fixed reason for production log alerts; no rows, site IDs, or credentials.
    console.warn(`[Catalog index queue] ${evidence}`);
  }
  await recordTelemetry(CATALOG_INDEX_QUEUE_TELEMETRY, evidence === 'clear' ? 'up' : 'degraded',
    CATALOG_INDEX_QUEUE_MESSAGES[evidence], Date.now() - start);
}