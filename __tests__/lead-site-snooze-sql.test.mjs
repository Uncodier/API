import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';

const db = new PGlite();
const sql = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const migration = sql('20261111040000_lead_site_automation_snooze');
const site = randomUUID(), other = randomUUID();
const at = new Date(Date.now() - 60000);
const row = async id => (await db.query('SELECT * FROM conversations WHERE id=$1', [id])).rows[0];
async function config(status = 'default', hours = 4) {
  await db.query('UPDATE settings SET activities=$1 WHERE site_id=$2', [status === null ? {} : { conversation_automation_snooze: { status, hours } }, site]);
}
async function conversation(hours = null, leadSite = site, oldHours = null) {
  const lead = randomUUID(), id = randomUUID();
  if (hours !== 'visitor') await db.query('INSERT INTO leads(id,site_id,automation_snooze_hours) VALUES($1,$2,$3)', [lead, leadSite, hours]);
  await db.query('INSERT INTO conversations(id,site_id,lead_id,automation_snooze_hours) VALUES($1,$2,$3,$4)', [id, site, hours === 'visitor' ? null : lead, oldHours]);
  return id;
}
async function message(id, { role = 'team_member', time = at, mid = randomUUID(), data = {} } = {}) {
  await db.query(`INSERT INTO messages(id,conversation_id,role,created_at,custom_data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [mid,id,role,time,data]);
  return mid;
}
async function expectHours(id, hours) {
  await message(id);
  const r = await row(id);
  assert.equal(r.automation_paused_until === null ? null : +new Date(r.automation_paused_until), hours === 0 ? null : +at + hours * 3600000);
  assert.equal(+new Date(r.last_human_reply_at), +at);
}
before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${randomUUID()}'::uuid$$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE SCHEMA app_alpha;
    CREATE FUNCTION public.user_can(uuid,text) RETURNS boolean LANGUAGE sql AS $$
      SELECT current_setting('test.editor',true)='yes' AND $1=current_setting('test.site',true)::uuid $$;`);
  for (const s of ['public','app_alpha']) await db.exec(`
    CREATE TABLE ${s}.leads(id uuid PRIMARY KEY, site_id uuid);
    CREATE TABLE ${s}.settings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid UNIQUE,activities jsonb DEFAULT '{}');
    CREATE TABLE ${s}.conversations(id uuid PRIMARY KEY,site_id uuid,lead_id uuid);
    CREATE TABLE ${s}.messages(id uuid PRIMARY KEY,conversation_id uuid REFERENCES ${s}.conversations(id),role text,created_at timestamptz,custom_data jsonb);
  `);
  await db.exec(sql('20261110230000_conversation_automation_snooze'));
  await db.exec(migration);
  await db.exec(migration); // Forward DDL is repeatable; applied predecessor is untouched.
  await db.query('INSERT INTO settings(site_id) VALUES($1)',[site]);
});
after(async () => db.close());

test('actual hierarchy: global12, lead2, globaloff/localon, localoff, legacy active, default visitor and mismatch', async () => {
  await config('default',12);
  await expectHours(await conversation(),12);
  await expectHours(await conversation(2),2);
  await expectHours(await conversation(0),0);
  await expectHours(await conversation(2,other),12);
  await config('inactive',12);
  await expectHours(await conversation(),0);
  await expectHours(await conversation(2),2);
  await config('active',1.5);
  await expectHours(await conversation(),1.5);
  await config(null);
  await expectHours(await conversation('visitor'),4);
  await expectHours(await conversation(null,site,0),4);
  await expectHours(await conversation(null,site,24),4);
});
test('missing settings defaults ON4 when absence is provable, schema-local app default too', async () => {
  await db.query('DELETE FROM settings WHERE site_id=$1',[site]);
  await expectHours(await conversation(),4);
  await db.query('INSERT INTO settings(site_id) VALUES($1)',[site]);
  const id = randomUUID();
  await db.query('INSERT INTO app_alpha.conversations(id,site_id) VALUES($1,$2)',[id,site]);
  await db.query("INSERT INTO app_alpha.messages(id,conversation_id,role,created_at) VALUES($1,$2,'team_member',$3)",[randomUUID(),id,at]);
  assert.equal(+new Date((await db.query('SELECT automation_paused_until FROM app_alpha.conversations')).rows[0].automation_paused_until),+at+4*3600000);
});
test('config changes and disabled future turns retain expiry; duplicates and nonhuman inserts never extend; no backfill on repeat', async () => {
  await config('default',12);
  const id = await conversation();
  const mid = await message(id);
  const initial = await row(id);
  await config('inactive',4);
  await db.query('UPDATE leads SET automation_snooze_hours=0 WHERE id=$1',[initial.lead_id]);
  assert.deepEqual(await row(id),initial);
  await message(id,{time:new Date(+at+1000)});
  const paused = await row(id);
  assert.equal(+new Date(paused.last_human_reply_at),+at+1000);
  assert.equal(+new Date(paused.automation_paused_until),+new Date(initial.automation_paused_until));
  await message(id,{mid,time:new Date(+at+2000)});
  await message(id,{role:'assistant',time:new Date(+at+2000)});
  await message(id,{role:'user',time:new Date(+at+2000)});
  await message(id,{data:{is_internal:true},time:new Date(+at+2000)});
  await db.exec(migration);
  assert.deepEqual(await row(id),paused);
  await db.query('UPDATE conversations SET automation_paused_until=NULL WHERE id=$1',[id]);
  await message(id); // old echo cannot undo resume
  assert.equal((await row(id)).automation_paused_until,null);
});
test('malformed site writes and out-of-range lead overrides are rejected', async () => {
  for (const activities of [[],42,'invalid']) {
    await assert.rejects(db.query('UPDATE settings SET activities=$1 WHERE site_id=$2',[JSON.stringify(activities),site]),e=>e.code==='22023');
  }
  for (const value of [null,[],{}, {status:'wat',hours:4},{status:'default',hours:'4'},{status:'inactive',hours:0},{status:'default',hours:169}]) {
    await assert.rejects(db.query('UPDATE settings SET activities=$1 WHERE site_id=$2',[{conversation_automation_snooze:value},site]),e=>e.code==='22023');
  }
  for (const hours of [-1,169,'NaN']) await assert.rejects(conversation(hours),e=>e.code==='23514');
});
test('malformed legacy reads fail closed and absent predecessor aborts atomically', async () => {
  const id = await conversation();
  await db.exec('ALTER TABLE settings DISABLE TRIGGER site_snooze_write_authorization');
  await db.query('UPDATE settings SET activities=$1 WHERE site_id=$2',[{conversation_automation_snooze:{status:'default',hours:'12'}},site]);
  await db.exec('ALTER TABLE settings ENABLE TRIGGER site_snooze_write_authorization');
  await assert.rejects(message(id),e=>e.code==='22023');
  assert.equal((await row(id)).last_human_reply_at,null);
  await config(null);
  await db.exec('BEGIN; DROP TRIGGER conversation_automation_snooze_after_human_reply ON app_alpha.messages');
  try { await assert.rejects(db.exec(migration), /predecessor/); }
  finally { await db.exec('ROLLBACK'); }
});
test('invoker RLS and user_can reject viewer writes and invisible configured reads atomically', async () => {
  await config('default',12);
  const id = await conversation(), visitor = await conversation('visitor');
  await db.exec(`GRANT SELECT,INSERT,UPDATE ON conversations,messages,leads,settings TO authenticated;
    ALTER TABLE leads ENABLE ROW LEVEL SECURITY; ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY lead_read ON leads FOR SELECT TO authenticated USING(current_setting('test.read_lead')='yes');
    CREATE POLICY lead_write ON leads FOR UPDATE TO authenticated USING(true) WITH CHECK(true);
    CREATE POLICY lead_insert ON leads FOR INSERT TO authenticated WITH CHECK(true);
    CREATE POLICY setting_read ON settings FOR SELECT TO authenticated USING(current_setting('test.read_setting')='yes');
    CREATE POLICY setting_write ON settings FOR UPDATE TO authenticated USING(true) WITH CHECK(true);
    CREATE POLICY setting_insert ON settings FOR INSERT TO authenticated WITH CHECK(true);`);
  await db.query("SELECT set_config('test.site',$1,false)",[site]);
  await db.exec("SET test.editor='no'; SET test.read_lead='yes'; SET test.read_setting='yes'; SET ROLE authenticated");
  try {
    await assert.rejects(config('inactive',4),e=>e.code==='42501');
    await assert.rejects(db.exec('UPDATE leads SET automation_snooze_hours=0'),e=>e.code==='42501');
    await assert.rejects(conversation(2),e=>e.code==='42501');
    await assert.rejects(db.query('INSERT INTO settings(site_id,activities) VALUES($1,$2)',[other,{conversation_automation_snooze:{status:'default',hours:4}}]),e=>e.code==='42501');
    await assert.rejects(message(id),e=>e.code==='42501');
    await db.exec("SET test.editor='yes'");
    await assert.rejects(db.query('UPDATE leads SET site_id=$1 WHERE id=$2',[other,(await row(id)).lead_id]),e=>e.code==='42501');
    await assert.rejects(db.query('UPDATE settings SET site_id=$1 WHERE site_id=$2',[other,site]),e=>e.code==='42501');
    await config('default',12);
    await db.exec('UPDATE leads SET automation_snooze_hours=2');
    await db.exec("SET test.read_lead='no'");
    await assert.rejects(message(id),e=>e.code==='42501');
    await db.exec("SET test.read_lead='yes'; SET test.read_setting='no'");
    await assert.rejects(message(visitor),e=>e.code==='42501');
    await db.exec("SET test.read_setting='yes'");
    await expectHours(id,2);
    await expectHours(visitor,12);
  } finally { await db.exec('RESET ROLE'); }
  assert.equal((await db.query('SELECT count(*)::int n FROM messages WHERE conversation_id=$1',[visitor])).rows[0].n,1);
  const funcs = (await db.query(`SELECT prosecdef,proconfig,has_function_privilege('authenticated',oid,'EXECUTE') executable
    FROM pg_proc WHERE proname IN ('authorize_lead_site_snooze_write','snooze_conversation_after_human_reply')`)).rows;
  for (const f of funcs) { assert.equal(f.prosecdef,false); assert.equal(f.executable,false); assert.deepEqual(f.proconfig,['search_path=pg_catalog']); }
});