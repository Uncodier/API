import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';

// Real PostgreSQL execution, entirely in memory. No credentials/network/live data.
const db = new PGlite();
const sql = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const migration = sql('20261111220000_first_contact_whatsapp_snooze');
const at = new Date(Date.now() - 60000);
const query = async (text, params = []) => (await db.query(text, params)).rows;
const one = async (text, params = []) => (await query(text, params))[0];
async function fixture({ hours = 4, status = 'default', schema = 'public' } = {}) {
  const site = randomUUID(), connection = randomUUID(), sender = randomUUID(), recipient = '+5215512345678';
  await db.query(`INSERT INTO ${schema}.sites(id) VALUES($1)`, [site]);
  await db.query(`INSERT INTO ${schema}.settings(site_id,channels,activities) VALUES($1,$2,$3)`, [site,
    { connections: [{ id: connection, type: 'whatsapp', zavu_sender_id: sender }] },
    hours === null ? {} : { conversation_automation_snooze: { status, hours } }]);
  return { site, connection, sender, recipient, schema };
}
const identity = f => [f.site, f.connection, f.sender, f.recipient];
const metadata = f => ({ connection_id: f.connection, zavu_sender_id: f.sender, zavu_from: f.recipient });
async function inbound(f, { from = f.recipient, leadHours = null, site = f.site, role = 'user' } = {}) {
  const id = randomUUID(), lead = randomUUID();
  await db.query(`INSERT INTO ${f.schema}.leads(id,site_id,automation_snooze_hours) VALUES($1,$2,$3)`, [lead, site, leadHours]);
  await db.query(`INSERT INTO ${f.schema}.conversations(id,site_id,lead_id) VALUES($1,$2,$3)`, [id,site,lead]);
  await db.query(`INSERT INTO ${f.schema}.messages(id,conversation_id,role,created_at,content,custom_data)
    VALUES($1,$2,$3,$4,'inbound',$5)`, [randomUUID(),id,role,at,{ ...metadata(f), zavu_from: from }]);
  return id;
}
async function register(f, { id = randomUUID(), provider = randomUUID(), time = at, content = 'human reply', data = {} } = {}) {
  const r = await one(`SELECT ${f.schema}.register_conversation_human_event($1,$2,$3,$4,$5,$6,$7,$8,$9) result`,
    [...identity(f),id,provider,time,content,data]);
  return { ...r.result, id, provider };
}
async function reconcile(f, conversation) {
  return (await one(`SELECT ${f.schema}.reconcile_conversation_human_events($1,$2,$3,$4,$5) result`, [...identity(f),conversation])).result;
}
const conversation = (f,id) => one(`SELECT * FROM ${f.schema}.conversations WHERE id=$1`,[id]);
const ledger = (f,id) => one(`SELECT * FROM ${f.schema}.conversation_automation_events WHERE id=$1`,[id]);
async function expectPause(f,id,hours,time=at) {
  const row = await conversation(f,id);
  assert.equal(row.automation_paused_until === null ? null : +new Date(row.automation_paused_until), hours === 0 ? null : +time+hours*3600000);
  assert.equal(+new Date(row.last_human_reply_at),+time);
}
before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${randomUUID()}'::uuid$$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE SCHEMA app_alpha;
    CREATE FUNCTION public.user_can(uuid,text) RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.editor',true)='yes'$$;`);
  for (const s of ['public','app_alpha']) await db.exec(`
    CREATE TABLE ${s}.sites(id uuid PRIMARY KEY);
    CREATE TABLE ${s}.leads(id uuid PRIMARY KEY,site_id uuid REFERENCES ${s}.sites(id) ON DELETE CASCADE);
    CREATE TABLE ${s}.settings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),site_id uuid UNIQUE REFERENCES ${s}.sites(id) ON DELETE CASCADE,activities jsonb DEFAULT '{}',channels jsonb);
    CREATE TABLE ${s}.conversations(id uuid PRIMARY KEY,site_id uuid REFERENCES ${s}.sites(id) ON DELETE CASCADE,lead_id uuid REFERENCES ${s}.leads(id) ON DELETE CASCADE);
    CREATE TABLE ${s}.messages(id uuid PRIMARY KEY,conversation_id uuid REFERENCES ${s}.conversations(id) ON DELETE CASCADE,role text,user_id uuid,created_at timestamptz,content text,custom_data jsonb);
    GRANT USAGE ON SCHEMA ${s} TO service_role;
    GRANT SELECT,INSERT,UPDATE ON ${s}.settings,${s}.leads,${s}.conversations,${s}.messages TO service_role;`);
  await db.exec(sql('20261110230000_conversation_automation_snooze'));
  await db.exec(sql('20261111040000_lead_site_automation_snooze'));
  await db.exec(migration);
});
after(async () => db.close());

test('canonical and bootstrap copies match reviewed migration bytes and manifest hashes', () => {
  const root = new URL('../../makinari-db-scheme/', import.meta.url);
  const name = '20261111220000_first_contact_whatsapp_snooze.sql';
  for (const path of ['supabase/migrations/', 'bootstrap/supabase/migrations/']) {
    assert.equal(readFileSync(new URL(path + name, root), 'utf8'), migration);
  }
  for (const file of ['manifest.json', 'upgrades-20261030.json']) {
    const { files } = JSON.parse(readFileSync(new URL('bootstrap/' + file, root), 'utf8'));
    assert.deepEqual(files.filter(x => x.file === name), [{file:name,sha256:createHash('sha256').update(migration).digest('hex')}]);
  }
});

test('echo -> first inbound -> reconcile consumes original message with site policy frozen, before initial decision', async () => {
  const f = await fixture({hours:12});
  const e = await register(f);
  assert.equal(e.state,'pending'); assert.equal(e.conversation_id,null);
  assert.equal((await ledger(f,e.id)).snooze_hours,'12');
  await db.query('UPDATE settings SET activities=$1 WHERE site_id=$2', [{conversation_automation_snooze:{status:'inactive',hours:4}},f.site]);
  const id = await inbound(f,{leadHours:2});
  assert.equal((await conversation(f,id)).automation_paused_until,null);
  assert.deepEqual(await reconcile(f,id),{state:'reconciled',conversation_id:id,applied_count:1});
  await expectPause(f,id,12);
  const m = await one('SELECT * FROM messages WHERE id=$1',[e.id]);
  assert.equal(m.role,'team_member'); assert.equal(m.content,'human reply'); assert.equal(+new Date(m.created_at),+at);
  assert.ok((await ledger(f,e.id)).applied_at);
});

test('inbound -> bind -> human during generation applies immediately; exact existing inbound uses lead before site', async () => {
  const f = await fixture({hours:12}), id = await inbound(f,{leadHours:2});
  assert.equal((await reconcile(f,id)).applied_count,0);
  const e = await register(f);
  assert.equal(e.state,'applied'); assert.equal(e.conversation_id,id);
  await expectPause(f,id,2);
});

test('existing inbound without binding is discovered by registration', async () => {
  const f = await fixture(), id = await inbound(f,{from:'whatsapp:5215512345678'});
  assert.equal((await register(f)).state,'applied');
  await expectPause(f,id,4);
});

test('retries/reconcile never rearm manual resume or overwrite original content/timestamps', async () => {
  const f = await fixture(), id = await inbound(f), e = await register(f);
  await db.query('UPDATE conversations SET automation_paused_until=NULL WHERE id=$1',[id]);
  assert.equal((await register(f,{id:e.id,provider:e.provider,time:new Date(),data:{snooze_hours:168}})).state,'duplicate');
  assert.equal((await reconcile(f,id)).applied_count,0);
  await expectPause(f,id,0);
  assert.equal(+new Date((await ledger(f,e.id)).event_at),+at);
  await assert.rejects(register(f,{id:e.id,provider:e.provider,content:'changed'}),e=>e.code==='23505');
});

test('inactive pending policy stays inactive after activation; zero lead wins; missing site policy defaults ON4', async () => {
  const f = await fixture({status:'inactive'}), e = await register(f);
  await db.query('UPDATE settings SET activities=$1 WHERE site_id=$2',[{conversation_automation_snooze:{status:'active',hours:12}},f.site]);
  const id = await inbound(f,{leadHours:2}); await reconcile(f,id); await expectPause(f,id,0);
  assert.equal((await ledger(f,e.id)).snooze_hours,'0');
  const g=await fixture({hours:12}), gid=await inbound(g,{leadHours:0}); await register(g); await expectPause(g,gid,0);
  const h=await fixture({hours:null}), hid=await inbound(h); await register(h); await expectPause(h,hid,4);
});

test('old history retains expiry; reverse-order pending events apply chronologically without latest-only loss', async () => {
  const f=await fixture(), older=new Date(+at-86400000), oldest=new Date(+older-3600000);
  await register(f,{time:older}); await register(f,{time:oldest});
  const id=await inbound(f); assert.equal((await reconcile(f,id)).applied_count,2);
  await expectPause(f,id,4,older);
  await db.query('UPDATE conversations SET automation_paused_until=NULL WHERE id=$1',[id]);
  await register(f,{time:oldest}); await expectPause(f,id,0,older);
});

test('canonical digits are not rewritten and suffix/local matches cannot bind', async () => {
  const f=await fixture();
  const wrong=await inbound(f,{from:'+525512345678'}); // Removing Mexico mobile digit must NOT match.
  assert.equal((await register(f)).state,'pending');
  await assert.rejects(reconcile(f,wrong),e=>e.code==='42501');
  for (const recipient of ['5215512345678','whatsapp:+5215512345678','+05512345678','+5215512345678@s.whatsapp.net']) {
    await assert.rejects(register({...f,recipient}),e=>e.code==='22023');
  }
  const id=await inbound(f,{from:'whatsapp:+5215512345678'}); await reconcile(f,id); await expectPause(f,id,4);
});

test('ambiguous conversations fail closed even when representation is identical; no ledger committed', async () => {
  const f=await fixture(), id=await inbound(f); await inbound(f);
  await assert.rejects(register(f),e=>e.code==='42501');
  await assert.rejects(reconcile(f,id),e=>e.code==='42501');
  assert.equal((await one('SELECT count(*)::int n FROM conversation_automation_events WHERE site_id=$1',[f.site])).n,0);
});

test('saved actual user message, exact connection, sender and site are required for binding', async () => {
  const f=await fixture(), other=await fixture();
  const foreign=await inbound(f,{site:other.site});
  const notUser=await inbound(f,{role:'assistant'});
  await register(f);
  await assert.rejects(reconcile(f,foreign),e=>e.code==='42501');
  await assert.rejects(reconcile(f,notUser),e=>e.code==='42501');
  const id=await inbound({...f,sender:other.sender});
  await assert.rejects(reconcile(f,id),e=>e.code==='42501');
  const wrongConnection=await inbound({...f,connection:other.connection});
  await assert.rejects(reconcile(f,wrongConnection),e=>e.code==='42501');
});

test('wrong settings ownership, duplicate sender ownership and cross-contact deterministic IDs reject atomically', async () => {
  const f=await fixture(), g=await fixture(), e=await register(f);
  await assert.rejects(register({...f,site:g.site}),e=>e.code==='42501');
  await assert.rejects(register({...f,connection:g.connection}),e=>e.code==='42501');
  await assert.rejects(register(g,{id:e.id,provider:e.provider}),e=>e.code==='23505');
  await assert.rejects(register({...f,recipient:'+15551234567'},{id:e.id,provider:e.provider}),e=>e.code==='23505');
  await db.query('UPDATE settings SET channels=$1 WHERE site_id=$2',[{connections:[{id:g.connection,type:'whatsapp',zavu_sender_id:f.sender}]},g.site]);
  await assert.rejects(register(f),e=>e.code==='42501');
});

test('preexisting deterministic saved message is consumed without retrigger after manual resume', async () => {
  const f=await fixture(), id=await inbound(f), mid=randomUUID(), provider=randomUUID();
  await db.query(`INSERT INTO messages(id,conversation_id,role,user_id,content,created_at,custom_data)
    VALUES($1,$2,'team_member',NULL,'human reply',$3,$4)`,[mid,id,at,{...metadata(f),source:'whatsapp_business_app',external_message_id:provider}]);
  await db.query('UPDATE conversations SET automation_paused_until=NULL WHERE id=$1',[id]);
  assert.equal((await register(f,{id:mid,provider})).state,'applied');
  await expectPause(f,id,0);
  assert.ok((await ledger(f,mid)).applied_at);
});

test('message collision rolls back binding, pending consume and snooze atomically', async () => {
  const f=await fixture(), e=await register(f), id=await inbound(f);
  await db.query(`INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES($1,$2,'assistant','collision',$3)`,[e.id,id,at]);
  await assert.rejects(reconcile(f,id),e=>e.code==='23505');
  assert.equal((await ledger(f,e.id)).applied_at,null);
  assert.equal((await conversation(f,id)).automation_paused_until,null);
  assert.equal((await one('SELECT conversation_id FROM conversation_automation_contacts WHERE site_id=$1',[f.site])).conversation_id,null);
});

test('conversation deletion clears binding but retains consumed receipts: new thread never replays old human event', async () => {
  const f=await fixture(), old=await inbound(f), e=await register(f);
  const appliedAt=(await ledger(f,e.id)).applied_at;
  await db.query('DELETE FROM conversations WHERE id=$1',[old]);
  assert.equal((await one('SELECT conversation_id FROM conversation_automation_contacts WHERE site_id=$1',[f.site])).conversation_id,null);
  assert.equal(+new Date((await ledger(f,e.id)).applied_at),+new Date(appliedAt));
  assert.equal((await register(f,{id:e.id,provider:e.provider})).state,'duplicate');
  const id=await inbound(f);
  assert.deepEqual(await reconcile(f,id),{state:'reconciled',conversation_id:id,applied_count:0});
  assert.equal((await register(f,{id:e.id,provider:e.provider})).state,'duplicate');
  assert.equal((await conversation(f,id)).automation_paused_until,null);
  assert.equal((await conversation(f,id)).last_human_reply_at,null);
  assert.equal((await one('SELECT count(*)::int n FROM messages WHERE id=$1',[e.id])).n,0);
  assert.equal(+new Date((await ledger(f,e.id)).applied_at),+new Date(appliedAt));
});

test('lead cascading deletion is not blocked by an inbound-only contact binding', async () => {
  const f=await fixture(), id=await inbound(f);
  await reconcile(f,id);
  const lead=(await conversation(f,id)).lead_id;
  await db.query('DELETE FROM leads WHERE id=$1',[lead]);
  assert.equal(await conversation(f,id),undefined);
  assert.equal((await one('SELECT conversation_id FROM conversation_automation_contacts WHERE site_id=$1',[f.site])).conversation_id,null);
});

test('site deletion cascades bound and unbound contacts plus pending and consumed ledger PII, preserving other tenants', async () => {
  for(const schema of ['public','app_alpha']) {
    const f=await fixture({schema}), other=await fixture({schema});
    await inbound(f); const applied=await register(f);
    const pending=await register({...f,recipient:'+15551234567'});
    const retained=await register(other);
    assert.equal(pending.state,'pending'); assert.ok((await ledger(f,applied.id)).applied_at);
    await db.query(`DELETE FROM ${schema}.sites WHERE id=$1`,[f.site]);
    assert.equal((await one(`SELECT count(*)::int n FROM ${schema}.conversation_automation_contacts WHERE site_id=$1`,[f.site])).n,0);
    assert.equal((await one(`SELECT count(*)::int n FROM ${schema}.conversation_automation_events WHERE site_id=$1`,[f.site])).n,0);
    assert.equal(await ledger(f,applied.id),undefined); assert.equal(await ledger(f,pending.id),undefined);
    assert.equal((await ledger(other,retained.id)).site_id,other.site);
  }
});

test('tenant schema isolation and server_role invoker execution; no cross-search_path binding', async () => {
  const f=await fixture({schema:'app_alpha'}), id=await inbound(f,{leadHours:2});
  await db.exec('SET ROLE service_role; SET search_path=public');
  try { await register(f); await expectPause(f,id,2); } finally { await db.exec('RESET ROLE'); }
  assert.equal((await one('SELECT count(*)::int n FROM public.conversation_automation_events WHERE site_id=$1',[f.site])).n,0);
});

test('server-only ACL/RLS and function search_path; spoofed client claims cannot register or edit ledger', async () => {
  const f=await fixture();
  const functions=await query(`SELECT prosecdef,proconfig,has_function_privilege('authenticated',oid,'EXECUTE') executable
    FROM pg_proc WHERE proname IN ('register_conversation_human_event','reconcile_conversation_human_events','validate_conversation_automation_contact','conversation_automation_frozen_hours')`);
  assert.equal(functions.length,8);
  for(const r of functions){ assert.equal(r.prosecdef,false);assert.equal(r.executable,false);assert.deepEqual(r.proconfig,['search_path=pg_catalog']); }
  for(const name of ['conversation_automation_contacts','conversation_automation_events']) {
    const r=await one(`SELECT relrowsecurity,has_table_privilege('service_role',oid,'DELETE') del,
      has_table_privilege('service_role',oid,'TRUNCATE') trunc FROM pg_class WHERE oid=$1::regclass`,[name]);
    assert.equal(r.relrowsecurity,true);assert.equal(r.del,false);assert.equal(r.trunc,false);
  }
  await db.exec(`SET ROLE authenticated; SET request.jwt.claim.role='service_role'`);
  try {
    await assert.rejects(register(f),e=>e.code==='42501');
    await assert.rejects(db.exec('SELECT * FROM conversation_automation_events'),e=>e.code==='42501');
    await assert.rejects(reconcile(f,randomUUID()),e=>e.code==='42501');
  } finally {await db.exec('RESET ROLE');}
  // Even accidental future grant does not turn a forged claim into a trusted invoker.
  await db.exec('GRANT EXECUTE ON FUNCTION register_conversation_human_event(uuid,text,text,text,uuid,text,timestamptz,text,jsonb), validate_conversation_automation_contact(uuid,text,text,text) TO authenticated; SET ROLE authenticated');
  try {await assert.rejects(register(f),/Server-only/);} finally {
    await db.exec('RESET ROLE; REVOKE ALL ON FUNCTION register_conversation_human_event(uuid,text,text,text,uuid,text,timestamptz,text,jsonb), validate_conversation_automation_contact(uuid,text,text,text) FROM authenticated');
  }
});

test('existing human trigger honors normal lead/site policy and ignores caller frozen metadata; existing auth guards remain', async () => {
  const f=await fixture({hours:12}), id=await inbound(f,{leadHours:2});
  await db.query(`INSERT INTO messages(id,conversation_id,role,created_at,content,custom_data) VALUES($1,$2,'team_member',$3,'normal',$4)`,
    [randomUUID(),id,at,{snooze_hours:168,frozen_snooze_hours:168}]);
  await expectPause(f,id,2);
  const g=await fixture(), gid=await inbound(g);
  await db.exec('GRANT SELECT,INSERT,UPDATE ON conversations,messages,leads,settings TO authenticated; SET test.editor=\'no\'; SET ROLE authenticated');
  try {
    await assert.rejects(db.query(`INSERT INTO messages(id,conversation_id,role,created_at) VALUES($1,$2,'team_member',$3)`,[randomUUID(),gid,at]),e=>e.code==='42501');
    await assert.rejects(db.query('UPDATE conversations SET automation_paused_until=now() WHERE id=$1',[gid]),e=>e.code==='42501');
  } finally {await db.exec('RESET ROLE');}
});

test('caller metadata cannot suppress a registered live human event; media metadata survives', async () => {
  const f=await fixture(), id=await inbound(f);
  const e=await register(f,{data:{internal:true,is_internal:true,is_internal_note:true,type:'note',message_type:'image',snooze_hours:0,connection_id:'forged'}});
  await expectPause(f,id,4);
  const m=await one('SELECT custom_data FROM messages WHERE id=$1',[e.id]);
  assert.equal(m.custom_data.message_type,'image');
  assert.equal(m.custom_data.connection_id,f.connection);
  assert.equal(m.custom_data.internal,undefined);
  const g=await fixture(), gid=await inbound(g); await register(g,{data:{message_type:'internal_note'}}); await expectPause(g,gid,4);
});

test('future event is clamped once at admission; invalid timestamp/content/metadata fail without ledger', async () => {
  const f=await fixture(), start=Date.now(), e=await register(f,{time:new Date(Date.now()+86400000)}), end=Date.now();
  const time=+new Date((await ledger(f,e.id)).event_at); assert.ok(time>=start&&time<=end);
  for(const overrides of [{time:null},{content:''},{data:[]},{time:new Date(0)}]) await assert.rejects(register(f,overrides),e=>e.code==='22023');
});