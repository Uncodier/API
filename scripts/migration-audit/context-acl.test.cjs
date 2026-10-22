const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const source = fs.readFileSync(path.resolve(__dirname,
  '../../supabase/migrations/20261022032913_restore_legacy_context_usage_acl.sql'), 'utf8');
const signature = 'public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,text,timestamp with time zone)';

test('context ACL correction rejects body drift and revokes effective browser execution without changing data', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE metrics(v integer);
      CREATE FUNCTION ${signature} RETURNS void LANGUAGE plpgsql SECURITY INVOKER
        SET search_path=public,pg_temp AS $$ BEGIN RETURN; END $$;
      GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC,anon,authenticated,service_role;`);
    const baseline = (await db.query(`SELECT md5(prosrc) AS hash,pg_get_userbyid(proowner) AS owner
      FROM pg_proc WHERE oid=$1::regprocedure`, [signature])).rows[0];
    const fixture = source.replace('0a78194c85f6ac07e965394a620fd4a3', baseline.hash)
      .replaceAll("'postgres'", `'${baseline.owner}'`);
    await expect(db.exec(source.replaceAll("'postgres'", `'${baseline.owner}'`))).rejects.toThrow(/changed since audit/);
    await db.exec('ROLLBACK');
    await db.exec(fixture);
    for (const actor of ['anon', 'authenticated', 'service_role']) {
      const row = (await db.query('SELECT has_function_privilege($1,$2,$3) AS allowed',
        [actor, signature, 'EXECUTE'])).rows[0];
      expect(row.allowed).toBe(actor === 'service_role');
    }
    const after = (await db.query(`SELECT md5(prosrc) AS hash FROM pg_proc WHERE oid=$1::regprocedure`, [signature])).rows[0];
    expect(after.hash).toBe(baseline.hash);
    expect((await db.query('SELECT count(*)::integer AS n FROM metrics')).rows[0].n).toBe(0);
  } finally { await db.close(); }
}, 30000);