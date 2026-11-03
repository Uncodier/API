import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(resolve(process.cwd(),
  'supabase/migrations/20261104102000_workflow_database_webhook_event_identity.sql'), 'utf8');

it('replaces only the shared webhook function in a forward transaction', () => {
  expect(migration).toContain('CREATE OR REPLACE FUNCTION public.dispatch_workflow_database_webhook()');
  expect(migration).not.toMatch(/(?:CREATE|DROP) TRIGGER/);
  expect(migration).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  expect(migration).toContain("SET search_path = ''");
  expect(migration).toContain('FROM PUBLIC, anon, authenticated');
});

it('generates one UUID before enqueueing and includes it in the payload', () => {
  expect(migration.match(/pg_catalog.gen_random_uuid\(\)/g)).toHaveLength(1);
  expect(migration).toContain("'event_id', webhook_event_id");
  expect(migration.indexOf('webhook_event_id :=')).toBeLessThan(migration.indexOf('PERFORM net.http_post'));
  expect(migration).toContain('body := webhook_payload');
});

it('retains Vault headers, snapshots and nonblocking DELETE OLD paths without leaking net errors', () => {
  expect(migration).toContain('vault.decrypted_secrets');
  expect(migration).toContain("jsonb_build_object('x-api-key', webhook_api_key)");
  expect(migration).toContain("WHEN TG_OP = 'DELETE' THEN 'null'::jsonb");
  expect(migration).toContain("WHEN TG_OP = 'INSERT' THEN 'null'::jsonb");
  expect(migration.match(/RETURN OLD;/g)).toHaveLength(3);
  expect(migration).toContain('WHEN OTHERS THEN');
  expect(migration).toContain('SQLSTATE;');
  expect(migration).not.toMatch(/^\s*SQLERRM/m);
});

it('executes the forward function with unique mutation UUIDs and correct snapshots offline', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA vault; CREATE SCHEMA net;
      CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
      CREATE TABLE net.requests (body jsonb, headers jsonb);
      CREATE FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)
      RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO net.requests VALUES (body, headers); RETURN 1;
      END $$;
      CREATE TABLE public.test_webhook_rows (id text, site_id text, status text);
    `);
    const credential = randomBytes(24).toString('hex');
    await db.query('INSERT INTO vault.decrypted_secrets VALUES ($1, $2), ($3, $4)', [
      'workflow_webhook_url', 'https://example.invalid/api/workflow/webhook', 'workflow_webhook_api_key', credential,
    ]);
    await db.exec(migration);
    await db.exec(`
      CREATE TRIGGER test_webhooks AFTER INSERT OR UPDATE OR DELETE ON public.test_webhook_rows
      FOR EACH ROW EXECUTE FUNCTION public.dispatch_workflow_database_webhook();
      INSERT INTO public.test_webhook_rows VALUES ('row-1', 'site-1', 'open');
      UPDATE public.test_webhook_rows SET status = 'closed';
      UPDATE public.test_webhook_rows SET status = 'closed';
      DELETE FROM public.test_webhook_rows;
    `);
    const { rows } = await db.query<{ body: Record<string, any>; headers: Record<string, string> }>('SELECT * FROM net.requests');
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(row => row.body.event_id)).size).toBe(4);
    for (const { body, headers } of rows) {
      expect(body.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(headers['x-api-key']).toBe(credential);
      expect(JSON.stringify(body)).not.toContain(credential);
    }
    expect(rows[0].body.old_record).toBeNull();
    expect(rows[1].body.record.status).toBe('closed');
    expect(rows[1].body.old_record.status).toBe('open');
    expect(rows[3].body.record).toBeNull();
    expect(rows[3].body.old_record).toEqual({ id: 'row-1', site_id: 'site-1', status: 'closed' });

    // Missing configuration and enqueue failures do not block row mutations.
    await db.exec(`DELETE FROM vault.decrypted_secrets;
      INSERT INTO public.test_webhook_rows VALUES ('row-2', 'site-1', 'open');
      DELETE FROM public.test_webhook_rows;`);
    await db.query('INSERT INTO vault.decrypted_secrets VALUES ($1, $2)', ['workflow_webhook_url', 'https://example.invalid']);
    await db.exec(`CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)
      RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'offline enqueue error'; END $$;
      INSERT INTO public.test_webhook_rows VALUES ('row-3', 'site-1', 'open');
      DELETE FROM public.test_webhook_rows;`);
    expect((await db.query('SELECT * FROM public.test_webhook_rows')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM net.requests')).rows).toHaveLength(4);
  } finally {
    await db.close();
  }
});