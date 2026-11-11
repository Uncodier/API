import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

// Real SQL, entirely in memory. No environment files, network or live credentials.
// Ordered transactions exercise both serial outcomes, not multi-session contention.
const db = new PGlite();
const migration = readFileSync(new URL('../supabase/migrations/20261110230000_conversation_automation_snooze.sql', import.meta.url), 'utf8');
const site = randomUUID(), otherSite = randomUUID(), assignment = randomUUID();
let historical;
const time = value => value === null ? null : new Date(value).getTime();
const row = async (id, schema = 'public') => (await db.query(`SELECT * FROM ${schema}.conversations WHERE id = $1`, [id])).rows[0];
async function conversation(hours = null, schema = 'public') {
  const id = randomUUID();
  await db.query(`INSERT INTO ${schema}.conversations
    (id,site_id,agent_id,delegate_id,status,automation_snooze_hours)
    VALUES ($1,$2,$3,$3,'active',$4)`, [id, site, assignment, hours]);
  return id;
}
async function message(id, { at = new Date(), role = 'team_member', data = {}, schema = 'public', messageId = randomUUID(), conflict = '' } = {}) {
  await db.query(`INSERT INTO ${schema}.messages(id,conversation_id,role,created_at,custom_data)
    VALUES ($1,$2,$3,$4,$5) ${conflict}`, [messageId, id, role, at, data]);
  return messageId;
}

before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.uid',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE SCHEMA app_alpha; CREATE SCHEMA app_beta; CREATE SCHEMA ignored;`);
  for (const schema of ['public', 'app_alpha', 'app_beta', 'ignored']) {
    await db.exec(`CREATE TABLE ${schema}.conversations (
      id uuid PRIMARY KEY, site_id uuid, agent_id uuid, delegate_id uuid, status text);
      CREATE TABLE ${schema}.messages (id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES ${schema}.conversations(id), role text NOT NULL,
      created_at timestamptz DEFAULT now(), custom_data jsonb DEFAULT '{}');`);
    await db.exec(`CREATE FUNCTION ${schema}.user_can(uuid,text) RETURNS boolean LANGUAGE sql AS $$
      SELECT coalesce(current_setting('test.editor',true),'yes')='yes'
        AND $1=current_setting('test.site',true)::uuid $$;`);
  }
  historical = randomUUID();
  await db.query('INSERT INTO conversations(id) VALUES ($1)', [historical]);
  await message(historical);
  await db.exec(migration);
});
after(async () => { await db.close(); });

test('no backfill; default four-hour pending insert is atomic and preserves assignments/status', async () => {
  assert.equal((await row(historical)).last_human_reply_at, null);
  assert.equal((await row(historical)).automation_paused_until, null);
  const id = await conversation(), at = new Date(Date.now() - 1000);
  await db.exec('BEGIN');
  await message(id, { at, data: { status: 'pending' } });
  const updated = await row(id);
  assert.equal(time(updated.last_human_reply_at), +at);
  assert.equal(time(updated.automation_paused_until), +at + 4 * 3600000);
  assert.equal(updated.agent_id, assignment);
  assert.equal(updated.delegate_id, assignment);
  assert.equal(updated.status, 'active');
  await db.exec('ROLLBACK');
  assert.equal((await row(id)).automation_paused_until, null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1', [id])).rows[0].n, 0);
});

test('default on applies to existing conversations and new conversations without any configuration', async () => {
  const at = new Date(Date.now() - 1000);
  // This conversation existed before the migration; NULL is enabled, not opt-out.
  assert.equal((await row(historical)).automation_snooze_hours, null);
  await message(historical, { at });
  assert.equal(time((await row(historical)).automation_paused_until), +at + 4 * 3600000);

  for (const schema of ['public', 'app_alpha', 'app_beta']) {
    const id = randomUUID();
    // Omit the setting altogether, as ordinary conversation creation does.
    await db.query(`INSERT INTO ${schema}.conversations(id,site_id) VALUES ($1,$2)`, [id, site]);
    await message(id, { at, schema });
    assert.equal((await row(id, schema)).automation_snooze_hours, null);
    assert.equal(time((await row(id, schema)).automation_paused_until), +at + 4 * 3600000);
  }
});

test('zero disables pause, fractional hours work, and invalid bounds/nonfinite values fail', async () => {
  const at = new Date(Date.now() - 1000), disabled = await conversation(0);
  await message(disabled, { at });
  assert.equal((await row(disabled)).automation_paused_until, null);
  assert.equal(time((await row(disabled)).last_human_reply_at), +at);
  for (const hours of [0.25, 168]) {
    const id = await conversation(hours);
    await message(id, { at });
    assert.equal(time((await row(id)).automation_paused_until), +at + hours * 3600000);
  }
  for (const hours of [-1, 168.1, 'NaN', 'Infinity', '-Infinity']) {
    await assert.rejects(conversation(hours), error => error.code === '23514');
  }
});

test('extends from event time, never shortens, ignores duplicate IDs and UPDATE delivery retries', async () => {
  const id = await conversation(), first = new Date(Date.now() - 3600000), next = new Date(+first + 1000);
  const messageId = await message(id, { at: first, data: { status: 'pending' } });
  await message(id, { at: next });
  const expected = time((await row(id)).automation_paused_until);
  await message(id, { at: first });
  await message(id, { messageId, conflict: 'ON CONFLICT (id) DO NOTHING' });
  await db.query(`UPDATE messages SET custom_data='{"status":"failed"}', created_at=now() WHERE id=$1`, [messageId]);
  assert.equal(time((await row(id)).automation_paused_until), expected);
  await db.query('UPDATE conversations SET automation_snooze_hours=0.25 WHERE id=$1', [id]);
  await message(id, { at: new Date(+next + 1000) });
  assert.equal(time((await row(id)).automation_paused_until), expected);
});

test('old history stays expired, future event times clamp, notes/nonhuman roles do not snooze', async () => {
  const id = await conversation(), old = new Date(Date.now() - 86400000);
  await message(id, { at: old });
  assert.equal(time((await row(id)).automation_paused_until), +old + 4 * 3600000);
  for (const role of ['user', 'assistant', 'system', 'tool']) {
    await message(id, { role });
  }
  for (const data of [{ internal: true }, { is_internal: true }, { is_internal_note: true }, { type: 'internal_note' }, { message_type: 'note' }]) {
    await message(id, { data });
  }
  assert.equal(time((await row(id)).last_human_reply_at), +old);
  const start = Date.now();
  await message(id, { at: new Date(Date.now() + 86400000) });
  const clamped = time((await row(id)).last_human_reply_at);
  assert.ok(clamped >= start && clamped <= Date.now());
});

test('both serial human/resume orderings and duplicate history after resume preserve newest decision', async () => {
  const id = await conversation(), at = new Date(Date.now() - 1000);
  await message(id, { at });
  await db.query('UPDATE conversations SET automation_paused_until=NULL WHERE id=$1', [id]);
  await message(id, { at });
  await message(id, { at: new Date(+at - 1000) });
  assert.equal((await row(id)).automation_paused_until, null);
  await message(id, { at: new Date(+at + 500) });
  assert.equal(time((await row(id)).automation_paused_until), +at + 500 + 4 * 3600000);
});

test('schema-bound tables cannot be redirected through caller search_path; function is not an RPC', async () => {
  const id = await conversation(null, 'app_alpha');
  await db.query(`INSERT INTO app_beta.conversations(id) VALUES ($1)`, [id]);
  await db.exec('SET search_path = app_beta, public');
  await message(id, { schema: 'app_alpha' });
  assert.ok((await row(id, 'app_alpha')).automation_paused_until);
  assert.equal((await row(id, 'app_beta')).automation_paused_until, null);
  await db.exec('RESET search_path');
  const config = (await db.query(`SELECT prosecdef, proconfig,
    has_function_privilege('authenticated', oid, 'EXECUTE') AS executable
    FROM pg_proc WHERE oid='public.snooze_conversation_after_human_reply()'::regprocedure`)).rows[0];
  assert.equal(config.prosecdef, false);
  assert.deepEqual(config.proconfig, ['search_path=pg_catalog']);
  assert.equal(config.executable, false);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='ignored' AND column_name='automation_paused_until'`)).rows[0].n, 0);
});

test('invoker RLS permits authorized pending reply, denies cross-site, and atomically rejects missing UPDATE policy', async () => {
  // Minimal representative tenant policies, not a claim of a full live policy replay.
  await db.exec(`ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT SELECT,INSERT,UPDATE ON public.conversations,public.messages TO authenticated;
    CREATE POLICY conversation_read ON public.conversations FOR SELECT TO authenticated
      USING (site_id=current_setting('test.site')::uuid);
    CREATE POLICY conversation_write ON public.conversations FOR UPDATE TO authenticated
      USING (site_id=current_setting('test.site')::uuid AND current_setting('test.can_update')='yes');
    CREATE POLICY message_write ON public.messages FOR INSERT TO authenticated
      WITH CHECK (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id));`);
  const allowed = await conversation(), deniedUpdate = await conversation(), deniedSite = await conversation();
  await db.query('UPDATE conversations SET site_id=$1 WHERE id=$2', [otherSite, deniedSite]);
  await db.query("SELECT set_config('test.site',$1,false),set_config('test.can_update','yes',false)", [site]);
  await db.query("SELECT set_config('test.uid',$1,false),set_config('test.editor','yes',false)", [randomUUID()]);
  await db.exec('SET ROLE authenticated');
  try {
    await message(allowed, { data: { status: 'pending' } });
    assert.ok((await row(allowed)).automation_paused_until);
    await assert.rejects(message(deniedSite), error => error.code === '42501');
    await db.exec("SET test.can_update='no'");
    await assert.rejects(message(deniedUpdate), error => error.code === '42501');
  } finally { await db.exec('RESET ROLE'); }
  assert.equal((await row(deniedUpdate)).automation_paused_until, null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1', [deniedUpdate])).rows[0].n, 0);
});

test('broad legacy RLS cannot let viewers mutate snooze or editors forge human timestamps', async () => {
  const id = await conversation();
  await db.exec(`CREATE POLICY legacy_broad_write ON conversations FOR ALL TO authenticated USING(true) WITH CHECK(true)`);
  await db.query("SELECT set_config('test.site',$1,false),set_config('test.editor','no',false)", [site]);
  await db.exec('SET ROLE authenticated');
  try {
    await assert.rejects(db.query('UPDATE conversations SET automation_snooze_hours=0 WHERE id=$1',[id]), e=>e.code==='42501');
    await assert.rejects(db.query('UPDATE conversations SET automation_paused_until=now() WHERE id=$1',[id]), e=>e.code==='42501');
    await assert.rejects(message(id), e=>e.code==='42501');
    await db.query('UPDATE conversations SET status=$1 WHERE id=$2', ['active', id]);
    await db.exec("SET test.editor='yes'");
    await db.query('UPDATE conversations SET automation_snooze_hours=2 WHERE id=$1',[id]);
    await assert.rejects(db.query('UPDATE conversations SET last_human_reply_at=now() WHERE id=$1',[id]), e=>e.code==='42501');
    await message(id);
    assert.ok((await row(id)).last_human_reply_at);
    await db.query('UPDATE conversations SET automation_paused_until=NULL WHERE id=$1',[id]);
    assert.equal((await row(id)).automation_paused_until,null);
  } finally { await db.exec('RESET ROLE'); }
});