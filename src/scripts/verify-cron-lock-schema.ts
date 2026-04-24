/**
 * Verifies that PostgREST (Supabase API) can read lock columns on `requirements`.
 * Run from repo root: npx tsx src/scripts/verify-cron-lock-schema.ts
 *
 * If this passes locally but Vercel logs still show 42703, the deployment uses
 * a different NEXT_PUBLIC_SUPABASE_URL / project than this machine's .env.local.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
config({ path: join(root, '.env.local') });
config({ path: join(root, '.env') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid';
  }
}

async function main() {
  if (!supabaseUrl || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env / .env.local');
    process.exit(1);
  }

  const host = hostOf(supabaseUrl);
  console.log('Using Supabase host:', host);
  console.log('(Match this in Vercel → Project → Settings → Environment Variables for the same deployment that runs the cron.)\n');

  const supabase = createClient(supabaseUrl, key);

  const { data, error } = await supabase
    .from('requirements')
    .select('id, cron_lock_expires_at, cron_lock_run_id')
    .limit(1);

  if (error) {
    console.error('PostgREST / Postgres error (same path as acquireRunLock update body):');
    console.error('  code:', error.code);
    console.error('  message:', error.message);
    if (error.code === '42703' || /cron_lock_/.test(error.message || '')) {
      console.error(`
Likely causes:
  1) This URL points at a different Supabase project than where you added the columns.
  2) Columns exist in SQL Editor but PostgREST cache is stale → Dashboard → API → Reload schema cache
     or: NOTIFY pgrst, 'reload schema';

Run in Supabase SQL (same project as URL above / host ${host}):

  select column_name
  from information_schema.columns
  where table_schema = 'public' and table_name = 'requirements'
    and column_name in ('cron_lock_expires_at','cron_lock_run_id');
`);
    }
    process.exit(1);
  }

  console.log('OK: columns visible to PostgREST. Sample row (may be null):', data?.[0] ?? '(no rows)');
  process.exit(0);
}

main();
