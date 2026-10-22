const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const source = fs.readFileSync(path.resolve(__dirname,
  '../../supabase/migrations/20261022033613_bound_audited_vector_search_paths.sql'), 'utf8');

test('vector path convergence preserves invoker bodies and effective grants and rejects drift', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE DOMAIN vector AS text; CREATE SCHEMA extensions;');
    const contracts = [...source.matchAll(/\('([^']+)','([a-f0-9]{32})',(NULL::text\[\]|ARRAY\[[^\]]+\]::text\[\]),'([^']+)'\)/g)];
    expect(contracts).toHaveLength(4);
    let fixture = source;
    for (const [, signature, hash, config, acl] of contracts) {
      const names = signature.slice(signature.indexOf('(') + 1, -1).split(',').map((type, i) => `p_${i} ${type}`).join(',');
      const name = signature.slice(0, signature.indexOf('('));
      const setting = config.includes('NULL') ? '' : 'SET search_path=public,pg_temp';
      await db.exec(`CREATE FUNCTION ${name}(${names}) RETURNS void LANGUAGE plpgsql SECURITY INVOKER ${setting} AS $$ BEGIN RETURN; END $$;
        REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC; GRANT EXECUTE ON FUNCTION ${signature} TO service_role;
        ${acl.includes('authenticated=') ? `GRANT EXECUTE ON FUNCTION ${signature} TO authenticated;` : ''}`);
      const row = (await db.query('SELECT md5(prosrc) AS hash,pg_get_userbyid(proowner) AS owner,proacl::text AS acl FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0];
      fixture = fixture.replace(hash, row.hash).replaceAll("'postgres'", `'${row.owner}'`)
        .replaceAll(acl, row.acl);
    }
    await db.exec(fixture);
    const rows = (await db.query(`SELECT prosecdef,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname
      IN ('commit_instance_context_memory','match_instance_context_memories','match_records_vector','get_records_similarity_edges')`)).rows;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.prosecdef).toBe(false);
      expect(row.proconfig).toEqual(['search_path=public, extensions, pg_temp']);
    }
    await expect(db.exec(fixture)).rejects.toThrow(/changed since migration audit/);
    await db.exec('ROLLBACK');
  } finally { await db.close(); }
}, 30000);