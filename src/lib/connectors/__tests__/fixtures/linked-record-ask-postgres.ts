import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { freshPostgres } from '@/lib/procurement/__tests__/fixtures/workflow-postgres';

type Database = ReturnType<typeof freshPostgres>;
type Fixture = { owner:string; site:string; instance:string; prior:string; connector:string; data:unknown[] };

/** Run after the connector-only chain, in the same disposable PG cluster. The
 * parent and record policies here reject even a reader role inheriting authenticated.
 * No fixture privacy assertions rely on the service role actually obeying RLS. */
export function checkLinkedRecordTurns(db:Database, f:Fixture) {
  const [a,b,extra,foreignSite,nativeInstance] = Array.from({length:5},()=>randomUUID());
  const {owner,site,instance,prior,connector,data} = f;
  const uuids = (ids:string[])=>`ARRAY[${ids.map(id=>`'${id}'`).join(',')}]::uuid[]`;
  const asService = (q:string)=>`SET ROLE service_role; ${q}`;
  const actor = (id=owner)=>`SET ROLE authenticated; SET request.jwt.claims='{"sub":"${id}","role":"authenticated","is_anonymous":false}'; `;
  const denied = (sql:string, code='42501') => { const r=db.result(sql); expect(r.status).not.toBe(0); expect(r.stderr).toContain(code); };
  const last = (q:string)=>db.query(q).split('\n').at(-1);
  const browser = (action:string)=>`SELECT public.read_connector_ask_answer('${action}');`;
  const read = (action:string,ids:string[])=>`SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]') FROM public.read_ask_linked_records('${action}',${uuids(ids)}) r;`;
  const store = (action:string,source:string|null,ids:string[])=>`SELECT public.store_linked_record_ask_turn('${action}','{}','Private: quarter 719','[]',${source?`'${source}'`:'NULL'},'{"bait":"private payload"}',${uuids(ids)});`;
  const context=(id:string)=>`SELECT public.connector_ask_context('${id}');`;
  const addTurn=(parent:string,ids:string[])=>{
    const action=randomUUID();
    db.query(`SET ROLE service_role; INSERT INTO public.instance_logs(id,site_id,instance_id,user_id,log_type,trusted_user_action,message,details)
      SELECT '${action}',site_id,'${parent}',user_id,'user_action',true,'${ids.map(id=>`/records/${id}`).join(' ')}',
        details || '{"prompt_source":"assistant_route"}'::jsonb || '${JSON.stringify(ids.length ? {ask_linked_record_ids:ids} : {})}'::jsonb FROM public.instance_logs WHERE id='${prior}';
      RESET ROLE;
      INSERT INTO connector_result_private.direct_ask_submissions VALUES ('${action}');
      UPDATE connector_result_private.direct_turn_heads SET action_id='${action}' WHERE instance_id='${parent}';`);
    return action;
  };
  db.query(`ALTER TABLE public.remote_instances ADD COLUMN is_archived boolean NOT NULL DEFAULT false;
    INSERT INTO public.remote_instances VALUES ('${nativeInstance}','${site}','${owner}',true,false);
    CREATE TABLE public.fixture_screen(site_id uuid,user_id uuid,blocked text[]);
    INSERT INTO public.fixture_screen VALUES ('${site}','${owner}','{}');
    GRANT SELECT ON public.fixture_screen TO authenticated;
    CREATE FUNCTION public.read_workspace_screen_scope(p_site_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
      SELECT jsonb_build_object('actor_id',user_id,'site_id',site_id,'role','collaborator','blocked_screens',blocked)
      FROM public.fixture_screen WHERE user_id=auth.uid() AND site_id=p_site_id AND current_user='authenticated' $$;
    CREATE TABLE public.records(id uuid PRIMARY KEY,site_id uuid,owner_id uuid,title text,description text,data jsonb,updated_at timestamptz,
      deleted_at timestamptz,visible boolean NOT NULL DEFAULT true);
    ALTER TABLE public.records ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON public.records TO authenticated;
    CREATE POLICY assigned_records ON public.records FOR SELECT TO authenticated USING (owner_id=auth.uid() AND visible AND current_user='authenticated');
    INSERT INTO public.records(id,site_id,owner_id,title,description,data,updated_at) VALUES
      ('${a}','${site}','${owner}','Revenue','Private narrative','{"Period":"2026-Q2","total":0}',now()),
      ('${b}','${site}','${owner}','Orders',null,'{"orders":2}',now()),
      ('${extra}','${site}','${owner}','Other',null,'{}',now());`);
  // Production migrations do not rely on superuser ownership of the existing
  // answer RPC. The migration runner inherits its owning role, as in Supabase.
  db.query(`CREATE ROLE migration_owner NOLOGIN NOSUPERUSER BYPASSRLS;
    GRANT service_role,connector_result_reader TO migration_owner;
    GRANT SELECT,INSERT ON public.instance_logs TO service_role;
    GRANT USAGE,CREATE ON SCHEMA public,connector_result_private,connector_direct_rpc TO migration_owner;
    ALTER DATABASE postgres OWNER TO migration_owner;
    ALTER TABLE connector_result_private.ask_answers OWNER TO migration_owner;
    ALTER TABLE connector_direct_rpc.ask_turn_gate OWNER TO migration_owner;
    GRANT ALL ON ALL TABLES IN SCHEMA public,connector_result_private,connector_direct_rpc TO migration_owner;
    ALTER FUNCTION connector_result_private.scope_ask_turn() OWNER TO migration_owner;
    ALTER FUNCTION connector_result_private.finish_ask_turn() OWNER TO migration_owner;
    SET ROLE migration_owner;
    ${readFileSync('supabase/migrations/20261126020000_ask_linked_records.sql','utf8')}`);
  const fresh=addTurn(nativeInstance,[a]); // no connector head at this instance
  expect(db.query(asService(context(fresh)))).not.toContain('source_id');
  denied(`UPDATE public.instance_logs SET details=details-'ask_linked_record_ids' WHERE id='${fresh}';`);
  const rows=JSON.parse(last(asService(read(fresh,[a])))!);
  expect(rows).toEqual([{id:a,title:'Revenue',description:'Private narrative',data:{Period:'2026-Q2',total:0},updated_at:expect.any(String)}]);
  denied(actor()+read(fresh,[a])); denied('SET ROLE anon; '+read(fresh,[a])); denied(actor()+store(fresh,null,[a]));
  denied(asService(read(fresh,[extra]))); denied(asService(store(fresh,null,[a,extra])));
  denied(`BEGIN; UPDATE public.records SET data=to_jsonb(repeat('x',131072)) WHERE id='${a}'; ${asService(read(fresh,[a]))}`, '22023');
  for(const effect of [`UPDATE public.instance_logs SET details=jsonb_set(details,'{status}','"cancelled"') WHERE id='${fresh}'`,
    `UPDATE public.instance_logs SET trusted_user_action=false WHERE id='${fresh}'`,
    `DELETE FROM connector_result_private.direct_ask_submissions WHERE action_id='${fresh}'`,
    `UPDATE public.instance_logs SET details=details || '{"prompt_source":"other"}' WHERE id='${fresh}'`,
    `UPDATE public.remote_instances SET is_archived=true`, `UPDATE public.remote_instances SET visible=false`,
    `UPDATE public.remote_instances SET user_id='${randomUUID()}'`]) {
    denied(`BEGIN; ${effect}; ${asService(read(fresh,[a]))}`);
  }
  expect(last(asService(store(fresh,null,[a])))).toBe('t');
  expect(last(asService(store(fresh,null,[a])))).toBe('t');
  expect(last(actor()+browser(fresh))).toBe('Private: quarter 719');
  expect(db.query(actor(randomUUID())+browser(fresh))).not.toContain('719');
  const sharedLog=JSON.parse(db.query(`SELECT jsonb_build_object('message',message,'details',details) FROM public.instance_logs WHERE parent_log_id='${fresh}'`));
  expect(sharedLog).toEqual({message:`This answer uses private workspace data. [Open your answer](/robots/private-answer/${fresh}).`,
    details:{user_log_id:fresh,response_type:'assistant_response',total_tool_calls:0}});
  expect(db.query(`SELECT count(*) FROM ask_record_auth.answer_gate`)).toBe('0');
  expect(db.query(`SELECT count(*) FROM connector_direct_rpc.ask_turn_gate`)).toBe('0');
  denied(actor()+`SELECT answer FROM connector_result_private.ask_answers;`);
  denied(actor()+`INSERT INTO ask_record_auth.answer_gate(action_id,record_ids) VALUES ('${fresh}','{}');`);
  expect(db.query(asService(`SELECT count(*) FROM public.read_ask_linked_records('${fresh}',${uuids([a])});
    SELECT coalesce(current_setting('connector_direct.linked_record_rows',true),'')='' AND current_user='service_role';`))).toMatch(/t$/);
  const next=addTurn(nativeInstance,[b]);
  expect(JSON.parse(last(asService(context(next)))!)).toEqual({source_id:fresh,answer:'Private: quarter 719',connector_ids:[],tool_context:[],record_ids:[a]});
  db.query(`UPDATE public.records SET data='{"Period":"2026-Q4","total":1}' WHERE id='${a}';`);
  expect(last(asService(read(next,[a,b])))).toContain('2026-Q4');
  denied(asService(read(next,[b]))); denied(asService(store(next,fresh,[a]))); denied(asService(store(next,null,[a,b])));
  expect(last(asService(store(next,fresh,[a,b])))).toBe('t');
  denied(asService(read(fresh,[a]))); // latest-turn fence, not just a running checkpoint
  denied(`BEGIN; DELETE FROM public.instance_logs WHERE id='${next}'; ${asService(read(fresh,[a]))}`);
  expect(last(actor()+browser(next))).toBe('Private: quarter 719');
  const follow=addTurn(nativeInstance,[]);
  expect(JSON.parse(last(asService(context(follow)))!).record_ids).toEqual([a,b].sort());
  expect(last(asService(read(follow,[b,a])))).toContain('2026-Q4');
  denied(asService(`SELECT public.store_connector_ask_turn('${follow}','{}','Older writer','[]','${next}');`));
  denied(asService(`SELECT public.connector_ask_followup('${follow}','${next}','Older writer');`));
  for (const effect of [`UPDATE public.records SET visible=false WHERE id='${a}'`, `UPDATE public.records SET deleted_at=now() WHERE id='${b}'`,
    `DELETE FROM public.records WHERE id='${a}'`, `UPDATE public.records SET site_id='${foreignSite}' WHERE id='${a}'`,
    `UPDATE public.fixture_screen SET blocked=ARRAY['records']`, `DELETE FROM public.fixture_screen`, `UPDATE public.remote_instances SET visible=false`]) {
    for(const q of [context(follow),read(follow,[a,b]),store(follow,next,[a,b])]) denied(`BEGIN; ${effect}; ${asService(q)}`);
    expect(db.query(`BEGIN; ${effect}; ${actor()+browser(next)} ROLLBACK;`)).not.toContain('719');
  }
  // Prior connector-only context + a new native source. Neither half alone authorizes delivery.
  const mixed=addTurn(instance,[b]);
  expect(JSON.parse(last(asService(context(mixed)))!)).toEqual({source_id:prior,answer:'Same data, revised report',connector_ids:[connector],tool_context:data});
  expect(last(asService(store(mixed,prior,[b])))).toBe('t');
  expect(last(actor()+browser(mixed))).toBe('Private: quarter 719');
  const mixedFollow=addTurn(instance,[]);
  const history=JSON.parse(last(asService(context(mixedFollow)))!);
  expect(history).toEqual({source_id:mixed,answer:'Private: quarter 719',connector_ids:[connector],tool_context:data,record_ids:[b]});
  expect(db.query(asService(`SELECT public.connector_ask_followup('${mixedFollow}');`))).toContain('unavailable');
  expect(last(actor()+browser(prior))).toBe('Same data, revised report');
  // Even with a live connector dispatch, none of the older writers may strip
  // native obligations by selecting an older connector-only source or no parent.
  const freshClaim=randomUUID();
  db.query(`INSERT INTO connector_result_private.direct_claims SELECT '${freshClaim}','${mixedFollow}',site_id,owner_id,instance_id,
    agent_id,connector_id,authorization_id,attestation_id,connector_revision,policy_revision,direct_revision,clock_timestamp(),NULL
    FROM connector_result_private.direct_claims WHERE id=(SELECT claims[1] FROM connector_result_private.ask_answers WHERE action_id='${prior}');
    UPDATE public.instance_logs SET agent_id=(SELECT agent_id FROM connector_result_private.direct_claims WHERE id='${freshClaim}') WHERE id='${mixedFollow}';`);
  denied(asService(`SELECT public.store_connector_ask_answer('${mixedFollow}',${uuids([freshClaim])},'Old writer');`));
  denied(asService(`SELECT public.connector_ask_followup('${mixedFollow}','${prior}','Old writer');`));

  for(const effect of ['UPDATE connector_result_private.fixture_grants SET enabled=false',`UPDATE public.records SET visible=false WHERE id='${b}'`]) {
    denied(`BEGIN; ${effect}; ${asService(read(mixedFollow,[b]))}`);
    denied(`BEGIN; ${effect}; ${asService(store(mixedFollow,mixed,[b]))}`);
    expect(db.query(`BEGIN; ${effect}; ${actor()+browser(mixed)} ROLLBACK;`)).not.toContain('719');
  }
}
