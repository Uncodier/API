-- Rollback:
-- DROP FUNCTION IF EXISTS public.increment_system_memory_access(uuid, integer);

CREATE OR REPLACE FUNCTION public.increment_system_memory_access(
  p_memory_id uuid,
  p_amount integer
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.system_memories
  SET
    access_count = access_count + GREATEST(p_amount, 0),
    last_accessed = timezone('utc', now())
  WHERE id = p_memory_id;
$$;

REVOKE ALL ON FUNCTION public.increment_system_memory_access(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_system_memory_access(uuid, integer)
  TO service_role;
