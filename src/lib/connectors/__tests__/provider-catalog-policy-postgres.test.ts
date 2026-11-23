import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../..');
const migration = (name: string) => readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');
const ordinary = migration('20261123150000_connector_ordinary_oauth.sql');
const delegation = migration('20261123152000_connector_customer_delegation.sql');
const memberPolicy = migration('20261123110000_connector_instance_member_policy.sql');
const forward = migration('20261123163000_connector_catalog_action_admission.sql');

// Load the actual predecessor definitions, not test copies of the admission/auth predicates.
const functionSql = (sql: string, name: string) => {
  const definition = sql.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION ${name.replace(/\./g, '\\.')}\\([\\s\\S]*?\\$\\$;`))?.[0];
  if (!definition) throw new Error(`Missing SQL function ${name}`);
  return definition;
};
const accountView = delegation.match(/CREATE OR REPLACE VIEW connector_result_private\.ordinary_accounts AS[\s\S]*?;/)?.[0];
if (!accountView) throw new Error('Missing ordinary_accounts view');

// Only referenced relations are bootstrapped. The live account view, actor, member/host/tool
// gates and RPC wrappers below are real migration SQL. No remote database or environment files.
const setup = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE ROLE connector_result_reader NOLOGIN;
  CREATE SCHEMA connector_result_private;
  REVOKE ALL ON SCHEMA connector_result_private FROM PUBLIC,anon,authenticated,service_role;
  GRANT USAGE ON SCHEMA connector_result_private TO connector_result_reader;
  CREATE TABLE public.sites(id uuid PRIMARY KEY,user_id uuid,archived_at timestamptz);
  CREATE TABLE public.site_ownership(site_id uuid,user_id uuid);
  CREATE TABLE public.site_members(id uuid PRIMARY KEY,site_id uuid,user_id uuid,status text,role text,
    manually_disabled boolean,license_suspended boolean,restrict_to_assigned_only boolean,blocked_screens text[]);
  CREATE TABLE public.site_member_location_restrictions(site_id uuid,site_member_id uuid);
  CREATE TABLE public.remote_instances(id uuid PRIMARY KEY,site_id uuid,user_id uuid,is_archived boolean);
  CREATE TABLE public.agents(id uuid PRIMARY KEY,site_id uuid,role text,status text);
  CREATE TABLE public.site_connector_providers(id uuid PRIMARY KEY,site_id uuid,project_id text,
    credential_revision text,status text,provider text,provider_user_id text);
  CREATE TABLE public.connectors(id uuid PRIMARY KEY,site_id uuid,created_by uuid,provider_id uuid,
    toolkit_slug text,provider_account_id text,auth_config_id text,provider_project_id text,supabase_project_ref text,
    revision integer,enabled boolean,verified_at timestamptz,provider_status text,revocation_dispatched boolean,
    revocation_pending boolean,granted_scopes text[],access_mode text);
  CREATE TABLE public.connector_policies(connector_id uuid PRIMARY KEY,site_id uuid,revision integer,
    tool_access_mode text,allowed_tools text[],allowed_hosts text[],require_approval boolean);
  CREATE TABLE public.connector_members(site_id uuid,connector_id uuid,user_id uuid,can_view boolean,
    can_use boolean,revoked_at timestamptz,expires_at timestamptz);
  CREATE TABLE public.connector_agents(site_id uuid,connector_id uuid,agent_id uuid,enabled boolean,
    revoked_at timestamptz,expires_at timestamptz);
  CREATE TABLE public.site_connector_auth_attempts(id uuid PRIMARY KEY,site_id uuid,connector_id uuid,
    user_id uuid,provider_id uuid,toolkit_slug text,provider_account_id text,auth_config_id text,
    credential_revision text,status text,ask_on_connect boolean,supabase_project_ref text);
  CREATE TABLE public.site_secrets(site_id uuid,provider text,use_case text,instance_id uuid,is_active boolean,encrypted_value text);
  CREATE TABLE connector_result_private.provider_attestations(site_id uuid,credential_revision text,project_id text);
  CREATE TABLE connector_result_private.ordinary_oauth_accounts(site_id uuid,connector_id uuid PRIMARY KEY,
    authorization_id uuid,granted_scopes text[],auth_scheme text,bound_project_ref text);
  CREATE TABLE connector_result_private.direct_revisions(connector_id uuid PRIMARY KEY,direct_revision integer);
  CREATE TABLE connector_result_private.direct_policy_events(connector_id uuid,direct_revision integer,enabled boolean);

  -- Unrelated licensing and resource-attested account paths are local seams. No resource
  -- attestations exist here: both real v2 wrappers must resolve the ordinary-account path.
  CREATE FUNCTION public.site_member_has_effective_license(p_member_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT NOT m.manually_disabled AND NOT m.license_suspended FROM public.site_members m WHERE m.id=p_member_id;
  $$;
  CREATE FUNCTION public.connector_direct_accounts(uuid,uuid,uuid,uuid,uuid,text) RETURNS jsonb
  LANGUAGE sql STABLE AS $$ SELECT '[]'::jsonb $$;
  CREATE FUNCTION public.connector_support_agent_account(uuid,uuid,uuid,text) RETURNS jsonb
  LANGUAGE sql STABLE AS $$ SELECT '[]'::jsonb $$;
  ${functionSql(ordinary, 'connector_result_private.business_screens')}
  ${accountView}
  ${functionSql(ordinary, 'connector_result_private.ordinary_slug')}
  ${functionSql(ordinary, 'connector_result_private.ordinary_tool_allowed')}
  ${functionSql(migration('20261123162000_connector_directory_reads.sql'), 'connector_result_private.customer_slug')}
  ${functionSql(migration('20261123154000_connector_delegated_project_actions.sql'), 'connector_result_private.account_tool_allowed')}
  ${functionSql(migration('20261119220101_connector_access_boundary.sql'), 'public.connector_effective_site_access')}
  ${functionSql(memberPolicy, 'connector_result_private.direct_disabled')}
  ${functionSql(memberPolicy, 'connector_result_private.instance_policy_accounts')}
  ${functionSql(migration('20261123010000_connector_provider_direct.sql'), 'connector_result_private.direct_actor')}
  ${functionSql(delegation, 'connector_result_private.ordinary_admissions')}
  ${functionSql(ordinary, 'public.connector_direct_accounts_v2')}
  ${functionSql(delegation, 'public.connector_support_agent_account_v2')}
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA connector_result_private FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
  GRANT EXECUTE ON FUNCTION public.connector_direct_accounts_v2(uuid,uuid,uuid,uuid,uuid,text),
    public.connector_support_agent_account_v2(uuid,uuid,uuid,text) TO service_role;
  REVOKE ALL ON ALL TABLES IN SCHEMA connector_result_private FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,anon,authenticated,service_role,connector_result_reader;
  GRANT SELECT,INSERT,UPDATE,DELETE ON public.connectors,public.site_connector_providers,public.site_connector_auth_attempts TO service_role;
  GRANT SELECT ON public.connector_policies,public.connector_members,public.connector_agents TO service_role;
  DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','connector_result_private') LOOP
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',r.schemaname,r.tablename);
    END LOOP;
  END $$;
`;

// PGlite's ESM/WASM loader runs in a fresh Node process, outside Jest's VM. Credentials
// and identities are synthetic runtime values; the child receives no database/provider env.
function verifyPostgres(body: string) {
  const script = String.raw`
    import { PGlite } from '@electric-sql/pglite';
    import assert from 'node:assert/strict';
    import { randomBytes, randomUUID } from 'node:crypto';
    const db = new PGlite();
    const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
    const one = async (sql, params = []) => (await rows(sql, params))[0];
    const ids = Object.fromEntries(['site','otherSite','owner','user','otherUser','member','instance','agent','otherAgent','provider'].map(k => [k,randomUUID()]));
    const revision = 'platform:' + randomBytes(32).toString('hex');
    const accounts = [
      {id:randomUUID(), authorization:randomUUID(), toolkit:'hubspot', scheme:null, project:null, scopes:['crm.objects.contacts.read'], slug:'HUBSPOT_RUN_SQL'},
      {id:randomUUID(), authorization:randomUUID(), toolkit:'stripe', scheme:'OAUTH2', project:null, scopes:[], slug:'STRIPE_EXECUTE_CODE'},
      {id:randomUUID(), authorization:randomUUID(), toolkit:'supabase', scheme:'API_KEY', project:'a'.repeat(20), scopes:[], slug:'SUPABASE_RUN_DATABASE_QUERY'},
    ];
    const allow = async (toolkit, wire, mode, tools, slug) => (await one(
      'SELECT connector_result_private.account_tool_allowed(jsonb_populate_record(NULL::connector_result_private.ordinary_accounts,$1::jsonb),$2::text) AS allowed',
      [JSON.stringify({toolkit_slug:toolkit,wire,tool_access_mode:mode,allowed_tools:tools}),slug])).allowed;
    const directArgs = a => [ids.site,ids.user,ids.instance,ids.agent,a.id,a.slug];
    const direct = async args => (await one('SELECT public.connector_direct_accounts_v2($1,$2,$3,$4,$5,$6) AS result',args)).result;
    const support = async a => (await one('SELECT public.connector_support_agent_account_v2($1,$2,$3,$4) AS result',[ids.site,ids.agent,a.id,a.slug])).result;
    const snapshot = async () => ({
      functions:await rows(
        "SELECT p.oid,p.proname,p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proargtypes::text,p.prorettype,p.prolang," +
        "CASE WHEN p.proname='account_tool_allowed' THEN NULL ELSE pg_get_functiondef(p.oid) END AS definition " +
        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','connector_result_private') " +
        "AND p.proname<>'customer_slug' ORDER BY p.oid"),
      relations:await rows("SELECT c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','connector_result_private') ORDER BY c.oid"),
      schemas:await rows("SELECT oid,nspowner,nspacl FROM pg_namespace WHERE nspname IN ('public','connector_result_private') ORDER BY oid"),
      data:await rows('SELECT to_jsonb(o) AS account FROM connector_result_private.ordinary_accounts o ORDER BY connector_id'),
    });
    try {
      await db.exec(${JSON.stringify(setup)});
      await db.query('INSERT INTO public.sites VALUES ($1,$2,NULL),($3,$4,NULL)',[ids.site,ids.owner,ids.otherSite,ids.otherUser]);
      await db.query("INSERT INTO public.site_members VALUES ($1,$2,$3,'active','collaborator',false,false,false,'{}')",[ids.member,ids.site,ids.user]);
      await db.query('INSERT INTO public.remote_instances VALUES ($1,$2,$3,false)',[ids.instance,ids.site,ids.user]);
      await db.query("INSERT INTO public.agents VALUES ($1,$2,'Customer Support','active'),($3,$4,'Customer Support','active')",[ids.agent,ids.site,ids.otherAgent,ids.otherSite]);
      await db.query("INSERT INTO public.site_connector_providers VALUES ($1,$2,$3,$4,'active','composio',$5)",[ids.provider,ids.site,'offline-project',revision,ids.site]);
      for (const a of accounts) {
        await db.query("INSERT INTO public.connectors VALUES ($1,$2,$3,$4,$5,$6,'offline-auth-config','offline-project',$7,1,true,now(),'ACTIVE',false,false,$8,'workspace')",
          [a.id,ids.site,ids.user,ids.provider,a.toolkit,randomUUID(),a.project,a.scopes]);
        await db.query("INSERT INTO public.connector_policies VALUES ($1,$2,1,'all','{}',ARRAY['assistant'],true)",[a.id,ids.site]);
        await db.query("INSERT INTO public.connector_agents VALUES ($1,$2,$3,true,NULL,NULL)",[ids.site,a.id,ids.agent]);
        await db.query("INSERT INTO public.site_connector_auth_attempts SELECT $1,site_id,id,created_by,provider_id,toolkit_slug,provider_account_id,auth_config_id,$2,'completed',true,supabase_project_ref FROM public.connectors WHERE id=$3",
          [a.authorization,revision,a.id]);
        await db.query('INSERT INTO connector_result_private.ordinary_oauth_accounts VALUES ($1,$2,$3,$4,$5,$6)',[ids.site,a.id,a.authorization,a.scopes,a.scheme,a.project]);
        await db.query('INSERT INTO connector_result_private.direct_revisions VALUES ($1,1)',[a.id]);
      }
      assert.equal((await rows('SELECT * FROM connector_result_private.ordinary_accounts')).length,3);
      assert.equal(await allow('hubspot',{},'all',[],'HUBSPOT_RUN_SQL'),false);
      assert.equal(await allow('supabase',{auth_scheme:'API_KEY'},'all',[],'SUPABASE_RUN_DATABASE_QUERY'),false);
      const before = await snapshot();
      await db.exec(${JSON.stringify(forward)});
      assert.deepEqual(await snapshot(),before,'Only the predicate body and removed helper may change; no data, owner, ACL or auth changes');
      assert.equal((await one("SELECT to_regprocedure('connector_result_private.customer_slug(text,text,text)') AS removed")).removed,null);
      const definition = (await one("SELECT pg_get_functiondef('connector_result_private.account_tool_allowed(connector_result_private.ordinary_accounts,text)'::regprocedure) AS definition")).definition;
      assert.doesNotMatch(definition,/customer_slug|ordinary_tool_allowed|auth_scheme|bound_project_ref/);
      ${body}
    } finally { await db.close(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: script, cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  if (result.status !== 0) throw new Error(result.stderr?.slice(-4000) || result.error?.message || 'Offline catalog policy PostgreSQL verification failed');
}

test('all and selected policies admit catalog actions equally for legacy, delegated OAuth/API-key and project-bound accounts', () => {
  verifyPostgres(String.raw`
    const variants = [{},{auth_scheme:'OAUTH2'},{auth_scheme:'API_KEY'}, {auth_scheme:'API_KEY',bound_project_ref:'a'.repeat(20)}];
    const actions = ['RUN_SQL','RUN_DATABASE_QUERY','EXECUTE_CODE','WRITE_FILE','DELETE_FILE','UPDATE_ADMIN',
      'CREATE_IAM_ROLE','UPDATE_RBAC_PERMISSIONS','CREATE_CREDENTIAL','UPDATE_OAUTH_TOKEN','GET_SECRETS',
      'PROXY_REQUEST','RUN_SHELL_SCRIPT','DEPLOY_WEBHOOK_WORKFLOW','CALL_RPC','RAW_GRAPHQL',
      'CREATE_PROMOTION_CODE','SEARCH_POSTAL_CODE','LIST_ROLES','UNFAMILIAR_CATALOG_ACTION'];
    for (const wire of variants) for (const kit of ['hubspot','supabase','google-drive']) {
      const prefix = kit.toUpperCase().replaceAll('-','_') + '_';
      for (const action of actions) {
        const slug = prefix + action;
        assert.equal(await allow(kit,wire,'all',[],slug),true,JSON.stringify({wire,slug}));
        assert.equal(await allow(kit,wire,'all',[prefix+'OTHER_TOOL'],slug),true);
        assert.equal(await allow(kit,wire,'selected',[slug],slug),true);
        assert.equal(await allow(kit,wire,'selected',[prefix+'OTHER_TOOL'],slug),false);
        assert.equal(await allow(kit,wire,'selected',[],slug),false);
      }
      assert.equal(await allow(kit,wire,'all',[],null),true);
      assert.equal(await allow(kit,wire,'selected',[],null),false);
      assert.equal(await allow(kit,wire,'selected',[prefix+'RUN_SQL'],null),true);
      // Discovery inventories even an unusable saved selection; exact checks still deny it.
      assert.equal(await allow(kit,wire,'selected',['COMPOSIO_RESERVED'],null),true);
      assert.equal(await allow(kit,wire,'selected',['COMPOSIO_RESERVED'],'COMPOSIO_RESERVED'),false);
      assert.equal(await allow(kit,wire,'none',[prefix+'RUN_SQL'],null),false);
      assert.equal(await allow(kit,wire,'none',[prefix+'RUN_SQL'],prefix+'RUN_SQL'),false);
    }
  `);
}, 35_000);

test('structural validity, exact toolkit, length and reserved COMPOSIO exclusion cannot be bypassed by all or selected', () => {
  verifyPostgres(String.raw`
    const invalid = ['', 'HUBSPOT', 'HUBSPOT_', '_HUBSPOT_SQL','hubspot_RUN_SQL','HUBSPOT_run_SQL',
      'HUBSPOT__SQL','HUBSPOT_RUN_SQL_','HUBSPOT_RUN-SQL','HUBSPOT.RUN_SQL','HUBSPOT_RUN:SQL',
      'HUBSPOT_RUN SQL','HUBSPOT_RUN_SQL\n','HUBSPOT_RUN_\tSQL','HUBSPOT_RUN_SQŁ','STRIPE_RUN_SQL','HUBSPOT2_RUN_SQL',
      'COMPOSIO_HUBSPOT_RUN_SQL','HUBSPOT_'+'A'.repeat(143)];
    for (const wire of [{},{auth_scheme:'OAUTH2'},{auth_scheme:'API_KEY',bound_project_ref:'a'.repeat(20)}]) {
      for (const slug of invalid) for (const mode of ['all','selected']) {
        assert.equal(await allow('hubspot',wire,mode,[slug],slug),false,JSON.stringify({wire,mode,slug}));
      }
      assert.equal(await allow('hubspot',wire,'all',[],'HUBSPOT_'+'A'.repeat(142)),true);
      assert.equal(await allow('google-drive',wire,'selected',['GOOGLE_DRIVE_WRITE_FILE'],'GOOGLE_DRIVE_WRITE_FILE'),true);
      assert.equal(await allow('google-drive',wire,'all',[],'GOOGLEDRIVE_WRITE_FILE'),false);
      assert.equal(await allow('composio',wire,'all',[],'COMPOSIO_RUN_SQL'),false);
      assert.equal(await allow('composio',wire,'selected',['COMPOSIO_RUN_SQL'],'COMPOSIO_RUN_SQL'),false);
    }
  `);
}, 35_000);

test('broader action admission preserves private permissions and account, actor, host, member and agent authorization', () => {
  verifyPostgres(String.raw`
    const privateSignature = 'connector_result_private.account_tool_allowed(connector_result_private.ordinary_accounts,text)';
    const directSignature = 'public.connector_direct_accounts_v2(uuid,uuid,uuid,uuid,uuid,text)';
    const supportSignature = 'public.connector_support_agent_account_v2(uuid,uuid,uuid,text)';
    for (const role of ['anon','authenticated','service_role','connector_result_reader']) {
      assert.deepEqual(await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS helper,has_function_privilege($1,$3,\'EXECUTE\') AS direct,has_function_privilege($1,$4,\'EXECUTE\') AS support',
        [role,privateSignature,directSignature,supportSignature]),{helper:false,direct:role==='service_role',support:role==='service_role'});
      assert.equal((await one('SELECT has_schema_privilege($1,\'connector_result_private\',\'USAGE\') AS usage',[role])).usage,role==='connector_result_reader');
      assert.equal((await one('SELECT has_table_privilege($1,\'connector_result_private.ordinary_accounts\',\'SELECT\') AS readable',[role])).readable,false);
      await db.exec('SET ROLE '+role);
      await assert.rejects(() => allow('hubspot',{},'all',[],'HUBSPOT_RUN_SQL'),{code:'42501'});
      await assert.rejects(() => rows('SELECT * FROM connector_result_private.ordinary_oauth_accounts'),{code:'42501'});
      if (role!=='service_role') {
        // Caller-controlled JWT text is not the SQL service role and cannot expand access.
        await db.query('SELECT set_config($1,$2,false)',['request.jwt.claim.role','service_role']);
        await assert.rejects(() => direct(directArgs(accounts[0])),{code:'42501'});
        await assert.rejects(() => support(accounts[0]),{code:'42501'});
      }
      await db.exec('RESET ROLE');
    }
    // Even the local superuser must satisfy the RPC's explicit service-role check.
    await assert.rejects(() => direct(directArgs(accounts[0])),{code:'42501'});
    await assert.rejects(() => support(accounts[0]),{code:'42501'});
    await db.exec('SET ROLE service_role');
    for (const a of accounts) {
      const admitted = await direct(directArgs(a));
      assert.equal(admitted.length,1); assert.equal(admitted[0].connector.id,a.id);
      assert.equal((await support(a)).length,1);
    }
    assert.equal((await direct([ids.site,ids.user,ids.instance,ids.agent,null,null])).length,3);
    for (const a of accounts) for (const [index,value] of [[0,ids.otherSite],[1,ids.otherUser],[2,randomUUID()],[3,ids.otherAgent],[4,randomUUID()]]) {
      const args = directArgs(a); args[index] = value;
      assert.deepEqual(await direct(args),[],'No cross-site/actor/instance/agent/account borrowing');
    }
    assert.deepEqual((await one('SELECT public.connector_support_agent_account_v2($1,$2,$3,$4) AS result',
      [ids.otherSite,ids.agent,accounts[0].id,accounts[0].slug])).result,[]);
    assert.deepEqual((await one('SELECT public.connector_support_agent_account_v2($1,$2,$3,$4) AS result',
      [ids.site,ids.otherAgent,accounts[0].id,accounts[0].slug])).result,[]);

    // Each mutation is rolled back, with no remote grants or persistence. The real SQL
    // authorization predicates must still deny powerful action names when a gate is lost.
    const deniedDuring = async (sql,params=[],directDenied=true,supportDenied=true) => {
      await db.exec('RESET ROLE; BEGIN');
      try {
        await db.query(sql,params);
        await db.exec('SET LOCAL ROLE service_role');
        for (const a of accounts) {
          const d = await direct(directArgs(a)), s = await support(a);
          assert.equal(d.length,directDenied?0:1,sql+' (member path)');
          assert.equal(s.length,supportDenied?0:1,sql+' (agent path)');
        }
      } finally { await db.exec('ROLLBACK'); }
    };
    // Dropping a name filter is not a new project grant. The submitted project,
    // completion record and connector must still match the delegated account.
    const bound = accounts.find(a => a.project!==null);
    for (const sql of [
      'UPDATE public.connectors SET supabase_project_ref=$1 WHERE id=$2',
      'UPDATE public.site_connector_auth_attempts SET supabase_project_ref=$1 WHERE connector_id=$2',
      'UPDATE connector_result_private.ordinary_oauth_accounts SET bound_project_ref=$1 WHERE connector_id=$2',
    ]) {
      await db.exec('RESET ROLE; BEGIN');
      try {
        await db.query(sql,['b'.repeat(20),bound.id]);
        await db.exec('SET LOCAL ROLE service_role');
        assert.deepEqual(await direct(directArgs(bound)),[]);
        assert.deepEqual(await support(bound),[]);
        for (const a of accounts.filter(a => a!==bound)) assert.equal((await direct(directArgs(a))).length,1);
      } finally { await db.exec('ROLLBACK'); }
    }
    for (const sql of [
      'UPDATE public.connectors SET enabled=false',
      "UPDATE public.connectors SET provider_status='INACTIVE'",
      'UPDATE public.connectors SET verified_at=NULL',
      'UPDATE public.connectors SET revocation_pending=true',
      'UPDATE public.connectors SET revocation_dispatched=true',
      "UPDATE public.connectors SET granted_scopes=ARRAY['unverified.scope']",
      "UPDATE public.site_connector_auth_attempts SET status='failed'",
      "UPDATE public.site_connector_auth_attempts SET provider_account_id='different-account'",
      "UPDATE public.site_connector_providers SET credential_revision='different-revision'",
      "UPDATE public.site_connector_providers SET status='disabled'",
      "UPDATE public.connector_policies SET allowed_hosts=ARRAY['direct']",
      "UPDATE public.connector_policies SET tool_access_mode='selected',allowed_tools=ARRAY['HUBSPOT_OTHER_TOOL']",
      "UPDATE public.connector_policies SET tool_access_mode='selected',allowed_tools='{}'",
      'DELETE FROM connector_result_private.ordinary_oauth_accounts',
      'INSERT INTO connector_result_private.direct_policy_events SELECT id,2,false FROM public.connectors',
      'UPDATE public.sites SET archived_at=now()',
      "UPDATE public.agents SET status='inactive'",
    ]) await deniedDuring(sql);

    for (const sql of [
      "UPDATE public.site_members SET status='inactive'",
      'UPDATE public.site_members SET manually_disabled=true',
      'UPDATE public.site_members SET license_suspended=true',
      'UPDATE public.site_members SET restrict_to_assigned_only=true',
      'UPDATE public.site_members SET blocked_screens=NULL',
      "UPDATE public.site_members SET blocked_screens=ARRAY['connectors']",
      "UPDATE public.site_members SET blocked_screens=ARRAY['aiWorkspace']",
      'INSERT INTO public.site_member_location_restrictions SELECT site_id,id FROM public.site_members',
      'UPDATE public.remote_instances SET is_archived=true',
      "UPDATE public.connectors SET access_mode='explicit'",
      'INSERT INTO public.connector_members SELECT site_id,id,created_by,true,false,NULL,NULL FROM public.connectors',
      "INSERT INTO public.connector_members SELECT site_id,id,created_by,true,true,now(),NULL FROM public.connectors",
      "INSERT INTO public.connector_members SELECT site_id,id,created_by,true,true,NULL,now()-interval '1 second' FROM public.connectors",
    ]) await deniedDuring(sql,[],true,false);
    // A known legacy screen profile keeps its business screen gate. Unknown delegated
    // profiles still fail closed on any blocked screen rather than guessing from names.
    await deniedDuring("UPDATE public.site_members SET blocked_screens=ARRAY['people']",[],true,false);
    for (const sql of [
      'UPDATE public.connector_agents SET enabled=false',
      'UPDATE public.connector_agents SET revoked_at=now()',
      "UPDATE public.connector_agents SET expires_at=now()-interval '1 second'",
      'DELETE FROM public.connector_agents',
      "UPDATE public.agents SET role='Other Role'",
    ]) await deniedDuring(sql,[],false,true);

    // A saved exact selection still works through the wrappers, and an empty selection
    // removes discovery without altering the underlying completion or account rows.
    await db.exec("RESET ROLE; UPDATE public.connector_policies p SET tool_access_mode='selected',allowed_tools=ARRAY[upper(c.toolkit_slug)||CASE c.toolkit_slug WHEN 'hubspot' THEN '_RUN_SQL' WHEN 'stripe' THEN '_EXECUTE_CODE' ELSE '_RUN_DATABASE_QUERY' END] FROM public.connectors c WHERE c.id=p.connector_id; SET ROLE service_role");
    for (const a of accounts) {
      assert.equal((await direct(directArgs(a))).length,1);
      assert.equal((await support(a)).length,1);
      const args = directArgs(a); args[5] = a.toolkit.toUpperCase()+'_UNSELECTED_TOOL';
      assert.deepEqual(await direct(args),[]);
    }
    assert.equal((await direct([ids.site,ids.user,ids.instance,ids.agent,null,null])).length,3);
    await db.exec("RESET ROLE; UPDATE public.connector_policies SET allowed_tools='{}'; SET ROLE service_role");
    assert.deepEqual(await direct([ids.site,ids.user,ids.instance,ids.agent,null,null]),[]);
    for (const a of accounts) assert.deepEqual(await support({...a,slug:null}),[]);
  `);
}, 35_000);