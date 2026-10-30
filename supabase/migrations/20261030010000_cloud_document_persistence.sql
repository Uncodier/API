-- Forward-only, offline-reviewed migration. Text and metadata commit together;
-- Git is a recoverable projection, never the authoritative document store.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.cloud_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  requirement_id uuid REFERENCES public.requirements(id) ON DELETE CASCADE,
  current_version integer NOT NULL CHECK (current_version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cloud_files_scope_idx ON public.cloud_files(site_id,instance_id,requirement_id,id);

CREATE TABLE public.cloud_file_revisions (
  file_id uuid NOT NULL REFERENCES public.cloud_files(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mime text NOT NULL CHECK (mime IN ('text/plain','text/markdown','text/csv','application/json','text/html','text/css','text/javascript','application/javascript','application/xml','text/xml','application/yaml','text/yaml')),
  content text NOT NULL CHECK (octet_length(content) <= 262144),
  sha256 text NOT NULL CHECK (sha256 = encode(sha256(convert_to(content,'UTF8')),'hex')),
  bytes integer NOT NULL CHECK (bytes = octet_length(content)),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (file_id,version)
);
-- Every version has a durable pending publish intent in the same transaction.
CREATE TABLE public.cloud_file_git_results (
  file_id uuid NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','failed','conflict')),
  commit_sha text CHECK (commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  repository text,
  ref text,
  path text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  PRIMARY KEY (file_id,version),
  FOREIGN KEY (file_id,version) REFERENCES public.cloud_file_revisions(file_id,version) ON DELETE CASCADE,
  CHECK ((status = 'committed') = (commit_sha IS NOT NULL)),
  CHECK ((repository IS NULL AND ref IS NULL AND path IS NULL) OR (repository IS NOT NULL AND ref IS NOT NULL AND path IS NOT NULL)),
  CHECK (status <> 'committed' OR repository IS NOT NULL)
);
CREATE INDEX cloud_file_git_pending_idx ON public.cloud_file_git_results(next_retry_at,file_id,version) WHERE status IN ('pending','failed');
CREATE TABLE public.cloud_file_operations (
  operation_id uuid PRIMARY KEY,
  file_id uuid NOT NULL REFERENCES public.cloud_files(id) ON DELETE CASCADE,
  arguments_sha256 bytea NOT NULL CHECK (octet_length(arguments_sha256)=32),
  site_id uuid NOT NULL,
  user_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  requirement_id uuid,
  version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('created','updated','unchanged','conflict')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (file_id,version) REFERENCES public.cloud_file_revisions(file_id,version) ON DELETE CASCADE
);
CREATE INDEX cloud_file_operations_file_idx ON public.cloud_file_operations(file_id);

-- Logical storage budget (not PostgreSQL physical/WAL size): all historical
-- content bytes + 2048/revision (bounded name, MIME, Git target and row overhead),
-- 256/file and 256/receipt. No arguments or response content in receipts.
-- Instance: 32 MiB / 1000 files / 10000 operations; site: 256 MiB / 10000 / 100000.
-- Called after tentative inserts under the site lock; failure rolls back all of
-- them. Replays bypass admission. Cascading deletion immediately releases usage.
CREATE FUNCTION public.cloud_file_check_quota(p_site_id uuid,p_instance_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS (
    WITH usage AS (
      SELECT f.instance_id,256::bigint bytes,1 files,0 ops FROM public.cloud_files f WHERE f.site_id=p_site_id
      UNION ALL SELECT f.instance_id,r.bytes::bigint+2048,0,0 FROM public.cloud_files f
        JOIN public.cloud_file_revisions r ON r.file_id=f.id WHERE f.site_id=p_site_id
      UNION ALL SELECT f.instance_id,256,0,1 FROM public.cloud_files f
        JOIN public.cloud_file_operations o ON o.file_id=f.id WHERE f.site_id=p_site_id
    ) SELECT 1 FROM usage HAVING sum(bytes)>268435456 OR sum(files)>10000 OR sum(ops)>100000
      OR sum(bytes) FILTER (WHERE instance_id=p_instance_id)>33554432
      OR sum(files) FILTER (WHERE instance_id=p_instance_id)>1000
      OR sum(ops) FILTER (WHERE instance_id=p_instance_id)>10000
  ) THEN RAISE EXCEPTION 'Cloud quota exceeded' USING ERRCODE='CF006'; END IF;
END;
$$;

CREATE FUNCTION public.cloud_file_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Cloud revision is immutable' USING ERRCODE = 'CF001'; END;
$$;
-- Direct table writes remain revoked. Owner deletion must cascade through all
-- copies of document content, including idempotency receipts, without orphans.
CREATE TRIGGER cloud_file_revision_immutable BEFORE UPDATE ON public.cloud_file_revisions
FOR EACH ROW EXECUTE FUNCTION public.cloud_file_immutable();
CREATE TRIGGER cloud_file_operation_immutable BEFORE UPDATE ON public.cloud_file_operations
FOR EACH ROW EXECUTE FUNCTION public.cloud_file_immutable();

CREATE FUNCTION public.cloud_file_revision_json(p_file_id uuid,p_version integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('file_id',f.id,'version',r.version,'name',r.name,'mime',r.mime,
    'content',r.content,'sha256',r.sha256,'bytes',r.bytes,'requirement_id',f.requirement_id,
    'instance_id',f.instance_id,'git_status',g.status,'git_commit_sha',g.commit_sha,
    'git_repository',g.repository,'git_ref',g.ref,'git_path',g.path)
  FROM public.cloud_files f JOIN public.cloud_file_revisions r ON r.file_id=f.id
  JOIN public.cloud_file_git_results g ON g.file_id=r.file_id AND g.version=r.version
  WHERE f.id=p_file_id AND r.version=p_version;
$$;

CREATE FUNCTION public.cloud_file_check_scope(p_site_id uuid,p_user_id uuid,p_instance_id uuid,p_requirement_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Stable owner identity for the transaction; lock in requirement/instance
  -- order shared with requirement lifecycle operations, then check live access.
  IF p_requirement_id IS NOT NULL THEN
    PERFORM 1 FROM public.requirements WHERE id=p_requirement_id FOR SHARE;
  END IF;
  PERFORM 1 FROM public.remote_instances WHERE id=p_instance_id FOR SHARE;
  IF p_site_id IS NULL OR p_user_id IS NULL OR p_instance_id IS NULL
    OR public.site_user_has_effective_access(p_site_id,p_user_id) IS DISTINCT FROM true
    OR NOT EXISTS (SELECT 1 FROM public.remote_instances WHERE id=p_instance_id AND site_id=p_site_id AND is_archived IS NOT TRUE) THEN
    RAISE EXCEPTION 'Cloud scope denied' USING ERRCODE = 'CF002';
  END IF;
  IF p_requirement_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.requirements r WHERE r.id=p_requirement_id AND r.site_id=p_site_id
      AND (r.metadata->>'runner_instance_id'=p_instance_id::text OR EXISTS (
        SELECT 1 FROM public.instance_plans p WHERE p.instance_id=p_instance_id AND p.site_id=p_site_id
          AND p.metadata->>'requirement_id'=r.id::text))) THEN
    RAISE EXCEPTION 'Cloud scope denied' USING ERRCODE = 'CF002';
  END IF;
END;
$$;

CREATE FUNCTION public.cloud_file_store(p_site_id uuid,p_user_id uuid,p_instance_id uuid,
  p_requirement_id uuid,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
#variable_conflict use_variable
<<cloud_file_store>>
DECLARE
  f public.cloud_files%ROWTYPE;
  r public.cloud_file_revisions%ROWTYPE;
  journal public.cloud_file_operations%ROWTYPE;
  g public.cloud_file_git_results%ROWTYPE;
  file_id uuid; operation_id uuid; requirement_id uuid; version integer;
  args bytea; result jsonb; entry record; change jsonb; patch_bytes bigint:=0;
  action text; content text; name text; mime text; old_text text; new_text text;
  state text; pos integer; offset_value integer; limit_value integer; query_value text;
BEGIN
  -- Never wait for the quota lock while holding scope/operation/file locks.
  -- READ COMMITTED gives admission a fresh snapshot after a waiting writer.
  IF p_operation='write' THEN
    IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cloud write isolation unsupported' USING ERRCODE='CF001'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('cloud-quota:'||p_site_id::text,0));
  END IF;
  PERFORM public.cloud_file_check_scope(p_site_id,p_user_id,p_instance_id,p_requirement_id);
  IF p_operation IS NULL OR p_operation NOT IN ('read','list','write','git_result','git_pending','git_bind','operation')
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE = 'CF001';
  END IF;
  -- Reject unknown keys and JSON coercions, not merely malformed SQL casts.
  FOR entry IN SELECT key,value FROM jsonb_each(p_input) LOOP
    IF NOT (entry.key = ANY(CASE p_operation
      WHEN 'read' THEN ARRAY['file_id','version']
      WHEN 'list' THEN ARRAY['requirement_id','query','offset','limit']
      WHEN 'git_pending' THEN ARRAY['offset','limit']
      WHEN 'git_result' THEN ARRAY['file_id','version','status','commitSha']
      WHEN 'git_bind' THEN ARRAY['file_id','version','repository','ref','path']
      WHEN 'operation' THEN ARRAY['operation_id']
      ELSE ARRAY['operation_id','action','file_id','expected_version','name','mime','content','changes'] END))
      OR (entry.key IN ('file_id','operation_id','action','name','mime','content','requirement_id','query','status','repository','ref','path') AND jsonb_typeof(entry.value)<>'string')
      OR (entry.key='commitSha' AND jsonb_typeof(entry.value) NOT IN ('string','null'))
      OR (entry.key IN ('version','expected_version','offset','limit') AND (jsonb_typeof(entry.value)<>'number' OR (entry.value#>>'{}') !~ '^[0-9]+$'))
      OR (entry.key='changes' AND jsonb_typeof(entry.value)<>'array') THEN
      RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE = 'CF001';
    END IF;
  END LOOP;

  IF p_operation='operation' THEN
    operation_id:=(p_input->>'operation_id')::uuid;
    IF operation_id IS NULL THEN RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001'; END IF;
    -- Read-only crash reconciliation. Scope mismatch and absent receipts are
    -- indistinguishable; absence must be treated as unknown by the caller.
    SELECT public.cloud_file_revision_json(op.file_id,op.version)||jsonb_build_object('state',op.state) INTO result FROM public.cloud_file_operations op
      WHERE op.operation_id=cloud_file_store.operation_id
        AND op.site_id=p_site_id AND op.user_id=p_user_id AND op.instance_id=p_instance_id
        AND op.requirement_id IS NOT DISTINCT FROM p_requirement_id;
    RETURN result;
  END IF;

  IF p_operation IN ('list','git_pending') THEN
    requirement_id:=coalesce((p_input->>'requirement_id')::uuid,p_requirement_id);
    IF p_requirement_id IS NOT NULL AND requirement_id<>p_requirement_id THEN
      RAISE EXCEPTION 'Cloud scope denied' USING ERRCODE='CF002';
    END IF;
    IF requirement_id IS NOT NULL THEN
      PERFORM public.cloud_file_check_scope(p_site_id,p_user_id,p_instance_id,requirement_id);
    END IF;
    offset_value:=coalesce((p_input->>'offset')::integer,0);
    limit_value:=coalesce((p_input->>'limit')::integer,20);
    query_value:=coalesce(p_input->>'query','');
    IF offset_value>100000 OR limit_value NOT BETWEEN 1 AND 100 OR length(query_value)>200 THEN
      RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001';
    END IF;
    SELECT coalesce(jsonb_agg(item ORDER BY id,revision_version),'[]'::jsonb) INTO result FROM (
      SELECT cf.id,cr.version revision_version,public.cloud_file_revision_json(cf.id,cr.version) item
      FROM public.cloud_files cf JOIN public.cloud_file_revisions cr ON cr.file_id=cf.id
      JOIN public.cloud_file_git_results gr ON gr.file_id=cr.file_id AND gr.version=cr.version
      WHERE cf.site_id=p_site_id AND cf.instance_id=p_instance_id
        AND ((p_operation='list' AND cr.version=cf.current_version) OR (p_operation='git_pending' AND gr.status<>'committed'))
        AND (requirement_id IS NULL OR cf.requirement_id=requirement_id)
        AND (query_value='' OR strpos(lower(cr.name),lower(query_value))>0 OR strpos(lower(cr.content),lower(query_value))>0)
      ORDER BY cf.id,cr.version OFFSET offset_value LIMIT limit_value+1
    ) page;
    IF jsonb_array_length(result)>limit_value THEN
      RETURN jsonb_build_object('files',result-limit_value,'next_offset',offset_value+limit_value);
    END IF;
    RETURN jsonb_build_object('files',result,'next_offset',NULL);
  END IF;

  file_id:=(p_input->>'file_id')::uuid;
  version:=(p_input->>'version')::integer;
  IF p_operation='write' THEN
    -- Instance FOR SHARE from scope admission serializes this predicate with
    -- requirement/plan binding triggers. Historic standalone reads stay valid.
    IF p_requirement_id IS NULL AND (EXISTS (
      SELECT 1 FROM public.requirements req WHERE req.site_id=p_site_id
        AND req.metadata->>'runner_instance_id'=p_instance_id::text
    ) OR EXISTS (
      SELECT 1 FROM public.instance_plans p JOIN public.requirements req
        ON req.id::text=p.metadata->>'requirement_id' AND req.site_id=p_site_id
      WHERE p.site_id=p_site_id AND p.instance_id=p_instance_id
    )) THEN RAISE EXCEPTION 'Cloud requirement scope required' USING ERRCODE='CF002'; END IF;
    operation_id:=(p_input->>'operation_id')::uuid;
    action:=p_input->>'action';
    IF operation_id IS NULL OR action IS NULL OR action NOT IN ('create','replace','patch') THEN
      RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001';
    END IF;
    args:=sha256(convert_to(p_input::text,'UTF8'));
    -- Serializes retries even before the file exists. Hash collisions only delay.
    PERFORM pg_advisory_xact_lock(hashtextextended(operation_id::text,0));
    PERFORM public.cloud_file_check_scope(p_site_id,p_user_id,p_instance_id,p_requirement_id);
    SELECT * INTO journal FROM public.cloud_file_operations op WHERE op.operation_id=cloud_file_store.operation_id;
    IF FOUND THEN
      IF journal.arguments_sha256<>args OR journal.site_id<>p_site_id OR journal.user_id<>p_user_id
        OR journal.instance_id<>p_instance_id OR journal.requirement_id IS DISTINCT FROM p_requirement_id THEN
        RAISE EXCEPTION 'Cloud operation mismatch' USING ERRCODE='CF004'; END IF;
      RETURN public.cloud_file_revision_json(journal.file_id,journal.version)||jsonb_build_object('state',journal.state);
    END IF;
    IF (action='create' AND (file_id IS NOT NULL OR p_input ? 'expected_version' OR p_input ? 'changes' OR NOT p_input ? 'content' OR NOT p_input ? 'name'))
      OR (action<>'create' AND (file_id IS NULL OR NOT p_input ? 'expected_version' OR (p_input->>'expected_version')::integer<1))
      OR (action='replace' AND (NOT p_input ? 'content' OR p_input ? 'changes'))
      OR (action='patch' AND (p_input ? 'content' OR NOT p_input ? 'changes')) THEN
      RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001';
    END IF;
    -- Validate supplied values even on stale versions, before any receipt exists.
    content:=p_input->>'content'; name:=p_input->>'name'; mime:=p_input->>'mime';
    IF octet_length(content)>262144 OR length(name) NOT BETWEEN 1 AND 200
      OR lower(name) IN ('.','..','.git','.github') OR name ~ '[[:cntrl:]/\\:]' OR btrim(name)<>name
      OR name ~ '[. ]$' OR name ~* '^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)'
      OR mime NOT IN ('text/plain','text/markdown','text/csv','application/json','text/html','text/css','text/javascript','application/javascript','application/xml','text/xml','application/yaml','text/yaml') THEN
      RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001';
    END IF;
    IF action='patch' THEN
      IF jsonb_array_length(p_input->'changes') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001'; END IF;
      FOR change IN SELECT value FROM jsonb_array_elements(p_input->'changes') LOOP
        IF jsonb_typeof(change)<>'object' OR NOT change ?& ARRAY['old_text','new_text'] OR change-ARRAY['old_text','new_text']<>'{}'::jsonb
          OR jsonb_typeof(change->'old_text')<>'string' OR jsonb_typeof(change->'new_text')<>'string' OR length(change->>'old_text')=0 THEN
          RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001'; END IF;
        patch_bytes:=patch_bytes+octet_length(change->>'old_text')+octet_length(change->>'new_text');
        IF octet_length(change->>'old_text')>262144 OR octet_length(change->>'new_text')>262144 OR patch_bytes>524288 THEN
          RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001'; END IF;
      END LOOP;
    END IF;
  END IF;

  IF p_operation<>'write' OR action<>'create' THEN
    IF file_id IS NULL OR (version IS NOT NULL AND version<1) THEN RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001'; END IF;
    SELECT * INTO f FROM public.cloud_files cf WHERE cf.id=file_id AND cf.site_id=p_site_id
      AND cf.instance_id=p_instance_id AND (p_requirement_id IS NULL OR cf.requirement_id=p_requirement_id) FOR UPDATE;
    IF NOT FOUND THEN
      IF p_operation='read' THEN RETURN NULL; END IF;
      RAISE EXCEPTION 'Cloud file unavailable' USING ERRCODE='CF003';
    END IF;
    PERFORM public.cloud_file_check_scope(p_site_id,p_user_id,p_instance_id,p_requirement_id);
    IF p_operation='read' THEN RETURN public.cloud_file_revision_json(file_id,coalesce(version,f.current_version)); END IF;
  END IF;

  IF p_operation='git_bind' THEN
    IF version IS NULL OR NOT p_input ?& ARRAY['repository','ref','path']
      OR length(p_input->>'repository')>200 OR p_input->>'repository' !~ '^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$'
      OR split_part(p_input->>'repository','/',2) IN ('.','..')
      OR p_input->>'ref' !~ '^refs/heads/cloud-files/[0-9a-f]{64}/v[1-9][0-9]*$'
      OR right(p_input->>'ref',length('/v'||version::text))<>'/v'||version::text THEN
      RAISE EXCEPTION 'Invalid cloud target' USING ERRCODE='CF001';
    END IF;
    SELECT * INTO g FROM public.cloud_file_git_results gr WHERE gr.file_id=cloud_file_store.file_id AND gr.version=cloud_file_store.version FOR UPDATE;
    PERFORM public.cloud_file_check_scope(p_site_id,p_user_id,p_instance_id,p_requirement_id);
    SELECT * INTO r FROM public.cloud_file_revisions cr WHERE cr.file_id=cloud_file_store.file_id AND cr.version=cloud_file_store.version;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cloud file unavailable' USING ERRCODE='CF003'; END IF;
    IF p_input->>'path'<>r.name THEN RAISE EXCEPTION 'Invalid cloud target' USING ERRCODE='CF001'; END IF;
    IF g.repository IS NOT NULL THEN
      IF g.repository IS DISTINCT FROM p_input->>'repository' OR g.ref IS DISTINCT FROM p_input->>'ref' OR g.path IS DISTINCT FROM p_input->>'path' THEN
        RAISE EXCEPTION 'Cloud target mismatch' USING ERRCODE='CF004';
      END IF;
    ELSE
      UPDATE public.cloud_file_git_results gr SET repository=p_input->>'repository',ref=p_input->>'ref',path=p_input->>'path'
        WHERE gr.file_id=cloud_file_store.file_id AND gr.version=cloud_file_store.version;
    END IF;
    RETURN public.cloud_file_revision_json(file_id,version);
  END IF;

  IF p_operation='git_result' THEN
    IF version IS NULL OR p_input->>'status' IS NULL OR p_input->>'status' NOT IN ('pending','committed','failed','conflict')
      OR ((p_input->>'status'='committed') IS DISTINCT FROM (p_input->>'commitSha' IS NOT NULL))
      OR (p_input->>'commitSha' IS NOT NULL AND p_input->>'commitSha' !~ '^[0-9a-f]{40}([0-9a-f]{24})?$') THEN
      RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001';
    END IF;
    SELECT * INTO g FROM public.cloud_file_git_results gr WHERE gr.file_id=cloud_file_store.file_id AND gr.version=cloud_file_store.version FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cloud file unavailable' USING ERRCODE='CF003'; END IF;
    IF p_input->>'status'='committed' AND g.repository IS NULL THEN RAISE EXCEPTION 'Cloud target required' USING ERRCODE='CF001'; END IF;
    PERFORM public.cloud_file_check_scope(p_site_id,p_user_id,p_instance_id,p_requirement_id);
    IF g.status='committed' THEN
      IF p_input->>'status'='committed' AND g.commit_sha IS DISTINCT FROM p_input->>'commitSha' THEN
        RAISE EXCEPTION 'Cloud operation mismatch' USING ERRCODE='CF004';
      END IF;
      RETURN public.cloud_file_revision_json(file_id,version);
    END IF;
    UPDATE public.cloud_file_git_results gr SET status=p_input->>'status',commit_sha=p_input->>'commitSha',updated_at=clock_timestamp()
      WHERE gr.file_id=cloud_file_store.file_id AND gr.version=cloud_file_store.version;
    RETURN public.cloud_file_revision_json(file_id,version);
  END IF;

  IF action<>'create' THEN
    SELECT * INTO r FROM public.cloud_file_revisions cr WHERE cr.file_id=f.id AND cr.version=f.current_version;
    IF f.current_version<>(p_input->>'expected_version')::integer THEN
      result:=public.cloud_file_revision_json(f.id,f.current_version)||jsonb_build_object('state','conflict');
      INSERT INTO public.cloud_file_operations(operation_id,file_id,arguments_sha256,site_id,user_id,instance_id,requirement_id,version,state)
        VALUES(operation_id,f.id,args,p_site_id,p_user_id,p_instance_id,p_requirement_id,f.current_version,'conflict');
      PERFORM public.cloud_file_check_quota(p_site_id,p_instance_id);
      RETURN result;
    END IF;
  END IF;
  content:=coalesce(p_input->>'content',r.content);
  name:=coalesce(p_input->>'name',r.name);
  mime:=coalesce(p_input->>'mime',r.mime,'text/plain');
  IF action='patch' THEN
    FOR change IN SELECT value FROM jsonb_array_elements(p_input->'changes') LOOP
      old_text:=change->>'old_text'; new_text:=change->>'new_text'; pos:=strpos(content,old_text);
      -- Search from the next character to reject overlapping ambiguous matches.
      IF pos=0 OR strpos(substr(content,pos+1),old_text)>0 THEN RAISE EXCEPTION 'Cloud patch conflict' USING ERRCODE='CF005'; END IF;
      content:=substr(content,1,pos-1)||new_text||substr(content,pos+length(old_text));
      IF octet_length(content)>262144 THEN RAISE EXCEPTION 'Invalid cloud input' USING ERRCODE='CF001'; END IF;
    END LOOP;
  END IF;
  IF action<>'create' AND content=r.content AND name=r.name AND mime=r.mime THEN
    result:=public.cloud_file_revision_json(f.id,f.current_version)||jsonb_build_object('state','unchanged');
  ELSE
    IF action='create' THEN
      INSERT INTO public.cloud_files(site_id,instance_id,requirement_id,current_version,created_by)
        VALUES(p_site_id,p_instance_id,p_requirement_id,1,p_user_id) RETURNING * INTO f;
      state:='created';
    ELSE
      UPDATE public.cloud_files cf SET current_version=cf.current_version+1 WHERE cf.id=f.id RETURNING * INTO f;
      state:='updated';
    END IF;
    INSERT INTO public.cloud_file_revisions(file_id,version,name,mime,content,sha256,bytes,created_by)
      VALUES(f.id,f.current_version,name,mime,content,encode(sha256(convert_to(content,'UTF8')),'hex'),octet_length(content),p_user_id);
    INSERT INTO public.cloud_file_git_results(file_id,version) VALUES(f.id,f.current_version);
    result:=public.cloud_file_revision_json(f.id,f.current_version)||jsonb_build_object('state',state);
  END IF;
  INSERT INTO public.cloud_file_operations(operation_id,file_id,arguments_sha256,site_id,user_id,instance_id,requirement_id,version,state)
    VALUES(operation_id,f.id,args,p_site_id,p_user_id,p_instance_id,p_requirement_id,f.current_version,result->>'state');
  PERFORM public.cloud_file_check_quota(p_site_id,p_instance_id);
  RETURN result;
END;
$$;

-- Serialize newly bound owner predicates against standalone write admission.
-- Both old and new owners are locked in deterministic order for rebinding.
CREATE FUNCTION public.cloud_file_lock_requirement_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_owner text; new_owner text;
BEGIN
  IF TG_OP<>'INSERT' THEN old_owner:=OLD.metadata->>'runner_instance_id'; END IF;
  IF TG_OP<>'DELETE' THEN new_owner:=NEW.metadata->>'runner_instance_id'; END IF;
  IF TG_OP='UPDATE' AND old_owner IS NOT DISTINCT FROM new_owner AND OLD.site_id IS NOT DISTINCT FROM NEW.site_id THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.remote_instances i WHERE i.id::text IN (old_owner,new_owner) ORDER BY i.id FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_requirement_binding_lock BEFORE INSERT OR UPDATE OF metadata,site_id OR DELETE ON public.requirements
FOR EACH ROW EXECUTE FUNCTION public.cloud_file_lock_requirement_binding();

CREATE FUNCTION public.cloud_file_lock_plan_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_owner uuid; new_owner uuid;
BEGIN
  IF TG_OP<>'INSERT' AND OLD.metadata->>'requirement_id' IS NOT NULL THEN old_owner:=OLD.instance_id; END IF;
  IF TG_OP<>'DELETE' AND NEW.metadata->>'requirement_id' IS NOT NULL THEN new_owner:=NEW.instance_id; END IF;
  IF TG_OP='UPDATE' AND old_owner IS NOT DISTINCT FROM new_owner
    AND OLD.metadata->>'requirement_id' IS NOT DISTINCT FROM NEW.metadata->>'requirement_id'
    AND OLD.site_id IS NOT DISTINCT FROM NEW.site_id THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.remote_instances i WHERE i.id IN (old_owner,new_owner) ORDER BY i.id FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_plan_binding_lock BEFORE INSERT OR UPDATE OF metadata,instance_id,site_id OR DELETE ON public.instance_plans
FOR EACH ROW EXECUTE FUNCTION public.cloud_file_lock_plan_binding();

-- Global cron recovery is service-only and bounded. A claim atomically advances
-- its durable visibility lease; a crashed worker needs no model rerun. Failed
-- results keep that lease/backoff. Successful versions are never claimed again.
CREATE FUNCTION public.claim_cloud_git_publications(p_limit integer DEFAULT 5)
RETURNS TABLE(site_id uuid,user_id uuid,instance_id uuid,requirement_id uuid,file_id uuid,version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'Invalid cloud claim limit' USING ERRCODE='CF001';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT g.file_id,g.version
    FROM public.cloud_file_git_results g
    JOIN public.cloud_files f ON f.id=g.file_id
    JOIN public.cloud_file_revisions r ON r.file_id=g.file_id AND r.version=g.version
    JOIN public.remote_instances i ON i.id=f.instance_id AND i.site_id=f.site_id AND i.is_archived IS NOT TRUE
    WHERE g.status IN ('pending','failed') AND g.next_retry_at<=clock_timestamp()
      AND public.site_user_has_effective_access(f.site_id,r.created_by) IS TRUE
      AND (f.requirement_id IS NULL OR EXISTS (
        SELECT 1 FROM public.requirements req WHERE req.id=f.requirement_id AND req.site_id=f.site_id
          AND (req.metadata->>'runner_instance_id'=f.instance_id::text OR EXISTS (
            SELECT 1 FROM public.instance_plans p WHERE p.instance_id=f.instance_id AND p.site_id=f.site_id
              AND p.metadata->>'requirement_id'=req.id::text))))
    ORDER BY g.next_retry_at,g.file_id,g.version
    LIMIT p_limit FOR UPDATE OF g SKIP LOCKED
  ), claimed AS (
    UPDATE public.cloud_file_git_results g SET
      next_retry_at=clock_timestamp()+make_interval(secs=>least(3600,300*(2^least(g.attempt_count,4))::integer)),
      last_attempt_at=clock_timestamp(),attempt_count=least(g.attempt_count+1,1000000)
    FROM due WHERE g.file_id=due.file_id AND g.version=due.version
    RETURNING g.file_id,g.version
  )
  SELECT f.site_id,r.created_by,f.instance_id,f.requirement_id,c.file_id,c.version
  FROM claimed c JOIN public.cloud_files f ON f.id=c.file_id
  JOIN public.cloud_file_revisions r ON r.file_id=c.file_id AND r.version=c.version;
END;
$$;

ALTER TABLE public.cloud_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_file_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_file_git_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_file_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cloud_files,public.cloud_file_revisions,public.cloud_file_git_results,public.cloud_file_operations FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.cloud_file_immutable(),public.cloud_file_revision_json(uuid,integer),
  public.cloud_file_check_quota(uuid,uuid),public.cloud_file_check_scope(uuid,uuid,uuid,uuid),public.cloud_file_store(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.cloud_file_store(uuid,uuid,uuid,uuid,text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.claim_cloud_git_publications(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cloud_file_lock_requirement_binding(),public.cloud_file_lock_plan_binding() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_cloud_git_publications(integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;