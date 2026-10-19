import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const db = new PGlite({ extensions: { uuid_ossp } });
const migration = readFileSync(resolve(process.cwd(),
  'supabase/migrations/20261019031817_fix_message_channel_health_source_id.sql'), 'utf8');
const originalExpression = "v_site::text || ':' || v_channel || ':' || NEW.custom_data->>'origin_message_id'";
const correctedExpression = "v_site::text || ':' || v_channel || ':' || (NEW.custom_data->>'origin_message_id')";
const siteId = randomUUID();
const whatsappConversation = randomUUID();
const emailConversation = randomUUID();
const providerMessageId = `test-message-${randomUUID()}`;

async function insertMessage(conversationId, metadata = {}, role = 'user') {
  const id = randomUUID();
  await db.query(`INSERT INTO public.messages (id, conversation_id, role, custom_data)
    VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)`,
  [id, conversationId, role, JSON.stringify(metadata)]);
  return id;
}

async function eventCount() {
  return (await db.query('SELECT count(*)::integer AS count FROM public.health_events')).rows[0].count;
}

try {
  await db.exec(`
    CREATE SCHEMA extensions;
    CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
    CREATE ROLE test_client;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    GRANT authenticated, service_role TO test_client;
    CREATE TABLE public.conversations (id uuid PRIMARY KEY, site_id uuid, channel text);
    CREATE TABLE public.settings (site_id uuid PRIMARY KEY, channels jsonb);
    CREATE TABLE public.messages (
      id uuid PRIMARY KEY, conversation_id uuid, role text, custom_data jsonb
    );
    CREATE TABLE public.health_events (
      site_id uuid, channel text, direction text, source_id uuid, outcome text, error_class text,
      PRIMARY KEY (site_id, channel, direction, source_id)
    );
    CREATE FUNCTION public.record_channel_health_event(uuid, text, text, uuid, text, text)
    RETURNS void LANGUAGE sql SET search_path = '' AS $$
      INSERT INTO public.health_events VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT DO NOTHING;
    $$;
    GRANT USAGE ON SCHEMA public TO authenticated, service_role;
    GRANT INSERT ON public.messages TO authenticated, service_role;
    GRANT SELECT ON public.health_events TO authenticated, service_role;
  `);
  await db.query('INSERT INTO public.conversations VALUES ($1, $2, $3), ($4, $2, $5)',
    [whatsappConversation, siteId, 'whatsapp', emailConversation, 'email']);
  await db.query('INSERT INTO public.settings VALUES ($1, $2::jsonb)', [siteId, JSON.stringify({
    whatsapp: { enabled: true, status: 'active', phone_number: '+14155550100' },
    email: { enabled: true, status: 'active', email: 'support@example.test' },
  })]);

  // Execute the original production expression to prove the regression input fails.
  assert.ok(migration.includes(correctedExpression));
  await db.exec(migration.replace(correctedExpression, originalExpression));
  await db.exec(`CREATE TRIGGER observe_message_channel_health
    AFTER INSERT OR UPDATE OF custom_data ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.observe_message_channel_health();`);
  await assert.rejects(insertMessage(whatsappConversation, { origin_message_id: providerMessageId }),
    error => error.code === '42883' && error.message.includes('text ->> unknown'));
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM public.messages')).rows[0].count, 0);

  await db.exec(`REVOKE ALL ON FUNCTION public.observe_message_channel_health() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.observe_message_channel_health() TO service_role;`);
  const before = (await db.query(`SELECT oid, proacl::text AS acl FROM pg_proc
    WHERE oid = 'public.observe_message_channel_health()'::regprocedure`)).rows[0];
  await db.exec(migration);
  await db.exec(migration); // Reapplication must not change trigger identity or permissions.
  const after = (await db.query(`SELECT oid, proacl::text AS acl, prosecdef, proconfig FROM pg_proc
    WHERE oid = 'public.observe_message_channel_health()'::regprocedure`)).rows[0];
  assert.equal(after.oid, before.oid);
  assert.equal(after.acl, before.acl);
  assert.equal(after.prosecdef, true);
  assert.deepEqual(after.proconfig, ['search_path=""']);

  await insertMessage(whatsappConversation, { origin_message_id: providerMessageId });
  await insertMessage(whatsappConversation, { origin_message_id: providerMessageId });
  await insertMessage(emailConversation, { origin_message_id: providerMessageId });
  const events = (await db.query('SELECT channel, source_id FROM public.health_events ORDER BY channel')).rows;
  assert.equal(events.length, 2);
  assert.notEqual(events[0].source_id, events[1].source_id);
  for (const event of events) {
    const expected = await db.query(`SELECT extensions.uuid_generate_v5(
      '8fb3f7a7-d174-4643-9ad7-cc0d73dba845'::uuid, $1 || ':' || $2 || ':' || $3) AS id`,
    [siteId, event.channel, providerMessageId]);
    assert.equal(event.source_id, expected.rows[0].id);
  }

  const noOriginMessage = await insertMessage(whatsappConversation);
  await insertMessage(whatsappConversation, { origin_message_id: 'failed-message', status: 'failed' });
  await db.query('UPDATE public.messages SET custom_data = $1::jsonb WHERE id = $2',
    [JSON.stringify({ origin_message_id: 'update-only' }), noOriginMessage]);
  assert.equal(await eventCount(), 2);
  await db.query(`UPDATE public.settings SET channels = jsonb_set(channels, '{whatsapp,enabled}', 'false')
    WHERE site_id = $1`, [siteId]);
  await insertMessage(whatsappConversation, { origin_message_id: 'disabled-channel' });
  assert.equal(await eventCount(), 2);

  // Spoofed JWT claims must not permit a client to manufacture health observations.
  await db.exec(`BEGIN; SET SESSION AUTHORIZATION test_client; SET ROLE authenticated;
    SET request.jwt.claims = '{"role":"service_role"}';`);
  await insertMessage(emailConversation, { origin_message_id: 'spoofed-client' });
  assert.equal(await eventCount(), 2);
  await db.exec('ROLLBACK;');
  await db.exec('BEGIN; SET SESSION AUTHORIZATION test_client; SET ROLE service_role;');
  await insertMessage(emailConversation, { origin_message_id: 'trusted-service' });
  assert.equal(await eventCount(), 3);
  await db.exec('ROLLBACK;');

  process.stdout.write(JSON.stringify({
    originalErrorReproduced: true,
    inboundChannelsAndDeduplication: true,
    configurationAndOriginGuards: true,
    authorizationAndPrivilegesPreserved: true,
  }));
} finally {
  await db.close();
}
