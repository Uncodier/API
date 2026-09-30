import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const migration = readFileSync(resolve(process.cwd(),
  'supabase/migrations/20260930015000_apps_admin_mutation_rpc_acl.sql'), 'utf8');

function runOffline(check: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { PGlite } from '@electric-sql/pglite';
    const db = new PGlite();
    const migration = ${JSON.stringify(migration)};
    await db.exec(\`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE ROLE installer; CREATE ROLE unrelated; CREATE ROLE inherited_executor;
      GRANT USAGE, CREATE ON SCHEMA public TO installer;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, unrelated;
      SET ROLE installer;
      CREATE TABLE public.acl_probe(id int PRIMARY KEY, value text);
      CREATE FUNCTION public.exec_sql(q text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
        AS $$ BEGIN EXECUTE q; END $$;
      CREATE FUNCTION public.insert_schema_table_row(schema_name text, table_name text, insert_data jsonb)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
          EXECUTE format('INSERT INTO %I.%I VALUES ($1,$2)', schema_name, table_name)
            USING (insert_data->>'id')::int, insert_data->>'value';
        END $$;
      CREATE FUNCTION public.update_schema_table_row(schema_name text, table_name text, pk_col text, pk_val text, update_data jsonb)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
          EXECUTE format('UPDATE %I.%I SET value=$1 WHERE %I=$2', schema_name, table_name, pk_col)
            USING update_data->>'value', pk_val::int;
        END $$;
      CREATE FUNCTION public.delete_schema_table_rows(schema_name text, table_name text, pk_col text, pk_vals jsonb)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
          EXECUTE format('DELETE FROM %I.%I WHERE %I=$1', schema_name, table_name, pk_col)
            USING (pk_vals->>0)::int;
        END $$;
      CREATE FUNCTION public.unrelated_rpc() RETURNS int LANGUAGE sql AS 'SELECT 1';
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
      RESET ROLE;
    \`);
    const signatures = ['public.exec_sql(text)', 'public.insert_schema_table_row(text,text,jsonb)',
      'public.update_schema_table_row(text,text,text,text,jsonb)', 'public.delete_schema_table_rows(text,text,text,jsonb)'];
    const role = async (name, fn) => {
      await db.exec('SET ROLE '+name);
      try { return await fn(); } finally { await db.exec('RESET ROLE'); }
    };
    const apply = async () => {
      await db.exec('SET ROLE installer');
      try { await db.exec(migration); }
      catch (error) { await db.exec('ROLLBACK'); throw error; }
      finally { await db.exec('RESET ROLE'); }
    };
    const snapshot = async () => (await db.query("SELECT oid,proname,prosrc,proowner,proconfig,prosecdef FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows;
    const acls = async () => (await db.query("SELECT oid,proacl FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows;
    ${check}
    await db.close();
    console.log('ok');
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr?.slice(-8000) || result.error?.message || 'PGlite ACL verification failed');
  expect(result.stdout.trim()).toBe('ok');
}

describe('Apps administrative mutation RPC privilege repair', () => {
  it('removes public/browser execution, preserves service CRUD and definitions, and is idempotent', () => {
    runOffline(`
      const before = await snapshot();
      const unrelatedBefore = (await acls()).find(row => row.oid === before.find(fn => fn.proname === 'unrelated_rpc').oid);
      await apply();
      const repaired = await acls();
      await apply();
      assert.deepEqual(await acls(), repaired);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual((await acls()).find(row => row.oid === unrelatedBefore.oid), unrelatedBefore);
      const calls = [
        "SELECT public.exec_sql('SELECT 1')",
        "SELECT public.insert_schema_table_row('public','acl_probe','{\\"id\\":1,\\"value\\":\\"new\\"}')",
        "SELECT public.update_schema_table_row('public','acl_probe','id','1','{\\"value\\":\\"updated\\"}')",
        "SELECT public.delete_schema_table_rows('public','acl_probe','id','[1]')",
      ];
      for (const name of ['anon','authenticated','unrelated','service_role']) {
        for (const signature of signatures) {
          assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [name,signature])).rows[0].allowed, name === 'service_role');
        }
        if (name === 'service_role') continue;
        await role(name, async () => {
          for (const call of calls) await assert.rejects(db.exec(call), error => error.code === '42501');
          await db.exec('SELECT public.unrelated_rpc()');
        });
      }
      assert.deepEqual((await db.query('TABLE public.acl_probe')).rows, []);
      await role('service_role', () => db.exec(calls[0]));
      await role('service_role', () => db.exec(calls[1]));
      assert.deepEqual((await db.query('TABLE public.acl_probe')).rows, [{id:1,value:'new'}]);
      await role('service_role', () => db.exec(calls[2]));
      assert.deepEqual((await db.query('TABLE public.acl_probe')).rows, [{id:1,value:'updated'}]);
      await role('service_role', () => db.exec(calls[3]));
      assert.deepEqual((await db.query('TABLE public.acl_probe')).rows, []);
    `);
  }, 35_000);

  it.each(['inherited', 'overload', 'missing'])('rolls back all ACL changes for %s dependencies', kind => {
    runOffline(`
      const kind = ${JSON.stringify(kind)};
      if (kind === 'inherited') {
        await db.exec('GRANT inherited_executor TO authenticated; GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO inherited_executor');
      } else if (kind === 'overload') {
        await db.exec("CREATE FUNCTION public.exec_sql(text,int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN NULL; END'");
      } else {
        await db.exec('DROP FUNCTION public.delete_schema_table_rows(text,text,text,jsonb)');
      }
      const before = await acls();
      await assert.rejects(() => apply(), kind === 'missing' ? /does not exist/ : /inherited grant or unreviewed signature/);
      assert.deepEqual(await acls(), before);
      assert.deepEqual((await db.query('TABLE public.acl_probe')).rows, []);
    `);
  }, 35_000);
});