import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const sql = readFileSync(new URL('../../supabase/migrations/20261111223000_instance_asset_summaries.sql', import.meta.url), 'utf8');
test('bounded invoker summaries preserve RLS, ordering, counts and image paths', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.remote_instances(id uuid PRIMARY KEY, site_id uuid NOT NULL);
      CREATE TABLE public.assets(id uuid PRIMARY KEY,instance_id uuid,site_id uuid,file_path text,
        name text,file_type text,created_at timestamptz);
      ALTER TABLE remote_instances ENABLE ROW LEVEL SECURITY;
      ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
      CREATE POLICY instance_site ON remote_instances TO authenticated
        USING(site_id::text=current_setting('test.site',true));
      CREATE POLICY asset_site ON assets TO authenticated
        USING(site_id::text=current_setting('test.site',true));
      GRANT SELECT ON remote_instances,assets TO authenticated,service_role;`);
    await db.exec(sql);
    await db.exec(sql);
    const site = randomUUID(), other = randomUUID(), instance = randomUUID(), hidden = randomUUID(), empty = randomUUID();
    await db.query('INSERT INTO remote_instances VALUES ($1,$2),($3,$4),($5,$2)', [instance,site,hidden,other,empty]);
    for (let i=0;i<5;i++) await db.query(`INSERT INTO assets VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(),instance,site,`path-${i}`,`asset-${i}`,i===3?'image/png':'text/plain',`2026-11-11T00:00:0${i}Z`]);
    await db.query("SELECT set_config('test.site',$1,false)", [site]);
    await db.exec('SET ROLE authenticated');
    const result = await db.query('SELECT * FROM get_instance_asset_summaries($1,$2::uuid[])', [site,[instance,empty,hidden]]);
    assert.equal(result.rows.length,2);
    const summary = result.rows.find(r=>r.instance_id===instance);
    assert.equal(Number(summary.asset_count),5);
    assert.deepEqual(summary.recent_assets.map(r=>r.name),['asset-4','asset-3','asset-2']);
    assert.equal(summary.avatar_path,'path-3');
    assert.deepEqual(result.rows.find(r=>r.instance_id===empty).recent_assets,[]);
    assert.equal((await db.query('SELECT * FROM get_instance_asset_summaries($1,$2::uuid[])',[other,[hidden]])).rows.length,0);
    await assert.rejects(db.query('SELECT * FROM get_instance_asset_summaries($1,$2::uuid[])',[site,Array(101).fill(instance)]),/at most 100/);
    await db.exec('RESET ROLE; SET ROLE anon');
    await assert.rejects(db.query('SELECT * FROM get_instance_asset_summaries($1,$2::uuid[])',[site,[instance]]),/permission denied/);
    await db.exec('RESET ROLE');
    const fn=(await db.query("SELECT prosecdef FROM pg_proc WHERE oid='get_instance_asset_summaries(uuid,uuid[])'::regprocedure")).rows[0];
    assert.equal(fn.prosecdef,false);
    const indexes=(await db.query("SELECT indexname FROM pg_indexes WHERE tablename='assets'")).rows.map(r=>r.indexname);
    assert.ok(indexes.includes('assets_instance_created_id_idx'));
    assert.ok(indexes.includes('assets_instance_image_created_id_idx'));
  } finally {await db.close();}
});