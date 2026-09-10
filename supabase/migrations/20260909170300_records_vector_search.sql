-- Create match_records RPC for vector similarity search using a query embedding directly
CREATE OR REPLACE FUNCTION public.match_records(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  p_site_id uuid
)
RETURNS TABLE (
  id uuid,
  category_id uuid,
  title text,
  description text,
  summary text,
  data jsonb,
  relations jsonb,
  status text,
  created_at timestamptz,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    category_id,
    title,
    description,
    summary,
    data,
    relations,
    status,
    created_at,
    1 - (records.embedding <=> query_embedding) as similarity
  FROM
    public.records
  WHERE
    site_id = p_site_id
    AND 1 - (records.embedding <=> query_embedding) > match_threshold
  ORDER BY
    records.embedding <=> query_embedding
  LIMIT
    match_count;
$$;
