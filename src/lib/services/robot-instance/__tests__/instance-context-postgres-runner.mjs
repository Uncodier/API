import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const site = id(1), other = id(2), instance = id(3), user = id(4);
const at = '2026-09-25T12:00:00Z';
function assert(value, label) { if (!value) throw new Error(label); }
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('test.user_id', true), '')::uuid
    $$;
    CREATE TABLE public.sites (id uuid PRIMARY KEY, user_id uuid NOT NULL);
    CREATE TABLE public.remote_instances (id uuid PRIMARY KEY, site_id uuid NOT NULL);
    CREATE TABLE public.instance_logs (id uuid PRIMARY KEY, instance_id uuid NOT NULL,
      site_id uuid NOT NULL, log_type text NOT NULL, created_at timestamptz NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE FUNCTION public.current_user_site_role(p_site_id uuid) RETURNS text LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN EXISTS(SELECT 1 FROM public.sites WHERE id=p_site_id AND user_id=auth.uid())
        THEN 'owner' ELSE NULL END
    $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
    GRANT SELECT ON public.sites, public.remote_instances TO authenticated;
    GRANT EXECUTE ON FUNCTION public.current_user_site_role(uuid) TO authenticated;
  `);
  // PGlite does not ship pgvector; replace only its storage/search syntax.
  const migration = readFileSync('supabase/migrations/20260926000000_instance_context_memory.sql', 'utf8')
    .replace(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g, '')
    .replace(/DO \$\$ DECLARE v_schema text; BEGIN[\s\S]*?END \$\$;/, '')
    .replaceAll('vector(1536)', 'text')
    .replaceAll(',vector)', ',text)')
    .replaceAll(',vector,integer)', ',text,integer)')
    .replace(/CREATE INDEX instance_context_memories_vector_idx\s+ON public\.instance_context_memories USING hnsw \(embedding vector_cosine_ops\);/i, '')
    .replaceAll('m.embedding <=> p_embedding', '0::float');
  await db.exec(migration);
  const reserveMigration = readFileSync(
    'supabase/migrations/20260926030000_instance_context_output_reserve.sql', 'utf8'
  );
  await db.query('INSERT INTO sites VALUES ($1,$2),($3,$2)', [site,user,other]);
  await db.query('INSERT INTO remote_instances VALUES ($1,$2)', [instance,site]);
  await db.query('SELECT public.record_instance_context_usage($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [instance,site,'legacy-model','azure',200,40,4000,'estimate',at]);
  await db.exec(reserveMigration);
  const legacyReserve = (await db.query('SELECT reserved_output_tokens FROM instance_context_state WHERE instance_id=$1',[instance])).rows[0];
  assert(legacyReserve.reserved_output_tokens === null, 'old measurement was misrepresented as a verified zero reserve');
  const repair = readFileSync(
    'supabase/migrations/20260926040000_instance_context_output_tokens_repair.sql', 'utf8'
  );
  await db.exec(repair);
  await db.exec(repair);
  const breakdownMigration = readFileSync(
    'supabase/migrations/20260926050000_instance_context_input_breakdown.sql', 'utf8'
  );
  await db.exec(breakdownMigration);
  const compatibility = readFileSync(
    'supabase/migrations/20260926060000_instance_context_unknown_output_and_legacy_reserve.sql', 'utf8'
  );
  await db.exec(compatibility);
  await db.exec(compatibility);
  const repaired = (await db.query('SELECT output_tokens FROM instance_context_state WHERE instance_id=$1',[instance])).rows[0];
  assert(repaired.output_tokens === 40, 'repair changed existing output usage');
  for (let n=1;n<=4;n++) await db.query('INSERT INTO instance_logs VALUES ($1,$2,$3,$4,$5,$6)',
    [id(n+10),instance,site,n===2?'tool_call':'agent_action',at,JSON.stringify(n===4?{status:'queued'}:{})]);
  const commit = async (ids, end, expected=null, cursorId=null) => (await db.query(
    'SELECT public.commit_instance_context_memory($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS committed',
    [instance,site,expected,cursorId,at,at,id(end+10),ids.map(x=>id(x+10)),`Summary through ${end}`,'[0.1,0.2]'])).rows[0].committed;
  assert(await commit([1,3],3) === false, 'gapped segment accepted');
  assert(await commit([1,2,3,4],4) === false, 'queued action accepted');
  assert(await commit([1,2,3],3) === true, 'same timestamp contiguous segment rejected');
  assert(await commit([1,2,3],3) === false, 'concurrent/replayed cursor accepted');
  const state = (await db.query('SELECT cursor_log_id,revision FROM instance_context_state WHERE instance_id=$1',[instance])).rows[0];
  assert(state.cursor_log_id === id(13) && Number(state.revision) === 1, 'cursor revision changed unexpectedly');
  await db.query('UPDATE instance_logs SET details=$1 WHERE id=$2',[JSON.stringify({}),id(14)]);
  assert(await commit([4],4,at,id(13)) === true, 'next same-timestamp segment rejected');
  await db.query('SELECT public.record_instance_context_usage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [instance,site,'test-model','azure',800,120,4000,1024,'estimate',at]);
  const signatures = (await db.query("SELECT count(*)::integer AS count FROM pg_proc WHERE proname = 'record_instance_context_usage'")).rows[0].count;
  assert(signatures === 3, 'rolling deploy lost a legacy usage RPC signature');
  const status = (await db.query('SELECT cursor_log_id, revision, reserved_output_tokens FROM instance_context_state WHERE instance_id=$1',[instance])).rows[0];
  assert(status.cursor_log_id === id(14) && Number(status.revision) === 2, 'metric update changed cursor');
  assert(status.reserved_output_tokens === 1024, 'model-specific output reserve was not persisted');
  // A new legacy writer must not carry that Azure reserve into a Gemini turn.
  await db.query('SELECT public.record_instance_context_usage($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [instance,site,'gemini-3.1-pro-preview','gemini',800,null,1048576,'estimate',at]);
  const legacyWritten = (await db.query('SELECT reserved_output_tokens,output_tokens FROM instance_context_state WHERE instance_id=$1',
    [instance])).rows[0];
  assert(legacyWritten.reserved_output_tokens === null && legacyWritten.output_tokens === null,
    'legacy RPC retained a reserve or invented completion usage');
  await db.query('SELECT public.record_instance_context_usage($1,$2,$3,$4,$5,$6,$7,$8)',
    [instance,site,'oldest-writer','gemini',800,1048576,'estimate',at]);
  const oldestWritten = (await db.query('SELECT reserved_output_tokens,output_tokens FROM instance_context_state WHERE instance_id=$1',
    [instance])).rows[0];
  assert(oldestWritten.reserved_output_tokens === null && oldestWritten.output_tokens === null,
    'oldest RPC did not invalidate unknown usage and reserve');
  await db.query('SELECT public.record_instance_context_usage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [instance,site,'test-model','azure',800,120,4000,1024,'estimate',at]);
  const measuredAt = '2026-09-25T12:00:00.000Z';
  const breakdown = { estimatedInputTokens: 800, instructions: 250, skills: 50,
    messages: 200, toolCalls: 100, toolDefinitions: 200,
    usedTokens: 800, source: 'estimate', measuredAt };
  await db.query('SELECT public.record_instance_context_breakdown($1,$2,$3,$4,$5,$6,$7::jsonb)',
    [instance,site,'test-model',800,'estimate',at,JSON.stringify(breakdown)]);
  const stored = (await db.query('SELECT input_breakdown FROM instance_context_state WHERE instance_id=$1',[instance])).rows[0];
  assert(stored.input_breakdown?.skills === 50, 'breakdown was not persisted');
  let invalidBreakdown = false;
  try {
    await db.query('SELECT public.record_instance_context_breakdown($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [instance,site,'test-model',800,'estimate',at,JSON.stringify({...breakdown, prompt: 'sensitive'})]);
  } catch (error) { invalidBreakdown = error.code === '22023'; }
  assert(invalidBreakdown, 'breakdown accepted prompt content');
  await db.query('SELECT public.record_instance_context_breakdown($1,$2,$3,$4,$5,$6,$7::jsonb)',
    [instance,site,'test-model',800,'estimate', '2026-09-25T12:00:01Z',JSON.stringify({...breakdown, measuredAt: '2026-09-25T12:00:01.000Z'})]);
  assert((await db.query('SELECT input_breakdown FROM instance_context_state WHERE instance_id=$1',[instance])).rows[0]
    .input_breakdown?.measuredAt === breakdown.measuredAt, 'stale breakdown overwrote a checkpoint');
  await db.query('SELECT public.record_instance_context_breakdown($1,$2,$3,$4,$5,$6,$7::jsonb)',
    [instance,other,'test-model',800,'estimate',at,JSON.stringify(breakdown)]);
  assert((await db.query('SELECT input_breakdown FROM instance_context_state WHERE instance_id=$1',[instance])).rows[0]
    .input_breakdown?.measuredAt === breakdown.measuredAt, 'cross-site breakdown overwrote the checkpoint');
  await db.query('SELECT public.record_instance_context_usage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [instance,site,'test-model','azure',900,120,4000,1024,'estimate','2026-09-25T12:00:02Z']);
  const superseded = (await db.query('SELECT used_tokens,input_breakdown FROM instance_context_state WHERE instance_id=$1',[instance])).rows[0];
  assert(superseded.used_tokens === 900 && superseded.input_breakdown?.usedTokens === 800,
    'new total did not supersede the previous breakdown');
  await db.query('INSERT INTO instance_logs VALUES ($1,$2,$3,$4,$5,$6)',
    [id(15),instance,site,'tool_call',at,JSON.stringify({})]);
  const race = await Promise.all([
    commit([5],5,at,id(14)),
    commit([5],5,at,id(14)),
  ]);
  assert(race.filter(Boolean).length === 1, 'two concurrent compactions advanced one cursor');
  const raced = (await db.query('SELECT cursor_log_id, revision, reserved_output_tokens FROM instance_context_state WHERE instance_id=$1',[instance])).rows[0];
  assert(raced.cursor_log_id === id(15) && Number(raced.revision) === 3, 'race changed cursor more than once');
  await db.exec(`SET test.user_id = '${user}'; SET ROLE authenticated`);
  assert((await db.query('SELECT count(*)::integer AS c FROM public.instance_context_state')).rows[0].c===1,
    'authorized RLS read denied');
  let unauthorizedRpc = false;
  try { await commit([5],5,at,id(14)); } catch (e) { unauthorizedRpc = e.code === '42501'; }
  assert(unauthorizedRpc, 'authenticated role executed service-only compaction RPC');
  let unauthorizedBreakdown = false;
  try {
    await db.query('SELECT public.record_instance_context_breakdown($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [instance,site,'test-model',900,'estimate','2026-09-25T12:00:02Z',JSON.stringify({...breakdown,
        estimatedInputTokens: 900, instructions: 350, usedTokens: 900, measuredAt: '2026-09-25T12:00:02.000Z'})]);
  } catch (e) { unauthorizedBreakdown = e.code === '42501'; }
  assert(unauthorizedBreakdown, 'authenticated role executed the service-only breakdown RPC');
  await db.exec(`RESET ROLE; SET test.user_id = '${id(99)}'; SET ROLE authenticated`);
  assert((await db.query('SELECT count(*)::integer AS c FROM public.instance_context_state')).rows[0].c===0,
    'cross-site RLS read allowed');
  await db.exec('RESET ROLE');
  // The live deployment has the reserve but no output_tokens column. Exercise
  // the repair against that exact shape, not just an already-complete schema.
  const drifted = new PGlite();
  try {
    await drifted.exec(`CREATE TABLE instance_context_state (
      instance_id uuid PRIMARY KEY, reserved_output_tokens integer NOT NULL DEFAULT 0
    )`);
    await drifted.query('INSERT INTO instance_context_state (instance_id, reserved_output_tokens) VALUES ($1,$2)',
      [instance,1024]);
    await drifted.exec(repair);
    await drifted.exec(repair);
    const row = (await drifted.query('SELECT output_tokens, reserved_output_tokens FROM instance_context_state')).rows[0];
    assert(row.output_tokens === 0 && row.reserved_output_tokens === 1024,
      'repair did not preserve an existing reserve and initialize missing output usage');
  } finally { await drifted.close(); }
  console.log('Instance context SQL cursor, concurrency, replay, queued, metrics, RPC grants, and cross-site RLS checks passed (pgvector substituted).');
} finally { await db.close(); }
