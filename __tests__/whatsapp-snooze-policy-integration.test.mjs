import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';

// Exercise the real echo handler and real PostgreSQL triggers together. No
// provider, production database, credentials or environment files are loaded.
const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

async function fixture({ hours = 12, status = 'default', override = null, existing = true } = {}) {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION public.user_can(uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE TABLE sites(id uuid PRIMARY KEY);
    CREATE TABLE settings(id uuid PRIMARY KEY, site_id uuid UNIQUE, activities jsonb, channels jsonb);
    CREATE TABLE leads(id uuid PRIMARY KEY, site_id uuid, assignee_id uuid);
    CREATE TABLE conversations(id uuid PRIMARY KEY, site_id uuid, lead_id uuid REFERENCES leads(id),
      agent_id uuid, delegate_id uuid, status text);
    CREATE TABLE messages(id uuid PRIMARY KEY, conversation_id uuid REFERENCES conversations(id),
      user_id uuid, role text, content text, created_at timestamptz DEFAULT now(), custom_data jsonb);`);
  await db.exec(migration('20261110230000_conversation_automation_snooze.sql'));
  await db.exec(migration('20261111040000_lead_site_automation_snooze.sql'));
  await db.exec(migration('20261111220000_first_contact_whatsapp_snooze.sql'));
  const siteId = randomUUID(), leadId = randomUUID(), conversationId = randomUUID(), agentId = randomUUID();
  const senderId = 'synthetic_sender', connectionId = randomUUID(), from = '+15555550123';
  const settings = { site_id: siteId, channels: { connections: [{ id: connectionId, type: 'whatsapp', zavu_sender_id: senderId }] } };
  await db.query('INSERT INTO sites(id) VALUES($1)', [siteId]);
  await db.query('INSERT INTO settings VALUES($1,$2,$3,$4)', [randomUUID(), siteId,
    { conversation_automation_snooze: { status, hours } }, settings.channels]);
  await db.query('INSERT INTO leads(id,site_id,assignee_id,automation_snooze_hours) VALUES($1,$2,$3,$4)',
    [leadId, siteId, agentId, override]);
  const metadata = { source: 'zavu_inbound_message', channel: 'whatsapp',
    connection_id: connectionId, zavu_sender_id: senderId, zavu_from: `whatsapp:${from}` };
  const saveInbound = async () => {
    await db.query("INSERT INTO conversations(id,site_id,lead_id,agent_id,delegate_id,status) VALUES($1,$2,$3,$4,$4,'active')",
      [conversationId, siteId, leadId, agentId]);
    await db.query("INSERT INTO messages(id,conversation_id,role,content,custom_data) VALUES($1,$2,'user','Question',$3)",
      [randomUUID(), conversationId, metadata]);
  };
  if (existing) await saveInbound();

  const results = [];
  const client = { schema: schema => {
    assert.equal(schema, 'public');
    return { async rpc(name, args) {
      const fields = {
        register_conversation_human_event: ['p_site_id', 'p_connection_id', 'p_sender_id', 'p_recipient',
          'p_message_id', 'p_provider_message_id', 'p_event_at', 'p_content', 'p_metadata'],
        reconcile_conversation_human_events: ['p_site_id', 'p_connection_id', 'p_sender_id', 'p_recipient', 'p_conversation_id'],
      }[name];
      assert.ok(fields, `Unexpected RPC: ${name}`);
      assert.deepEqual(Object.keys(args).sort(), [...fields].sort());
      try {
        const result = await db.query(`SELECT public.${name}(${fields.map((_, i) => `$${i + 1}`).join(',')}) AS result`,
          fields.map(field => args[field]));
        results.push(result.rows[0].result);
        return { data: result.rows[0].result, error: null };
      } catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
    } };
  } };
  const loaded = new Map();
  const load = file => {
    if (loaded.has(file)) return loaded.get(file);
    const exports = {};
    const code = ts.transpileModule(readFileSync(new URL(`../src/lib/services/zavu/${file}.ts`, import.meta.url), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { exports, process: { env: {} }, require(name) {
      if (name === 'node:crypto') return { createHash };
      if (name === '@/lib/database/supabase-client') return { supabaseAdmin: client };
      if (name === './webhook-handlers') return { findSettingsForSender: async () => [settings] };
      if (name === './conversation-automation-contact') return load('conversation-automation-contact');
      throw new Error(`Unexpected dependency: ${name}`);
    } });
    loaded.set(file, exports);
    return exports;
  };
  const timestamp = Date.now() - 1_000;
  const event = { type: 'message.sent', id: randomUUID(), timestamp, senderId,
    data: { messageId: randomUUID(), source: 'whatsapp_business_app', direction: 'outbound',
      channel: 'whatsapp', to: from, text: 'Human answer' } };
  return { db, event, timestamp, conversationId, agentId, siteId, results, saveInbound,
    handle: load('whatsapp-app-echo').handleWhatsAppAppEcho,
    reconcile: () => load('conversation-automation-contact').reconcileConversationHumanEvents({ siteId, conversationId, metadata }) };
}

for (const scenario of [
  { name: 'inherits the AI Activities duration automatically', hours: 12, expected: 12 },
  { name: 'uses the lead override instead of the general duration', hours: 12, override: 2, expected: 2 },
  { name: 'honors the general inactive setting for an inheriting lead', status: 'inactive', expected: 0 },
  { name: 'lets an explicit lead override enable snooze when the general setting is inactive', status: 'inactive', override: 3, expected: 3 },
  { name: 'honors an explicitly disabled lead', override: 0, expected: 0 },
]) {
  test(`WhatsApp app echo ${scenario.name}`, async () => {
    const f = await fixture(scenario);
    try {
      await f.handle(f.event);
      const row = (await f.db.query('SELECT * FROM conversations WHERE id=$1', [f.conversationId])).rows[0];
      if (scenario.expected === 0) assert.equal(row.automation_paused_until, null);
      else assert.equal(new Date(row.automation_paused_until).getTime(), f.timestamp + scenario.expected * 3_600_000);
      assert.equal(row.agent_id, f.agentId);
      assert.equal(row.delegate_id, f.agentId);
      assert.equal(row.status, 'active');
      await f.handle({ ...f.event, id: randomUUID() });
      assert.equal((await f.db.query("SELECT count(*)::int AS n FROM messages WHERE role='team_member'")).rows[0].n, 1);
      const after = (await f.db.query('SELECT automation_paused_until FROM conversations WHERE id=$1', [f.conversationId])).rows[0];
      assert.deepEqual(after.automation_paused_until, row.automation_paused_until);
    } finally { await f.db.close(); }
  });
}

test('business app speaks first: real handler persists pending, first inbound reconciliation pauses before any model work', async () => {
  const f = await fixture({ existing: false, hours: 12 });
  try {
    await f.handle(f.event);
    assert.equal(f.results.at(-1).state, 'pending');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM conversations')).rows[0].n, 0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n, 0);
    const pending = (await f.db.query('SELECT * FROM conversation_automation_events')).rows[0];
    assert.equal(pending.applied_at, null);
    assert.equal(new Date(pending.event_at).getTime(), f.timestamp);
    await f.handle({ ...f.event, id: randomUUID() });
    assert.equal(f.results.at(-1).state, 'duplicate');
    await f.saveInbound();
    await f.reconcile();
    assert.deepEqual(f.results.at(-1), { state: 'reconciled', conversation_id: f.conversationId, applied_count: 1 });
    const row = (await f.db.query('SELECT * FROM conversations WHERE id=$1', [f.conversationId])).rows[0];
    assert.equal(new Date(row.automation_paused_until).getTime(), f.timestamp + 12 * 3_600_000);
    assert.equal(row.agent_id, f.agentId);
    assert.equal(row.delegate_id, f.agentId);
    assert.equal(row.status, 'active');
    const human = (await f.db.query("SELECT * FROM messages WHERE role='team_member'")).rows[0];
    assert.equal(human.id, pending.id);
    assert.equal(human.user_id, null);
    assert.equal(human.content, 'Human answer');
    assert.equal(new Date(human.created_at).getTime(), f.timestamp);
    assert.equal(human.custom_data.external_human, true);
    assert.equal(human.custom_data.source, 'whatsapp_business_app');

    // A resume is authoritative: neither provider retry nor inbound retry rearms it.
    await f.db.query('UPDATE conversations SET automation_paused_until=NULL WHERE id=$1', [f.conversationId]);
    await f.handle({ ...f.event, id: randomUUID() });
    await f.reconcile();
    assert.equal(f.results.at(-1).applied_count, 0);
    assert.equal((await f.db.query('SELECT automation_paused_until FROM conversations WHERE id=$1', [f.conversationId])).rows[0].automation_paused_until, null);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM messages WHERE role='team_member'")).rows[0].n, 1);
  } finally { await f.db.close(); }
});

test('inactive first-contact policy stays inactive after activation and retry', async () => {
  const f = await fixture({ existing: false, status: 'inactive', hours: 12 });
  try {
    await f.handle(f.event);
    await f.db.query('UPDATE settings SET activities=$1 WHERE site_id=$2',
      [{ conversation_automation_snooze: { status: 'active', hours: 12 } }, f.siteId]);
    await f.saveInbound();
    await f.reconcile();
    await f.handle({ ...f.event, id: randomUUID() });
    const row = (await f.db.query('SELECT * FROM conversations WHERE id=$1', [f.conversationId])).rows[0];
    assert.equal(row.automation_paused_until, null);
    assert.equal(new Date(row.last_human_reply_at).getTime(), f.timestamp);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM messages WHERE role='team_member'")).rows[0].n, 1);
  } finally { await f.db.close(); }
});

test('real RPC provider ID conflict is fail-closed and leaves the original durable pending event unchanged', async () => {
  const f = await fixture({ existing: false });
  try {
    await f.handle(f.event);
    await assert.rejects(f.handle({ ...f.event, data: { ...f.event.data, text: 'changed content' } }), /ZAVU_APP_ECHO_SAVE_FAILED/);
    await assert.rejects(f.handle({ ...f.event, data: { ...f.event.data, to: '+15555550124' } }), /ZAVU_APP_ECHO_SAVE_FAILED/);
    const rows = (await f.db.query('SELECT * FROM conversation_automation_events')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, 'Human answer');
    assert.equal(rows[0].recipient, '+15555550123');
    assert.equal(rows[0].applied_at, null);
  } finally { await f.db.close(); }
});