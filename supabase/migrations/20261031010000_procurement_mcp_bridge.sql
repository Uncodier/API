BEGIN;

-- Install AFTER the market-fit procurement domain migrations, including policy
-- versions, requests/tenders/events, commerce reads, lifecycle repair,
-- free_text_quotations, quotation_envelopes and quotation_detail (20261030220000).
-- This migration is an adapter, not a replacement domain or a generic SQL proxy.
-- Missing dependencies abort deployment; never fall back to legacy AP tables.
DO $$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.current_user_site_role(uuid)',
    'public.current_user_has_site_location_restrictions(uuid)',
    'public.procurement_tender_access(uuid,text)',
    'public.save_procurement_request(uuid,uuid,integer,jsonb)',
    'public.revalidate_procurement_request(uuid,uuid,integer)',
    'public.decide_procurement_request(uuid,uuid,integer,uuid,text,text)',
    'public.submit_procurement_request(uuid,uuid,integer,integer,uuid,jsonb)',
    'public.save_procurement_tender(uuid,uuid,integer,jsonb)',
    'public.transition_procurement_tender(uuid,uuid,integer,text)',
    'public.set_procurement_tender_participant(uuid,uuid,integer,uuid,text)',
    'public.configure_procurement_tender_portal(uuid,boolean)',
    'public.create_procurement_event_approval(uuid,uuid,integer,text,uuid,integer,jsonb)',
    'public.create_procurement_commerce_approval(uuid,uuid,integer,text,uuid,integer,jsonb)',
    'public.decide_procurement_event(uuid,uuid,uuid,text,text)',
    'public.procurement_inherited_policy(uuid,uuid,text)',
    'public.procurement_commerce_event_context(uuid,uuid,integer,text)',
    'public.list_procurement_quotations(uuid)',
    'public.list_procurement_quotation_envelopes(uuid)',
    'public.get_procurement_quotation(uuid,uuid)',
    'public.procurement_quotation_options(uuid)',
    'public.record_procurement_quotation(uuid,jsonb)',
    'public.list_procurement_orders(uuid)',
    'public.record_procurement_receipt(uuid,jsonb)'
  ] LOOP
    IF pg_catalog.to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'Procurement MCP dependency missing: %', signature USING ERRCODE='55000';
    END IF;
  END LOOP;
END $$;

-- Private reference validator. Its document comes ONLY from saved policy below.
-- Mirrors validatePolicyReferences(document, document): archived rules retain
-- historical references; settings and every nonarchived rule are revalidated.
-- Row share locks retain eligibility until the committing transaction completes.
CREATE FUNCTION public.procurement_mcp_policy_references(p_site uuid, p_document jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  people jsonb; products jsonb := '[]'; categories jsonb := '[]'; agents jsonb := '[]';
  stages jsonb := '[]'; rule jsonb; stage jsonb; requirement jsonb;
  ids jsonb; identifier text; owner_id uuid;
BEGIN
  IF public.procurement_tender_access(p_site,'select') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Procurement access denied' USING ERRCODE='42501';
  END IF;
  people := COALESCE(p_document#>'{settings,substituteIds}','[]') ||
    COALESCE(p_document#>'{settings,rejectionNotifications,recipientIds}','[]');
  IF p_document#>>'{settings,supervisorId}' IS NOT NULL THEN
    people := people || jsonb_build_array(p_document#>>'{settings,supervisorId}');
  END IF;
  IF p_document#>>'{settings,fallback,mode}'='approval' THEN
    stages := p_document#>'{settings,fallback,stages}';
  END IF;
  FOR rule IN SELECT value FROM jsonb_array_elements(p_document->'rules') LOOP
    IF rule->>'status'='archived' THEN CONTINUE; END IF;
    products := products || COALESCE(rule#>'{scope,productIds}','[]');
    categories := categories || COALESCE(rule#>'{scope,categoryIds}','[]');
    people := people || COALESCE(rule#>'{scope,requesterIds}','[]') || COALESCE(rule#>'{scope,responsibleIds}','[]');
    stages := stages || COALESCE(rule->'stages','[]');
    FOR requirement IN SELECT value FROM jsonb_array_elements(rule->'requirements') LOOP
      products := products || COALESCE(requirement->'productIds','[]');
      categories := categories || COALESCE(requirement->'categoryIds','[]');
    END LOOP;
  END LOOP;
  FOR stage IN SELECT value FROM jsonb_array_elements(stages) LOOP
    people := people || COALESCE(stage->'approverIds','[]') || COALESCE(stage->'mandatoryApproverIds','[]') || COALESCE(stage->'escalationIds','[]');
    IF stage->>'delegatedAgentId' IS NOT NULL THEN agents := agents || jsonb_build_array(stage->>'delegatedAgentId'); END IF;
  END LOOP;
  FOREACH ids IN ARRAY ARRAY[people,products,categories,agents] LOOP
    IF (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(ids))>200 OR EXISTS(
      SELECT 1 FROM jsonb_array_elements_text(ids) WHERE value IS NULL OR value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) THEN RETURN false; END IF;
  END LOOP;
  SELECT user_id INTO owner_id FROM public.sites WHERE id=p_site FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  FOR identifier IN SELECT DISTINCT value FROM jsonb_array_elements_text(people) LOOP
    IF identifier::uuid=owner_id THEN CONTINUE; END IF;
    PERFORM 1 FROM public.site_members WHERE site_id=p_site AND user_id=identifier::uuid
      AND status='active' AND license_suspended=false AND manually_disabled=false FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
  END LOOP;
  FOR identifier IN SELECT DISTINCT value FROM jsonb_array_elements_text(products) LOOP
    PERFORM 1 FROM public.catalog_items WHERE site_id=p_site AND id=identifier::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
  END LOOP;
  FOR identifier IN SELECT DISTINCT value FROM jsonb_array_elements_text(categories) LOOP
    PERFORM 1 FROM public.catalog_categories WHERE site_id=p_site AND id=identifier::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
  END LOOP;
  FOR identifier IN SELECT DISTINCT value FROM jsonb_array_elements_text(agents) LOOP
    PERFORM 1 FROM public.agents WHERE site_id=p_site AND id=identifier::uuid FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.procurement_mcp_policy_references(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.procurement_mcp_dispatch(p_site uuid,p_actor uuid,p_operation text,p_args jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  old_claims text := current_setting('request.jwt.claims',true);
  old_sub text := current_setting('request.jwt.claim.sub',true);
  old_role text := current_setting('request.jwt.claim.role',true);
  caller_role text := COALESCE(NULLIF(current_setting('role',true),'none'),session_user);
  allowed text[]; required text[]; command text; result jsonb; target uuid; saved uuid;
  version integer; page_limit integer; page_offset integer; event text;
  policy jsonb; policy_revision integer; context jsonb; lines jsonb; inherited jsonb;
  evaluation_operation text := p_operation; evaluation_actor uuid := p_actor;
  expected_context jsonb; evaluated_plan jsonb;
  evaluated_at timestamptz; active_rule_ids jsonb;
  approval_row public.procurement_event_approvals;
  request_row public.procurement_requests; tender_row public.procurement_tenders;
BEGIN
  -- current_user is the function OWNER under SECURITY DEFINER, not the caller.
  -- A spoofed JWT role alone must never authorize a database caller.
  IF caller_role IS DISTINCT FROM 'service_role' OR auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Procurement bridge requires service_role' USING ERRCODE='42501';
  END IF;
  IF p_site IS NULL OR p_actor IS NULL THEN RAISE EXCEPTION 'Site and actor required' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_args) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Object arguments required' USING ERRCODE='22023'; END IF;

  -- Exact top-level operation schemas. action/thought_process are stripped by
  -- tools.ts; tenant, actor, arbitrary function names and SQL are never inputs.
  CASE p_operation
    WHEN 'requests.list','tenders.list' THEN allowed:=ARRAY['limit','offset','status','query']; required:='{}';
    WHEN 'approvals.list' THEN allowed:=ARRAY['limit','offset','status']; required:='{}';
    WHEN 'requests.get','tenders.get','quotations.get','approvals.get' THEN allowed:=ARRAY['id']; required:=allowed;
    WHEN 'requests.save' THEN allowed:=ARRAY['id','expected_revision','document']; required:=ARRAY['expected_revision','document'];
    WHEN 'requests.revalidate' THEN allowed:=ARRAY['id','expected_revision']; required:=allowed;
    WHEN 'requests.decide' THEN allowed:=ARRAY['id','expected_revision','stage_id','decision','reason']; required:=allowed;
    WHEN 'requests.submit' THEN allowed:=ARRAY['id','expected_revision','policy_revision','plan','expected_context']; required:=allowed;
    WHEN 'tenders.save' THEN allowed:=ARRAY['id','expected_version','document']; required:=ARRAY['expected_version','document'];
    WHEN 'tenders.transition' THEN allowed:=ARRAY['id','expected_version','transition']; required:=allowed;
    WHEN 'tenders.participant' THEN allowed:=ARRAY['id','expected_version','supplier_id','status']; required:=allowed;
    WHEN 'tenders.portal' THEN allowed:=ARRAY['enabled']; required:=allowed;
    WHEN 'tenders.publish' THEN allowed:=ARRAY['id','expected_version','policy_revision','plan','expected_context']; required:=allowed;
    WHEN 'quotations.record','orders.receive' THEN allowed:=ARRAY['document']; required:=allowed;
    WHEN 'approvals.create' THEN allowed:=ARRAY['target_id','expected_version','event','policy_revision','plan','expected_context']; required:=allowed;
    WHEN 'approvals.decide' THEN allowed:=ARRAY['id','stage_id','decision','reason']; required:=allowed;
    WHEN 'policy.references' THEN allowed:=ARRAY['policy_revision']; required:=allowed;
    WHEN 'context.requisition' THEN allowed:=ARRAY['id','expected_revision']; required:=allowed;
    WHEN 'context.publication' THEN allowed:=ARRAY['id','expected_version']; required:=allowed;
    WHEN 'context.award','context.order' THEN allowed:=ARRAY['target_id','expected_version','event']; required:=allowed;
    WHEN 'quotations.list','quotations.options','orders.list','policy.get' THEN allowed:='{}'; required:='{}';
    ELSE RAISE EXCEPTION 'Unknown procurement operation' USING ERRCODE='22023';
  END CASE;
  IF p_args-allowed<>'{}'::jsonb OR NOT p_args ?& required OR EXISTS(
    SELECT 1 FROM unnest(required) k WHERE p_args->k='null'::jsonb
  ) THEN RAISE EXCEPTION 'Invalid procurement arguments' USING ERRCODE='22023'; END IF;
  target := COALESCE(p_args->>'id',p_args->>'target_id')::uuid;
  version := COALESCE(p_args->>'expected_revision',p_args->>'expected_version')::integer;
  page_limit := COALESCE((p_args->>'limit')::integer,50);
  page_offset := COALESCE((p_args->>'offset')::integer,0);
  IF page_limit NOT BETWEEN 1 AND 100 OR page_offset NOT BETWEEN 0 AND 10000 OR version<0 THEN
    RAISE EXCEPTION 'Invalid version or pagination' USING ERRCODE='22023'; END IF;
  command := CASE WHEN p_operation IN ('requests.list','requests.get','tenders.list','tenders.get','quotations.list','quotations.get','quotations.options','orders.list','approvals.list','approvals.get','policy.get','policy.references') THEN 'select' ELSE 'update' END;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_actor,'role','authenticated')::text,true);
  -- Supabase auth.uid/role prefer individual claim GUCs. Clear them so nested
  -- canonical finalizers can temporarily reauthorize the original initiator by
  -- changing claims JSON (not accidentally keep authorizing the deciding user).
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claim.role','',true);
  IF auth.uid() IS DISTINCT FROM p_actor OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Procurement actor binding failed' USING ERRCODE='42501'; END IF;
  IF public.current_user_site_role(p_site) NOT IN ('owner','admin') OR public.current_user_site_role(p_site) IS NULL
    OR public.current_user_has_site_location_restrictions(p_site) IS DISTINCT FROM false
    OR public.procurement_tender_access(p_site,command) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Procurement manager access denied' USING ERRCODE='42501';
  END IF;

  expected_context:=p_args->'expected_context';
  IF p_operation='approvals.decide' AND p_args->>'decision'='approve' THEN
    -- Match canonical decision lock order. Existing votes go directly to its
    -- authorized exact-replay/conflict check, even while other stages are pending.
    SELECT * INTO approval_row FROM public.procurement_event_approvals
      WHERE site_id=p_site AND id=target FOR UPDATE;
    IF approval_row.status='pending' AND NOT EXISTS(
      SELECT 1 FROM public.procurement_event_decisions d
      JOIN public.procurement_event_stages s ON s.id=d.stage_id
      WHERE s.approval_id=approval_row.id AND s.id=(p_args->>'stage_id')::uuid AND d.actor_id=p_actor
    ) THEN
      expected_context:=approval_row.plan->'mcp_context';
      -- UI/legacy approvals have no original evaluated catalog snapshot. MCP
      -- cannot safely approve them; rejection and canonical replays remain valid.
      IF jsonb_typeof(expected_context) IS DISTINCT FROM 'object'
        OR approval_row.event NOT IN ('publication','award','order') THEN
        RAISE EXCEPTION 'Approval evaluated context missing' USING ERRCODE='40001'; END IF;
      evaluation_operation:='context.'||approval_row.event;
      evaluation_actor:=approval_row.actor_id;
      target:=approval_row.target_id; version:=approval_row.target_version;
    END IF;
  END IF;

  -- Policy advisory lock uses the canonical key, including first-save safety.
  -- Commit operations repeat target/context + references checks in THIS transaction.
  IF evaluation_operation IN ('policy.get','policy.references','context.requisition','context.publication','context.award','context.order','requests.submit','tenders.publish','approvals.create') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('procurement_policy:'||p_site::text,0));
    SELECT v.revision,v.document INTO policy_revision,policy FROM public.procurement_policy_versions v
      WHERE v.site_id=p_site ORDER BY v.revision DESC LIMIT 1;
    IF policy IS NULL THEN RAISE EXCEPTION 'Saved procurement policy required' USING ERRCODE='55000'; END IF;
    IF p_args ? 'policy_revision' AND (p_args->>'policy_revision')::integer IS DISTINCT FROM policy_revision THEN
      RAISE EXCEPTION 'Policy revision conflict' USING ERRCODE='40001'; END IF;
    IF p_operation IN ('policy.references','requests.submit','tenders.publish','approvals.create') AND
      NOT public.procurement_mcp_policy_references(p_site,policy) THEN
      RAISE EXCEPTION 'Policy references no longer eligible' USING ERRCODE='22023'; END IF;
  END IF;
  IF evaluation_operation IN ('context.requisition','requests.submit') THEN
    SELECT * INTO request_row FROM public.procurement_requests WHERE site_id=p_site AND id=target FOR UPDATE;
    IF NOT FOUND OR request_row.revision IS DISTINCT FROM version OR request_row.status<>'draft' THEN
      RAISE EXCEPTION 'Request revision or state conflict' USING ERRCODE='40001'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.procurement_request_items WHERE request_id=target AND revision=version) OR EXISTS(
      SELECT 1 FROM public.procurement_request_items WHERE request_id=target AND revision=version AND
        (valuation_source='unpriced' OR unit_net_minor IS NULL OR net_amount_minor IS NULL OR tax_snapshot IS NULL OR tax_snapshot='null'::jsonb)
    ) THEN RAISE EXCEPTION 'Unpriced request or unresolved taxes' USING ERRCODE='22023'; END IF;
    SELECT jsonb_agg(jsonb_build_object('id',i.id,'productId',i.catalog_item_id,'categoryIds',i.category_ids,'netAmountMinor',i.net_amount_minor) ORDER BY i.position)
      INTO lines FROM public.procurement_request_items i WHERE i.request_id=target AND i.revision=version;
    context:=jsonb_build_object('requester_id',request_row.requester_id,'currency',request_row.currency,'net_amount_minor',request_row.net_amount_minor,'lines',lines);
  ELSIF evaluation_operation IN ('context.publication','tenders.publish') THEN
    SELECT * INTO tender_row FROM public.procurement_tenders WHERE site_id=p_site AND id=target FOR UPDATE;
    IF NOT FOUND OR tender_row.version IS DISTINCT FROM version OR tender_row.status NOT IN ('draft','published') THEN
      RAISE EXCEPTION 'Tender version or state conflict' USING ERRCODE='40001'; END IF;
    PERFORM c.id FROM public.catalog_items c WHERE c.site_id=p_site AND c.id IN (
      SELECT (r->>'catalog_item_id')::uuid FROM jsonb_array_elements(tender_row.requirements) r
    ) ORDER BY c.id FOR SHARE;
    inherited:=public.procurement_inherited_policy(p_site,target,'publication');
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(tender_row.requirements) r WHERE r->>'catalog_item_id' IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public.catalog_items c WHERE c.site_id=p_site AND c.id=(r->>'catalog_item_id')::uuid)) THEN
      RAISE EXCEPTION 'Tender product references changed' USING ERRCODE='40001'; END IF;
    SELECT jsonb_agg(jsonb_build_object('id',r->>'id','productId',r->'catalog_item_id',
      'categoryIds',CASE WHEN c.category_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(c.category_id) END,
      'netAmountMinor',(r->>'quantity')::bigint*(r->>'unit_net_minor')::bigint) ORDER BY ordinal) INTO lines
      FROM jsonb_array_elements(tender_row.requirements) WITH ORDINALITY AS requirements(r,ordinal)
      LEFT JOIN public.catalog_items c ON c.site_id=p_site AND c.id=(r->>'catalog_item_id')::uuid;
    context:=inherited || jsonb_build_object('requester_id',evaluation_actor,'currency',tender_row.currency,'net_amount_minor',tender_row.net_amount_minor,'lines',lines,'supplier_proposals',0);
  ELSIF evaluation_operation IN ('context.award','context.order','approvals.create') THEN
    event:=CASE WHEN p_operation='approvals.decide' THEN approval_row.event ELSE p_args->>'event' END;
    IF event NOT IN ('award','order') OR (evaluation_operation LIKE 'context.%' AND evaluation_operation<>'context.'||event) THEN
      RAISE EXCEPTION 'Invalid commerce event' USING ERRCODE='22023'; END IF;
    -- Canonical validation first retains its target locks in canonical order;
    -- lock evaluated products, then rebuild so a concurrent category edit cannot
    -- fall between comparison and persistence. Never read sealed quotation tables.
    context:=public.procurement_commerce_event_context(p_site,target,version,event);
    PERFORM c.id FROM public.catalog_items c WHERE c.site_id=p_site AND c.id IN (
      SELECT (line->>'productId')::uuid FROM jsonb_array_elements(context->'lines') line
    ) ORDER BY c.id FOR SHARE;
    context:=public.procurement_commerce_event_context(p_site,target,version,event) || jsonb_build_object('requester_id',evaluation_actor);
  END IF;

  IF context IS NOT NULL THEN
    -- Evaluate against one DB clock instant, not a drifting host clock. The
    -- active-rule token catches effective-window crossings without comparing
    -- timestamps themselves (which necessarily differ across transactions).
    evaluated_at:=date_trunc('milliseconds',clock_timestamp());
    event:=CASE WHEN evaluation_operation IN ('context.requisition','requests.submit') THEN 'requisition'
      WHEN evaluation_operation IN ('context.publication','tenders.publish') THEN 'publication' ELSE event END;
    SELECT COALESCE(jsonb_agg(r->>'id' ORDER BY r->>'id'),'[]'::jsonb) INTO active_rule_ids
      FROM jsonb_array_elements(policy->'rules') r WHERE r->>'status'='active' AND r->>'event'=event
        AND (r->>'effectiveFrom' IS NULL OR (r->>'effectiveFrom')::timestamptz<=evaluated_at)
        AND (r->>'effectiveUntil' IS NULL OR (r->>'effectiveUntil')::timestamptz>evaluated_at);
    context:=context || jsonb_build_object('policy',jsonb_build_object('revision',policy_revision,'document',policy),
      'target_id',target,'target_version',version,'actor_id',evaluation_actor,
      'evaluated_at',evaluated_at,'policy_active_rule_ids',active_rule_ids);
    IF p_operation IN ('requests.submit','tenders.publish','approvals.create','approvals.decide') THEN
      IF NOT (expected_context ? 'evaluated_at') OR context-'evaluated_at' IS DISTINCT FROM expected_context-'evaluated_at' THEN
        RAISE EXCEPTION 'Procurement evaluated context changed' USING ERRCODE='40001'; END IF;
      -- Reserved snapshot is host-only and always overwritten, never trusted from
      -- caller plan metadata. Strict equality intentionally includes offer counts.
      evaluated_plan:=((p_args->'plan')-'mcp_context') || jsonb_build_object('mcp_context',expected_context);
    END IF;
  END IF;

  CASE p_operation
    WHEN 'policy.get' THEN result:=jsonb_build_object('revision',policy_revision,'document',policy);
    WHEN 'policy.references' THEN result:=jsonb_build_object('valid',true);
    WHEN 'context.requisition','context.publication','context.award','context.order' THEN
      result:=context;
    WHEN 'requests.list' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') INTO result FROM (SELECT * FROM public.procurement_requests
        WHERE site_id=p_site AND (NOT p_args ? 'status' OR status=p_args->>'status')
          AND (NOT p_args ? 'query' OR title ILIKE '%'||(p_args->>'query')||'%') ORDER BY updated_at DESC,id LIMIT page_limit OFFSET page_offset) r;
    WHEN 'requests.get' THEN
      SELECT to_jsonb(r)||jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.position) FROM public.procurement_request_items i WHERE i.request_id=r.id AND i.revision=r.revision),'[]'),
        'stages',COALESCE((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('decisions',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at,d.id) FROM public.procurement_request_decisions d WHERE d.stage_id=s.id),'[]')) ORDER BY s.position) FROM public.procurement_request_stages s WHERE s.request_id=r.id AND s.revision=r.revision),'[]'))
        INTO result FROM public.procurement_requests r WHERE r.site_id=p_site AND r.id=target;
    WHEN 'requests.save' THEN saved:=public.save_procurement_request(p_site,target,version,p_args->'document');
    WHEN 'requests.revalidate' THEN saved:=public.revalidate_procurement_request(p_site,target,version);
    WHEN 'requests.decide' THEN saved:=public.decide_procurement_request(p_site,target,version,(p_args->>'stage_id')::uuid,p_args->>'decision',p_args->>'reason');
    WHEN 'requests.submit' THEN saved:=public.submit_procurement_request(p_site,target,version,policy_revision,p_actor,evaluated_plan);
    WHEN 'tenders.list' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]') INTO result FROM (SELECT * FROM public.procurement_tenders
        WHERE site_id=p_site AND (NOT p_args ? 'status' OR status=p_args->>'status')
          AND (NOT p_args ? 'query' OR title ILIKE '%'||(p_args->>'query')||'%') ORDER BY updated_at DESC,id LIMIT page_limit OFFSET page_offset) t;
    WHEN 'tenders.get' THEN
      SELECT to_jsonb(t)||jsonb_build_object('publications',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.version DESC) FROM public.procurement_tender_publications p WHERE p.site_id=p_site AND p.tender_id=t.id),'[]'),
        'participants',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.procurement_tender_participants p WHERE p.site_id=p_site AND p.tender_id=t.id),'[]'),
        'approvals',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC,a.id) FROM public.procurement_event_approvals a WHERE a.site_id=p_site AND a.target_id=t.id AND a.event='publication'),'[]'))
        INTO result FROM public.procurement_tenders t WHERE t.site_id=p_site AND t.id=target;
    WHEN 'tenders.save' THEN saved:=public.save_procurement_tender(p_site,target,version,p_args->'document');
    WHEN 'tenders.transition' THEN PERFORM public.transition_procurement_tender(p_site,target,version,p_args->>'transition'); result:=jsonb_build_object('id',target);
    WHEN 'tenders.participant' THEN saved:=public.set_procurement_tender_participant(p_site,target,version,(p_args->>'supplier_id')::uuid,p_args->>'status');
    WHEN 'tenders.portal' THEN result:=jsonb_build_object('slug',public.configure_procurement_tender_portal(p_site,(p_args->>'enabled')::boolean),'enabled',p_args->'enabled');
    WHEN 'tenders.publish' THEN saved:=public.create_procurement_event_approval(p_site,target,version,'publication',p_actor,policy_revision,evaluated_plan);
    -- No direct quotation table reads: canonical projections enforce sealed bids.
    WHEN 'quotations.list' THEN result:=jsonb_build_object('quotations',public.list_procurement_quotations(p_site),'envelopes',public.list_procurement_quotation_envelopes(p_site));
    WHEN 'quotations.get' THEN result:=public.get_procurement_quotation(p_site,target);
    WHEN 'quotations.options' THEN result:=public.procurement_quotation_options(p_site);
    WHEN 'quotations.record' THEN saved:=public.record_procurement_quotation(p_site,p_args->'document');
    WHEN 'orders.list' THEN result:=public.list_procurement_orders(p_site); -- canonical latest 100
    WHEN 'orders.receive' THEN saved:=public.record_procurement_receipt(p_site,p_args->'document');
    WHEN 'approvals.list' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(a)),'[]') INTO result FROM (SELECT * FROM public.procurement_event_approvals
        WHERE site_id=p_site AND (NOT p_args ? 'status' OR status=p_args->>'status') ORDER BY created_at DESC,id LIMIT page_limit OFFSET page_offset) a;
    WHEN 'approvals.get' THEN
      SELECT to_jsonb(a)||jsonb_build_object('result',jsonb_build_object(
        'award_id',COALESCE((SELECT w.id FROM public.procurement_awards w WHERE w.site_id=p_site AND w.approval_id=a.id),
          (SELECT w.id FROM public.procurement_awards w WHERE a.status='approved' AND a.event='award' AND w.site_id=p_site AND w.quotation_id=a.target_id)),
        'order_id',COALESCE((SELECT o.id FROM public.purchase_orders o WHERE o.site_id=p_site AND o.approval_id=a.id),
          (SELECT o.id FROM public.purchase_orders o WHERE a.status='approved' AND a.event='order' AND o.site_id=p_site AND o.award_id=a.target_id)),
        'publication_id',(SELECT p.id FROM public.procurement_tender_publications p WHERE a.event='publication' AND p.site_id=p_site AND p.tender_id=a.target_id AND p.version=a.target_version)),
        'stages',COALESCE((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('decisions',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at,d.id) FROM public.procurement_event_decisions d WHERE d.stage_id=s.id),'[]')) ORDER BY s.position)
        FROM public.procurement_event_stages s WHERE s.approval_id=a.id),'[]')) INTO result FROM public.procurement_event_approvals a WHERE a.site_id=p_site AND a.id=target;
    WHEN 'approvals.decide' THEN saved:=public.decide_procurement_event(p_site,(p_args->>'id')::uuid,(p_args->>'stage_id')::uuid,p_args->>'decision',p_args->>'reason');
    WHEN 'approvals.create' THEN saved:=public.create_procurement_commerce_approval(p_site,target,version,event,p_actor,policy_revision,evaluated_plan);
    ELSE RAISE EXCEPTION 'Unknown procurement operation' USING ERRCODE='22023';
  END CASE;
  IF saved IS NOT NULL THEN result:=jsonb_build_object('id',saved); END IF;
  IF result IS NULL THEN RAISE EXCEPTION 'Procurement target not found' USING ERRCODE='P0002'; END IF;
  PERFORM set_config('request.jwt.claims',COALESCE(old_claims,''),true);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(old_sub,''),true);
  PERFORM set_config('request.jwt.claim.role',COALESCE(old_role,''),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('request.jwt.claims',COALESCE(old_claims,''),true);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(old_sub,''),true);
  PERFORM set_config('request.jwt.claim.role',COALESCE(old_role,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION public.procurement_mcp_dispatch(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.procurement_mcp_dispatch(uuid,uuid,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.procurement_mcp_dispatch(uuid,uuid,text,jsonb) IS
  'Host-only MCP bridge. Actor/site bound by trusted host; plans only from policy.ts. No frontend route. Requires canonical market-fit procurement domain through 20261030220000.';

COMMIT;