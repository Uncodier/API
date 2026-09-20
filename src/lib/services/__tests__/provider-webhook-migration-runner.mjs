import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();

async function claim(eventId) {
  return db.query(
    `SELECT public.claim_provider_webhook_event(
      'test-provider',
      $1,
      'test.event',
      $2::uuid,
      300
    ) AS claim`,
    [eventId, randomUUID()],
  );
}

try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE TABLE public.payments (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      transaction_id text
    );
  `);
  for (const migration of [
    'supabase/migrations/20260920005000_add_provider_webhook_event_claims.sql',
    'supabase/migrations/20260920007000_fix_provider_webhook_claims.sql',
  ]) {
    await db.exec(readFileSync(resolve(process.cwd(), migration), 'utf8'));
  }

  const retryEventId = `evt-retry-${randomUUID()}`;
  const retryToken = randomUUID();
  await db.query(
    `SELECT public.claim_provider_webhook_event(
      'test-provider',
      $1,
      'test.event',
      $2::uuid,
      300
    )`,
    [retryEventId, retryToken],
  );
  await db.query(
    `SELECT public.finish_provider_webhook_event(
      'test-provider',
      $1,
      $2::uuid,
      'failed',
      'retry me'
    )`,
    [retryEventId, retryToken],
  );
  const retry = await claim(retryEventId);
  const stored = await db.query(
    `SELECT claim_expires_at
     FROM private.provider_webhook_events
     WHERE provider = 'test-provider' AND event_id = $1`,
    [retryEventId],
  );

  const strandedEventId = `evt-stranded-${randomUUID()}`;
  await db.query(
    `INSERT INTO private.provider_webhook_events (
       provider,
       event_id,
       event_type,
       status,
       claim_token,
       attempt_count,
       claimed_at,
       claim_expires_at
     )
     VALUES (
       'test-provider',
       $1,
       'test.event',
       'processing',
       $2::uuid,
       1,
       now(),
       NULL
     )`,
    [strandedEventId, randomUUID()],
  );
  const strandedRetry = await claim(strandedEventId);

  const concurrentEventId = `evt-concurrent-${randomUUID()}`;
  const concurrent = await Promise.all([
    claim(concurrentEventId),
    claim(concurrentEventId),
  ]);

  await db.query(
    `INSERT INTO public.payments (transaction_id)
     VALUES ('txn_123')
     ON CONFLICT (transaction_id) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO public.payments (transaction_id)
     VALUES ('txn_123')
     ON CONFLICT (transaction_id) DO NOTHING`,
  );
  const payments = await db.query(
    `SELECT count(*)::integer AS count
     FROM public.payments
     WHERE transaction_id = 'txn_123'`,
  );

  process.stdout.write(JSON.stringify({
    retryClaim: retry.rows[0].claim,
    storedExpiry: stored.rows[0].claim_expires_at,
    strandedRetryClaim: strandedRetry.rows[0].claim,
    concurrentStates: concurrent
      .map((result) => result.rows[0].claim.state)
      .sort(),
    paymentCount: payments.rows[0].count,
  }));
} finally {
  await db.close();
}
