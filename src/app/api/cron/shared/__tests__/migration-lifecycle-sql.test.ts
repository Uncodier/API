import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../../../..');
const scenarios = [
  'service-only ACLs and RLS',
  'canonical paths and bounded typed values',
  'CAS versions and execution generation',
  'durable reviewing lease and immutable provenance',
  'fresh validation required before completion',
  'platform review blocks user and cron reopen',
  'existing resume RPC cannot reopen a platform hold',
  'explicit release preserves other file holds',
  'platform hold and status change are atomic',
  'status guard observes other trigger changes',
] as const;
let report: Record<string, { ok: boolean; error?: string }>;

beforeAll(() => {
  // Isolated in-memory PostgreSQL; no Supabase clients, .env, data directory,
  // network or live DB. A native child avoids Jest's WASM/ESM loader limitations.
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import { readFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    const db = new PGlite();
    const report = {};
    const table = 'public.requirement_migration_lifecycle';
    const signature = 'public.transition_requirement_migration(uuid,text,integer,integer,jsonb)';
    const rpc = 'SELECT public.transition_requirement_migration($1,$2,$3,$4,$5::jsonb) AS value';
    const hash = 'a'.repeat(64);
    const spec = 'b'.repeat(64);
    const file = 'supabase/migrations/0001_access.sql';
    const value = (state = 'correction_required', extra = {}) => ({
      state, checksum: hash, specification_checksum: spec, original_sql: 'SELECT 1;',
      reason: 'Preserve ownership and verify the applied migration.', review: null, attempts: 0, ...extra,
    });
    let sequence = 0;
    async function requirement(metadata = { requirement_execution_generation: 7 }) {
      const id = '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0');
      await db.query('INSERT INTO public.requirements(id,status,metadata) VALUES ($1,$2,$3)', [id, 'in-progress', metadata]);
      return id;
    }
    async function asRole(role, query, args = []) {
      await db.exec('SET ROLE ' + role);
      try { return await db.query(query, args); }
      finally { await db.exec('RESET ROLE'); }
    }
    async function transition(id, version = 0, next = value(), generation = 7, path = file, role = 'service_role') {
      return (await asRole(role, rpc, [id, path, version, generation, next])).rows[0].value;
    }
    async function rejected(action, code, message) {
      await assert.rejects(action, error => error.code === code && (!message || error.message.includes(message)));
    }
    async function row(id, path = file) {
      return (await asRole('service_role', 'SELECT * FROM ' + table + ' WHERE requirement_id=$1 AND file=$2', [id,path])).rows[0];
    }
    async function req(id) { return (await db.query('SELECT * FROM public.requirements WHERE id=$1', [id])).rows[0]; }
    async function status(id, next, role = 'authenticated') {
      return asRole(role, 'UPDATE public.requirements SET status=$2 WHERE id=$1', [id,next]);
    }
    async function scenario(name, work) {
      try { await work(); report[name] = { ok: true }; }
      catch (error) { report[name] = { ok: false, error: error.stack }; }
    }
    try {
      await db.exec(
        "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; " +
        "CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE public_only NOLOGIN; " +
        "GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role,public_only; " +
        "CREATE TABLE public.requirements(id uuid PRIMARY KEY, status text NOT NULL, metadata jsonb, updated_at timestamptz DEFAULT now()); " +
        "CREATE TABLE public.instance_plans(id uuid PRIMARY KEY, instance_id uuid, status text, steps jsonb, metadata jsonb, completed_at timestamptz, updated_at timestamptz); " +
        "CREATE TABLE public.remote_instances(id uuid PRIMARY KEY, status text); " +
        "ALTER TABLE public.requirements ENABLE ROW LEVEL SECURITY; " +
        "CREATE POLICY fixture_user ON public.requirements TO authenticated USING (true) WITH CHECK (true); " +
        "GRANT SELECT,UPDATE ON public.requirements TO authenticated,service_role; " +
        "CREATE FUNCTION public.fixture_cron_resume(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ " +
        "UPDATE public.requirements SET status='in-progress', metadata=metadata || jsonb_build_object('requirement_execution_generation',8) WHERE id=p_id $$;"
      );
      await db.exec(readFileSync('supabase/migrations/20260917203600_atomic_instance_execution_resume.sql', 'utf8'));
      await db.exec(readFileSync('supabase/migrations/20260930010000_requirement_migration_lifecycle.sql', 'utf8'));

      await scenario('service-only ACLs and RLS', async () => {
        const id = await requirement();
        await transition(id);
        assert.equal((await row(id)).version, 1);
        const info = (await db.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [table])).rows[0];
        assert.equal(info.relrowsecurity, true);
        for (const role of ['anon','authenticated','public_only','service_role']) {
          const acl = (await db.query(
            "SELECT has_table_privilege($1,$2,'SELECT') AS read, has_function_privilege($1,$3,'EXECUTE') AS execute, " +
            "has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS mutate", [role, table, signature]
          )).rows[0];
          assert.deepEqual(acl, { read: role === 'service_role', execute: role === 'service_role', mutate: false });
          if (role !== 'service_role') {
            await rejected(() => transition(id, 1, value(), 7, file, role), '42501');
            await rejected(() => asRole(role, 'SELECT * FROM ' + table), '42501');
          }
          await rejected(() => asRole(role, 'UPDATE ' + table + " SET state='validated' WHERE requirement_id=$1", [id]), '42501');
          await rejected(() => asRole(role, 'DELETE FROM ' + table + ' WHERE requirement_id=$1', [id]), '42501');
          await rejected(() => asRole(role, 'INSERT INTO ' + table + ' SELECT * FROM ' + table + ' WHERE requirement_id=$1', [id]), '42501');
          await rejected(() => asRole(role, 'TRUNCATE ' + table), '42501');
        }
        // Prove the read policy works even without Supabase's BYPASSRLS role flag.
        await db.exec('ALTER ROLE service_role NOBYPASSRLS');
        assert.equal((await row(id)).requirement_id, id);
        await db.exec('ALTER ROLE service_role BYPASSRLS');
        for (const name of [signature, 'public.guard_requirement_migration_status()']) {
          const fn = (await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure", [name])).rows[0];
          assert.equal(fn.prosecdef, true);
          assert.deepEqual(fn.proconfig, ['search_path=""']);
        }
      });

      await scenario('canonical paths and bounded typed values', async () => {
        const id = await requirement();
        for (const path of ['migrations/0001.sql','supabase/migrations/nested/0001.sql','src/db/migrations/0001.sql','platform/0001.sql']) {
          assert.equal((await transition(id, 0, value(), 7, path)).file, path);
        }
        for (const path of [null,'/migrations/a.sql','./migrations/a.sql','migrations/../a.sql','migrations/./a.sql',
          'migrations//a.sql','migrations/a.ts','migrations/a.SQL','migrations/a.sql\n','migrations/a.sql; DROP TABLE requirements',
          'migrations\\a.sql','platform/.hidden.sql','src/db/migrations/a%2fb.sql','other/a.sql','migrations/' + 'x'.repeat(512) + '.sql']) {
          await rejected(() => transition(id, 0, value(), 7, path), '22023');
        }
        const bad = [null, [], {}, value('unknown'), value('validated', { state: null }),
          value('correction_required', { checksum: hash.slice(1) }), value('correction_required', { checksum: 'A'.repeat(64) }),
          value('correction_required', { checksum: hash + '\n' }), value('correction_required', { specification_checksum: 'z'.repeat(64) }),
          value('correction_required', { reason: null }), value('correction_required', { reason: 'x'.repeat(2049) }),
          value('correction_required', { original_sql: 'é'.repeat(32769) }), value('correction_required', { original_sql: {} }),
          value('correction_required', { attempts: -1 }), value('correction_required', { attempts: 6 }),
          value('correction_required', { attempts: 1.5 }), value('correction_required', { attempts: '1' }),
          value('correction_required', { attempts: null }), value('correction_required', { version: 1 })];
        for (const invalid of bad) await rejected(() => transition(id, 0, invalid), '22023');
        const bounded = await transition(id, 0, value('correction_required', { original_sql: 'é'.repeat(32768), reason: 'é'.repeat(2048), review: { fields: ['preserved'] } }));
        assert.equal(Buffer.byteLength(bounded.original_sql), 65536);
        assert.deepEqual(bounded.review, { fields: ['preserved'] });
        for (const state of ['validated','validation_pending']) {
          const fresh = await requirement();
          await rejected(() => transition(fresh, 0, value(state)), '23514');
        }
      });

      await scenario('CAS versions and execution generation', async () => {
        const id = await requirement();
        await rejected(() => transition(id, 1), '40001', 'version conflict');
        await rejected(() => transition(id, 0, value(), 6), '40001', 'execution generation');
        const first = await transition(id);
        assert.equal(first.version, 1);
        assert.equal(first.requirement_id, id);
        assert.equal(typeof first.updated_at, 'string');
        await rejected(() => transition(id), '40001', 'version conflict');
        await rejected(() => transition(id, 1, value(), 8), '40001', 'execution generation');
        assert.equal((await row(id)).version, 1);
        await db.query("UPDATE public.requirements SET metadata=jsonb_build_object('requirement_execution_generation',8) WHERE id=$1", [id]);
        await rejected(() => transition(id, 1), '40001', 'execution generation');
        assert.equal((await transition(id, 1, value(), 8)).version, 2);
        for (const metadata of [{}, null]) {
          const absent = await requirement(metadata);
          assert.equal((await transition(absent, 0, value(), 0)).version, 1);
        }
        for (const invalid of [null, -1, 1.5, 'bad', '07', 2147483648]) {
          const malformed = await requirement({ requirement_execution_generation: invalid });
          await rejected(() => transition(malformed, 0, value(), 0), '22023');
        }
        const malformed = await requirement([]);
        await rejected(() => transition(malformed, 0, value(), 0), '22023');
        for (const args of [[id,file,null,7,value()], [id,file,-1,7,value()], [id,file,2147483647,7,value()],
          [id,file,0,null,value()], [id,file,0,-1,value()], [null,file,0,7,value()]]) {
          await rejected(() => asRole('service_role', rpc, args), '22023');
        }
        await rejected(() => transition('00000000-0000-4000-8000-999999999999'), 'P0002');
      });

      await scenario('durable reviewing lease and immutable provenance', async () => {
        const id = await requirement();
        let current = await transition(id);
        current = await transition(id, 1, value('correction_required', { attempts: 1 }));
        await rejected(() => transition(id, 2, value('reviewing', { attempts: 1 })), '23514', 'lease');
        current = await transition(id, 2, value('reviewing', { checksum: 'c'.repeat(64), attempts: 2, review: { decision: 'reviewing' } }));
        await rejected(() => transition(id, 2, value('reviewing', { attempts: 2 })), '40001');
        await rejected(() => transition(id, 3, value('reviewing', { attempts: 3 })), '23514', 'transition');
        const pending = value('validation_pending', { checksum: current.checksum, attempts: 2 });
        await rejected(() => transition(id, 3, { ...pending, attempts: 0 }), '23514');
        await rejected(() => transition(id, 3, { ...pending, checksum: hash }), '23514', 'checksum');
        await rejected(() => transition(id, 3, { ...pending, specification_checksum: 'd'.repeat(64) }), '23514', 'specification');
        await rejected(() => transition(id, 3, { ...pending, original_sql: 'SELECT 2;' }), '23514', 'Original');
        await rejected(() => transition(id, 3, { ...pending, original_sql: null }), '23514', 'Original');
        const { original_sql, review, ...omitted } = pending;
        current = await transition(id, 3, omitted);
        assert.equal(current.original_sql, 'SELECT 1;');
        assert.deepEqual(current.review, { decision: 'reviewing' });
        current = await transition(id, 4, value('correction_required', { checksum: current.checksum, attempts: 2 }));
        current = await transition(id, 5, value('reviewing', { attempts: 3 }));
        current = await transition(id, 6, value('correction_required', { attempts: 5 }));
        await rejected(() => transition(id, 7, value('reviewing', { attempts: 5 })), '23514');
        assert.equal((await row(id)).attempts, 5);
        assert.equal((await transition(id, 7, value('platform_review', { attempts: 5 }))).attempts, 5);
      });

      await scenario('fresh validation required before completion', async () => {
        const id = await requirement();
        await transition(id);
        for (const end of ['done','on-review']) await rejected(() => status(id, end), '23514', 'unvalidated');
        await status(id, 'blocked');
        await status(id, 'in-progress'); // Corrections may resume, unlike a platform hold.
        await rejected(() => transition(id, 1, value('validated')), '23514');
        await transition(id, 1, value('reviewing', { attempts: 1 }));
        await rejected(() => status(id, 'done', 'service_role'), '23514');
        await transition(id, 2, value('validation_pending', { attempts: 1 }));
        for (const end of ['done','on-review']) await rejected(() => status(id, end, 'service_role'), '23514');
        await status(id, 'blocked');
        await status(id, 'in-progress');
        await transition(id, 3, value('validated', { attempts: 1 }));
        await status(id, 'on-review');
        await status(id, 'done');
        await rejected(() => transition(id, 4, value('correction_required', { attempts: 1 })), '23514');
        await rejected(() => transition(id, 4, value('platform_review', { attempts: 1, checksum: 'c'.repeat(64) })), '23514');
        await transition(id, 4, value('platform_review', { attempts: 1 }));
        assert.equal((await req(id)).status, 'blocked');
        const unrelated = await requirement();
        await status(unrelated, 'done');
        assert.equal((await req(unrelated)).status, 'done');
      });

      await scenario('platform review blocks user and cron reopen', async () => {
        const id = await requirement();
        await transition(id, 0, value('platform_review'));
        assert.equal((await req(id)).status, 'blocked');
        for (const role of ['authenticated','service_role']) {
          for (const next of ['backlog','in-progress','done','on-review','cancelled']) {
            await rejected(() => status(id, next, role), '23514', 'platform review');
          }
          await rejected(() => asRole(role, 'SELECT public.fixture_cron_resume($1)', [id]), '23514');
          assert.equal((await req(id)).metadata.requirement_execution_generation, 7);
          await status(id, 'blocked', role);
          await asRole(role, "UPDATE public.requirements SET metadata=metadata || '{\"heartbeat\":true}'::jsonb WHERE id=$1", [id]);
          await asRole(role, "SELECT set_config('app.requirement_migration_bypass','true',false)");
          await rejected(() => status(id, 'in-progress', role), '23514');
        }
        assert.equal((await req(id)).metadata.heartbeat, true);
        assert.equal((await row(id)).state, 'platform_review');
      });

      await scenario('explicit release preserves other file holds', async () => {
        const id = await requirement();
        const second = 'platform/0002.sql';
        await transition(id, 0, value('platform_review'));
        await transition(id, 0, value('platform_review'), 7, second);
        await rejected(() => transition(id, 1, value('correction_required'), 7, file, 'authenticated'), '42501');
        await transition(id, 1, value('correction_required'));
        await rejected(() => status(id, 'in-progress'), '23514', 'platform review');
        await transition(id, 1, value('validation_pending'), 7, second);
        assert.equal((await req(id)).status, 'blocked'); // Release never auto-resumes.
        await status(id, 'in-progress');
        await rejected(() => status(id, 'done'), '23514', 'unvalidated');
        await transition(id, 2, value('validated'), 7, second);
        await rejected(() => status(id, 'done'), '23514', 'unvalidated');
      });

      await scenario('existing resume RPC cannot reopen a platform hold', async () => {
        const id = await requirement();
        const instanceId = '10000000-0000-4000-8000-000000000001';
        const planId = '20000000-0000-4000-8000-000000000001';
        const steps = [{ id: 'sql', status: 'pending', infrastructure_generation: 3, infra_retry_count: 2 }];
        await db.query("INSERT INTO public.remote_instances(id,status) VALUES ($1,'paused')", [instanceId]);
        await db.query("INSERT INTO public.instance_plans(id,instance_id,status,steps,metadata) VALUES ($1,$2,'paused',$3,$4)",
          [planId, instanceId, JSON.stringify(steps), { requirement_id: id }]);
        await transition(id, 0, value('platform_review'));
        const before = await req(id);
        const resume = 'SELECT public.resume_instance_execution_on_user_action($1,$2,true,$3,$4) AS value';
        for (const allowTerminalReopen of [false, true]) {
          await rejected(() => asRole('service_role', resume, [id, instanceId, 'user-reopen', allowTerminalReopen]), '23514', 'platform review');
          assert.deepEqual(await req(id), before);
          assert.equal((await db.query('SELECT status FROM public.remote_instances WHERE id=$1', [instanceId])).rows[0].status, 'paused');
          assert.deepEqual((await db.query('SELECT status,steps FROM public.instance_plans WHERE id=$1', [planId])).rows[0], { status: 'paused', steps });
        }
        await transition(id, 1, value('correction_required'));
        const resumed = (await asRole('service_role', resume, [id, instanceId, 'user-reopen', true])).rows[0].value;
        assert.equal(resumed.state, 'applied');
        assert.equal((await req(id)).status, 'in-progress');
        assert.equal((await req(id)).metadata.requirement_execution_generation, 8);
        assert.equal((await row(id)).state, 'correction_required');
        assert.equal((await row(id)).version, 2);
        await rejected(() => transition(id, 2, value('reviewing', { attempts: 1 }), 7), '40001');
        await transition(id, 2, value('reviewing', { attempts: 1 }), 8);
      });

      await scenario('platform hold and status change are atomic', async () => {
        const id = await requirement({ requirement_execution_generation: 7, fail_block: true });
        await db.exec("CREATE FUNCTION public.fixture_fail_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " +
          "IF NEW.status='blocked' AND NEW.metadata->>'fail_block'='true' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$; " +
          "CREATE TRIGGER fixture_fail_block BEFORE UPDATE ON public.requirements FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_block()");
        await rejected(() => transition(id, 0, value('platform_review')), 'P0001');
        assert.equal(await row(id), undefined);
        assert.equal((await req(id)).status, 'in-progress');
        await transition(id);
        await rejected(() => transition(id, 1, value('platform_review')), 'P0001');
        assert.equal((await row(id)).version, 1);
        assert.equal((await row(id)).state, 'correction_required');
        await db.exec('DROP TRIGGER fixture_fail_block ON public.requirements; DROP FUNCTION public.fixture_fail_block()');
      });

      await scenario('status guard observes other trigger changes', async () => {
        const id = await requirement();
        await transition(id, 0, value('platform_review'));
        await db.exec("CREATE FUNCTION public.fixture_hidden_reopen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " +
          "IF NEW.metadata->>'hidden_reopen'='true' THEN NEW.status := 'in-progress'; END IF; RETURN NEW; END $$; " +
          "CREATE TRIGGER fixture_hidden_reopen BEFORE UPDATE ON public.requirements FOR EACH ROW EXECUTE FUNCTION public.fixture_hidden_reopen()");
        await rejected(() => asRole('authenticated', "UPDATE public.requirements SET metadata=metadata || '{\"hidden_reopen\":true}'::jsonb WHERE id=$1", [id]), '23514');
        assert.equal((await req(id)).status, 'blocked');
        await db.exec('DROP TRIGGER fixture_hidden_reopen ON public.requirements; DROP FUNCTION public.fixture_hidden_reopen()');
      });
      console.log(JSON.stringify(report));
    } finally { await db.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr?.slice(-5000) || child.error?.message || 'PGlite lifecycle runner failed');
  report = JSON.parse(child.stdout.trim());
}, 35_000);

describe('Makinari migration lifecycle SQL (real offline PostgreSQL)', () => {
  it.each(scenarios)('%s', name => {
    expect(report[name]).toEqual({ ok: true });
  });
});