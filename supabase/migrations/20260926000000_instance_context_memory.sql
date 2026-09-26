-- Durable, per-instance context cursor. Never delete instance_logs during compaction.
BEGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE EXTENSION vector WITH SCHEMA extensions;
  END IF;
END $$;
DO $$ DECLARE v_schema text; BEGIN
  SELECT n.nspname INTO v_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'vector';
  IF v_schema IS NULL OR v_schema NOT IN ('public', 'extensions') THEN
    RAISE EXCEPTION 'Instance context requires pgvector in public or extensions schema (found: %)',
      coalesce(v_schema, 'missing');
  END IF;
END $$;
SET LOCAL search_path = public, extensions, pg_temp;


CREATE TABLE public.instance_context_state (
  instance_id uuid PRIMARY KEY REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  cursor_at timestamptz,
  cursor_log_id uuid,
  revision bigint NOT NULL DEFAULT 0,
  model text,
  provider text,
  used_tokens integer,
  output_tokens integer NOT NULL DEFAULT 0,
  available_tokens integer,
  measured_at timestamptz,
  source text NOT NULL DEFAULT 'estimate',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.instance_context_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES public.remote_instances(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  end_log_id uuid NOT NULL,
  summary text NOT NULL,
  embedding vector(1536) NOT NULL,
  embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instance_context_memories_range CHECK (end_at >= start_at),
  CONSTRAINT instance_context_memories_unique UNIQUE (instance_id, start_at, end_at, end_log_id)
);
CREATE INDEX instance_context_memories_scope_idx
  ON public.instance_context_memories (site_id, instance_id, end_at DESC);
CREATE INDEX instance_context_memories_vector_idx
  ON public.instance_context_memories USING hnsw (embedding vector_cosine_ops);

ALTER TABLE public.instance_context_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_context_memories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instance_context_state, public.instance_context_memories FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.instance_context_state TO authenticated;
-- The RPCs are SECURITY INVOKER; do not rely on project-specific default
-- privileges for their service-role table access.
GRANT SELECT, INSERT, UPDATE ON public.instance_context_state TO service_role;
GRANT SELECT, INSERT ON public.instance_context_memories TO service_role;
CREATE POLICY instance_context_state_read ON public.instance_context_state FOR SELECT TO authenticated
  USING (public.current_user_site_role(site_id) IS NOT NULL);

-- Metrics updates never overwrite the cursor or revision.
CREATE FUNCTION public.record_instance_context_usage(
  p_instance_id uuid, p_site_id uuid, p_model text, p_provider text,
  p_used_tokens integer, p_output_tokens integer, p_available_tokens integer,
  p_source text, p_measured_at timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.instance_context_state
    (instance_id, site_id, model, provider, used_tokens, output_tokens, available_tokens, source, measured_at)
  SELECT p_instance_id, p_site_id, p_model, p_provider, p_used_tokens, p_output_tokens,
    p_available_tokens, p_source, p_measured_at
  WHERE EXISTS (SELECT 1 FROM public.remote_instances WHERE id = p_instance_id AND site_id = p_site_id)
  ON CONFLICT (instance_id) DO UPDATE SET
    model = EXCLUDED.model, provider = EXCLUDED.provider, used_tokens = EXCLUDED.used_tokens,
    output_tokens = EXCLUDED.output_tokens,
    available_tokens = EXCLUDED.available_tokens, source = EXCLUDED.source,
    measured_at = EXCLUDED.measured_at, updated_at = now()
  WHERE instance_context_state.site_id = EXCLUDED.site_id
    AND (instance_context_state.measured_at IS NULL OR instance_context_state.measured_at <= EXCLUDED.measured_at);
END $$;
REVOKE ALL ON FUNCTION public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_instance_context_usage(uuid,uuid,text,text,integer,integer,integer,text,timestamptz) TO service_role;

-- Atomic compare-and-swap: memory and cursor either commit together or not at all.
CREATE FUNCTION public.commit_instance_context_memory(
  p_instance_id uuid, p_site_id uuid, p_expected_cursor timestamptz, p_expected_log_id uuid,
  p_start_at timestamptz, p_end_at timestamptz, p_end_log_id uuid,
  p_log_ids uuid[], p_summary text, p_embedding vector(1536)
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_cursor timestamptz; v_log_id uuid; v_actual_ids uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.remote_instances WHERE id = p_instance_id AND site_id = p_site_id)
    OR p_end_at < p_start_at OR length(trim(p_summary)) = 0
    OR coalesce(array_length(p_log_ids, 1), 0) = 0 THEN RETURN false; END IF;
  INSERT INTO public.instance_context_state (instance_id, site_id) VALUES (p_instance_id, p_site_id)
    ON CONFLICT (instance_id) DO NOTHING;
  SELECT cursor_at, cursor_log_id INTO v_cursor, v_log_id FROM public.instance_context_state
    WHERE instance_id = p_instance_id AND site_id = p_site_id FOR UPDATE;
  IF v_cursor IS DISTINCT FROM p_expected_cursor OR v_log_id IS DISTINCT FROM p_expected_log_id OR
     (v_cursor IS NOT NULL AND (p_end_at, p_end_log_id) <= (v_cursor, v_log_id)) THEN RETURN false; END IF;
  -- Verify that the summary covers the exact contiguous log segment as of the
  -- locked cursor. Do not silently cross a pending user action or an unseen page.
  SELECT array_agg(l.id ORDER BY l.created_at, l.id) INTO v_actual_ids
    FROM public.instance_logs l
    WHERE l.instance_id = p_instance_id AND l.site_id = p_site_id
      AND l.log_type IN ('user_action','agent_action','tool_call','error',
                         'execution_summary','infrastructure','sandbox_test_failure')
      AND (v_cursor IS NULL OR (l.created_at, l.id) > (v_cursor, v_log_id))
      AND (l.created_at, l.id) <= (p_end_at, p_end_log_id);
  IF v_actual_ids IS DISTINCT FROM p_log_ids THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.instance_logs l
    WHERE l.id = ANY(p_log_ids) AND (l.details->>'status' = 'queued'
      OR l.details->>'streaming' = 'true')) THEN RETURN false; END IF;
  INSERT INTO public.instance_context_memories (instance_id, site_id, start_at, end_at, end_log_id, summary, embedding)
    VALUES (p_instance_id, p_site_id, p_start_at, p_end_at, p_end_log_id, p_summary, p_embedding);
  UPDATE public.instance_context_state SET cursor_at = p_end_at, cursor_log_id = p_end_log_id,
    revision = revision + 1, updated_at = now()
    WHERE instance_id = p_instance_id AND site_id = p_site_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.commit_instance_context_memory(uuid,uuid,timestamptz,uuid,timestamptz,timestamptz,uuid,uuid[],text,vector) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_instance_context_memory(uuid,uuid,timestamptz,uuid,timestamptz,timestamptz,uuid,uuid[],text,vector) TO service_role;

CREATE FUNCTION public.match_instance_context_memories(
  p_instance_id uuid, p_site_id uuid, p_embedding vector(1536), p_limit integer DEFAULT 3
) RETURNS TABLE (id uuid, summary text, similarity float) LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, extensions, pg_temp AS $$
  SELECT m.id, m.summary, (1 - (m.embedding <=> p_embedding))::float
  FROM public.instance_context_memories m
  WHERE m.instance_id = p_instance_id AND m.site_id = p_site_id
  ORDER BY m.embedding <=> p_embedding LIMIT LEAST(GREATEST(p_limit, 1), 5);
$$;
REVOKE ALL ON FUNCTION public.match_instance_context_memories(uuid,uuid,vector,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_instance_context_memories(uuid,uuid,vector,integer) TO service_role;
COMMIT;