import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ids = {
  site: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherSite: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
  manager: '11111111-1111-4111-8111-111111111111',
  member: '22222222-2222-4222-8222-222222222222',
  outsider: '33333333-3333-4333-8333-333333333333',
};
export const instanceId = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;

/** Never consumes connection/environment credentials or opens a TCP listener. */
export function freshPostgres() {
  const root = mkdtempSync('/tmp/procurement-pg-');
  const data = join(root, 'data');
  const bin = '/opt/homebrew/bin/';
  const env = { PATH: process.env.PATH, HOME: root, LC_ALL: 'C' };
  const stop = () => {
    try { execFileSync(`${bin}pg_ctl`, ['-D', data, '-m', 'immediate', '-w', 'stop'], { env, stdio: 'pipe' }); }
    finally { rmSync(root, { recursive: true, force: true }); }
  };
  try {
    execFileSync(`${bin}initdb`, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale'], { env, stdio: 'pipe' });
    execFileSync(`${bin}pg_ctl`, ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-k ${root} -c listen_addresses='' -c unix_socket_permissions=0700`, '-w', 'start'], { env, stdio: 'pipe' });
  } catch (error) { stop(); throw error; }
  const result = (sql: string) => spawnSync(`${bin}psql`, [
    '-X', '-h', root, '-U', 'postgres', '-d', 'postgres', '-At',
    '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
  ], { input: sql, encoding: 'utf8', env });
  const query = (sql: string) => {
    const output = result(sql);
    if (output.status !== 0) throw new Error(output.stderr || String(output.error));
    return output.stdout.trim();
  };
  return { query, result, stop,
    migrate: (name: string) => query(readFileSync(resolve('supabase/migrations', name), 'utf8')),
  };
}

export function asActor(actor: string, sql: string) {
  return `BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claims = '{"sub":"${actor}","role":"authenticated"}';
    ${sql}; COMMIT;`;
}

export const fixture = `
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE anon NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
 SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
CREATE TABLE sites(id uuid PRIMARY KEY);
CREATE TABLE fixture_memberships(site_id uuid,user_id uuid,procurement_reader boolean,
 PRIMARY KEY(site_id,user_id));
INSERT INTO sites VALUES ('${ids.site}'),('${ids.otherSite}');
INSERT INTO fixture_memberships VALUES
 ('${ids.site}','${ids.manager}',true),('${ids.site}','${ids.member}',false),
 ('${ids.otherSite}','${ids.outsider}',true);
CREATE FUNCTION site_user_has_effective_access(p_site uuid,p_actor uuid)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.fixture_memberships WHERE site_id=p_site AND user_id=p_actor)
$$;
REVOKE ALL ON FUNCTION site_user_has_effective_access(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION site_user_has_effective_access(uuid,uuid) TO service_role;
-- Model existing tenant policies via a caller-bound entry point, not a grant on
-- the internal arbitrary-actor membership helper (revoked in production).
CREATE FUNCTION fixture_tenant_access(p_site uuid)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT public.site_user_has_effective_access(p_site,auth.uid())
$$;
CREATE FUNCTION procurement_tender_access(p_site uuid,p_action text)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.fixture_memberships
 WHERE site_id=p_site AND user_id=auth.uid() AND procurement_reader AND p_action='select')
$$;
CREATE TABLE remote_instances(id uuid PRIMARY KEY,site_id uuid REFERENCES sites,user_id uuid);
CREATE TABLE workflow_runs(id uuid PRIMARY KEY,instance_id uuid,site_id uuid,payload jsonb);
CREATE TABLE workflow_triggers(id uuid PRIMARY KEY,instance_id uuid,site_id uuid,kind text,config jsonb);
CREATE TABLE instance_plans(id uuid,instance_id uuid,site_id uuid,metadata jsonb);
CREATE TABLE instance_nodes(id uuid,instance_id uuid,site_id uuid);
CREATE TABLE instance_logs(id uuid,instance_id uuid,site_id uuid);
CREATE TABLE instance_context_state(instance_id uuid,site_id uuid);
CREATE TABLE instance_context_memories(instance_id uuid,site_id uuid);
GRANT USAGE ON SCHEMA public,auth TO authenticated;
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['remote_instances','workflow_runs','workflow_triggers',
 'instance_plans','instance_nodes','instance_logs','instance_context_state','instance_context_memories'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',target);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO authenticated',target);
 EXECUTE format('CREATE POLICY tenant_read ON public.%I FOR SELECT TO authenticated
 USING(public.fixture_tenant_access(site_id))',target);
 END LOOP;
END $$;
CREATE POLICY tenant_insert ON remote_instances FOR INSERT TO authenticated
 WITH CHECK(user_id=auth.uid() AND public.fixture_tenant_access(site_id));
`;
