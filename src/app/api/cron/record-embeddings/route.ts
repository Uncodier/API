import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { processRecordEmbeddingsById } from '@/lib/services/record-embedding-worker';

const MAX_RECORDS_PER_RUN = 3;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

type QueueJobRow = {
  record_id: string;
  status: 'pending' | 'failed' | 'processing';
  claimed_at: string | null;
};

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (
    !cronSecret
    || request.headers.get('authorization') !== `Bearer ${cronSecret}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { data: jobs, error } = await supabaseAdmin
      .from('record_embedding_jobs')
      .select('record_id, status, claimed_at')
      .in('status', ['pending', 'failed', 'processing'])
      .lt('attempts', 5)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) throw error;

    const staleBefore = Date.now() - STALE_PROCESSING_MS;
    const queueJobs = (jobs || []) as QueueJobRow[];
    const recordIds = Array.from(new Set(
      queueJobs
        .filter((job) =>
          job.status !== 'processing'
          || !job.claimed_at
          || new Date(job.claimed_at).getTime() < staleBefore
        )
        .map((job) => job.record_id),
    )).slice(0, MAX_RECORDS_PER_RUN);

    const results = await Promise.allSettled(
      recordIds.map((recordId) => processRecordEmbeddingsById({ recordId })),
    );
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [{
            recordId: recordIds[index],
            error: result.reason instanceof Error
              ? result.reason.message
              : 'Embedding failed',
          }]
        : [],
    );

    return NextResponse.json(
      {
        success: failures.length === 0,
        processed: results.length - failures.length,
        failed: failures,
      },
      {
        status: failures.length === results.length && results.length > 0
          ? 500
          : 200,
      },
    );
  } catch (error) {
    console.error('[record embedding cron]', error);
    return NextResponse.json(
      {
        error: error instanceof Error
          ? error.message
          : 'Cron processing failed',
      },
      { status: 500 },
    );
  }
}
