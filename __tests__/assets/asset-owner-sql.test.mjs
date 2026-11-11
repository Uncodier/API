import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../../supabase/migrations/20261111210000_asset_owner_admission.sql', import.meta.url), 'utf8');

test('asset owner admission preserves constraints, identity, RLS and tenant scope', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE TABLE public.sites(id uuid PRIMARY KEY, user_id uuid NOT NULL);
      CREATE TABLE public.remote_instances(id uuid PRIMARY KEY, site_id uuid NOT NULL REFERENCES sites, user_id uuid NOT NULL);
      CREATE TABLE public.assets(id uuid PRIMARY KEY, site_id uuid NOT NULL REFERENCES sites,
        instance_id uuid REFERENCES remote_instances, user_id uuid NOT NULL, file_path text NOT NULL);
      ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own_site ON public.assets TO authenticated
        USING (site_id::text = current_setting('test.site', true))
        WITH CHECK (site_id::text = current_setting('test.site', true));
      GRANT USAGE ON SCHEMA public,auth TO authenticated, service_role;
      GRANT ALL ON public.assets TO authenticated,service_role;
      GRANT SELECT ON public.sites,public.remote_instances TO service_role;`);
    await db.exec(migration);
    await db.exec(migration);
    const site = randomUUID(), other = randomUUID(), owner = randomUUID(), actor = randomUUID(), instance = randomUUID();
    await db.query('INSERT INTO sites VALUES ($1,$3),($2,$3)', [site, other, owner]);
    await db.query('INSERT INTO remote_instances VALUES ($1,$2,$3)', [instance,site,owner]);
    const insert = (siteId, instanceId, userId) => db.query(
      "INSERT INTO assets(id,site_id,instance_id,user_id,file_path) VALUES ($1,$2,$3,$4,'inline:test') RETURNING user_id",
      [randomUUID(),siteId,instanceId,userId]);
    await db.exec('SET ROLE service_role');
    assert.equal((await insert(site,instance,null)).rows[0].user_id,owner);
    assert.equal((await insert(site,null,null)).rows[0].user_id,owner);
    assert.equal((await insert(site,instance,actor)).rows[0].user_id,actor);
    await assert.rejects(insert(other,instance,null), /another site/);
    await assert.rejects(insert(site,randomUUID(),null), /instance not found/);
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('test.site',$2,false)", [actor,site]);
    await db.exec('SET ROLE authenticated');
    assert.equal((await insert(site,null,null)).rows[0].user_id,actor);
    await assert.rejects(insert(other,null,null), /row-level security/);
    await db.exec('RESET ROLE');
    const result = await db.query("SELECT attnotnull FROM pg_attribute WHERE attrelid='assets'::regclass AND attname='user_id'");
    assert.equal(result.rows[0].attnotnull,true);
    const fn = (await db.query("SELECT prosecdef FROM pg_proc WHERE oid='assign_missing_asset_owner()'::regprocedure")).rows[0];
    assert.equal(fn.prosecdef,false);
  } finally { await db.close(); }
});