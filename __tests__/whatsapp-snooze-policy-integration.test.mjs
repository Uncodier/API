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

async function fixture({ hours = 12, status = 'default', override = null } = {}) {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION public.user_can(uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE TABLE settings(id uuid PRIMARY KEY, site_id uuid UNIQUE, activities jsonb, channels jsonb);
    CREATE TABLE leads(id uuid PRIMARY KEY, site_id uuid, assignee_id uuid);
    CREATE TABLE conversations(id uuid PRIMARY KEY, site_id uuid, lead_id uuid REFERENCES leads(id),
      agent_id uuid, delegate_id uuid, status text);
    CREATE TABLE messages(id uuid PRIMARY KEY, conversation_id uuid REFERENCES conversations(id),
      user_id uuid, role text, content text, created_at timestamptz DEFAULT now(), custom_data jsonb);`);
  await db.exec(migration('20261110230000_conversation_automation_snooze.sql'));
  await db.exec(migration('20261111040000_lead_site_automation_snooze.sql'));
  const siteId = randomUUID(), leadId = randomUUID(), conversationId = randomUUID(), agentId = randomUUID();
  const senderId = 'synthetic_sender', connectionId = randomUUID(), from = '+15555550123';
  const settings = { site_id: siteId, channels: { connections: [{ id: connectionId, type: 'whatsapp', zavu_sender_id: senderId }] } };
  await db.query('INSERT INTO settings VALUES($1,$2,$3,$4)', [randomUUID(), siteId,
    { conversation_automation_snooze: { status, hours } }, settings.channels]);
  await db.query('INSERT INTO leads(id,site_id,assignee_id,automation_snooze_hours) VALUES($1,$2,$3,$4)',
    [leadId, siteId, agentId, override]);
  await db.query("INSERT INTO conversations(id,site_id,lead_id,agent_id,delegate_id,status) VALUES($1,$2,$3,$4,$4,'active')",
    [conversationId, siteId, leadId, agentId]);
  await db.query("INSERT INTO messages(id,conversation_id,role,content,custom_data) VALUES($1,$2,'user','Question',$3)",
    [randomUUID(), conversationId, { connection_id: connectionId, zavu_sender_id: senderId, zavu_from: from }]);

  const client = { schema: () => ({ from: table => {
    assert.equal(table, 'messages');
    const filters = [];
    let order = false;
    const q = {
      select() { return q; },
      eq(key, value) { filters.push([key, value]); return q; },
      order() { order = true; return q; },
      limit() { return q; },
      async maybeSingle() {
        const values = [];
        const where = filters.map(([key, value]) => {
          values.push(value);
          const parameter = `$${values.length}`;
          if (key === 'conversations.site_id') return `c.site_id=${parameter}`;
          if (key.startsWith('custom_data->>')) {
            const field = key.slice('custom_data->>'.length);
            assert.match(field, /^[a-z_]+$/);
            return `m.custom_data->>'${field}'=${parameter}`;
          }
          assert.ok(['id', 'role'].includes(key));
          return `m.${key}=${parameter}`;
        }).join(' AND ');
        const result = await db.query(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id
          WHERE ${where || 'true'} ${order ? 'ORDER BY m.created_at DESC' : ''} LIMIT 1`, values);
        return { data: result.rows[0] || null, error: null };
      },
      async insert(row) {
        try {
          await db.query('INSERT INTO messages(id,conversation_id,role,user_id,content,created_at,custom_data) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [row.id, row.conversation_id, row.role, row.user_id, row.content, row.created_at, row.custom_data]);
          return { error: null };
        } catch (error) { return { error: { code: error.code } }; }
      },
    };
    return q;
  } }) };
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/lib/services/zavu/whatsapp-app-echo.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, process: { env: {} }, require(name) {
    if (name === 'node:crypto') return { createHash };
    if (name === '@/lib/database/supabase-client') return { supabaseAdmin: client };
    if (name === './webhook-handlers') return { findSettingsForSender: async () => [settings] };
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  const timestamp = Date.now() - 1_000;
  const event = { type: 'message.sent', id: randomUUID(), timestamp, senderId,
    data: { messageId: randomUUID(), source: 'whatsapp_business_app', direction: 'outbound',
      channel: 'whatsapp', to: from, text: 'Human answer' } };
  return { db, event, timestamp, conversationId, agentId, handle: exports.handleWhatsAppAppEcho };
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