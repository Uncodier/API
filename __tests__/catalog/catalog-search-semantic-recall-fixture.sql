-- Disposable PGlite AND real local PostgreSQL; vector math is substituted in both.
-- A unit query vector has cosine equal to the fixture's first component.
BEGIN;
INSERT INTO sites(id,name,archived_at) VALUES
  ('50000000-0000-4000-8000-000000000001','Recall scoped',NULL),
  ('50000000-0000-4000-8000-000000000002','Recall nearer other site',NULL),
  ('50000000-0000-4000-8000-000000000003','Recall eligibility',NULL),
  ('50000000-0000-4000-8000-000000000004','Recall archived site',now());

INSERT INTO catalog_items(id,site_id,name,sku,currency)
SELECT ('51000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  '50000000-0000-4000-8000-000000000001', 'Scoped product ' || n, 'RECALL-' || n,
  CASE WHEN n=104 THEN 'EUR' ELSE 'USD' END
FROM generate_series(1,105) n;
INSERT INTO catalog_items(id,site_id,name)
SELECT ('52000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  '50000000-0000-4000-8000-000000000002', 'Closer cross-site product ' || n
FROM generate_series(1,80) n;

UPDATE catalog_search_documents d SET embedding=(
  SELECT array_agg(CASE WHEN k=1 THEN v.similarity WHEN k=2 THEN sqrt(1-v.similarity*v.similarity) ELSE 0 END ORDER BY k)
  FROM generate_series(1,1536) k),
  embedding_model='openai/text-embedding-3-small', embedding_source_hash=d.source_hash
FROM (SELECT id, CASE WHEN site_id='50000000-0000-4000-8000-000000000002' THEN 0.99::double precision
  WHEN sku='RECALL-103' THEN 0.332 WHEN sku='RECALL-104' THEN 0.317
  WHEN sku='RECALL-105' THEN 0.1 ELSE 0.7 END AS similarity FROM catalog_items
  WHERE site_id IN ('50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002')) v
WHERE d.catalog_item_id=v.id;

-- Every edge vector is closer than the sole channel-eligible item. Invalid model,
-- stale/null source hash, null vector, archived/unavailable/live-parent/site rules
-- must be applied before a one-row candidate cap, not to an ANN's first neighbors.
INSERT INTO catalog_items(id,site_id,name,status,availability_status,is_marketplace_listed,is_pos_available,parent_id)
SELECT ('53000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  '50000000-0000-4000-8000-000000000003', 'Edge product ' || n,
  CASE WHEN n=6 THEN 'archived' ELSE 'active' END,
  CASE WHEN n=7 THEN 'unavailable' ELSE 'available' END,
  n<>8, n<>9, NULL::uuid
FROM generate_series(1,11) n;
UPDATE catalog_items SET parent_id='53000000-0000-4000-8000-000000000006'
WHERE id='53000000-0000-4000-8000-000000000010';
INSERT INTO catalog_items(id,site_id,name) VALUES
  ('54000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000004','Archived site closest');
UPDATE catalog_search_documents d SET embedding=(SELECT array_agg(
  CASE WHEN k=1 THEN CASE WHEN right(d.catalog_item_id::text,12)='000000000001' AND d.site_id='50000000-0000-4000-8000-000000000003' THEN 0.5 ELSE 1 END
    WHEN k=2 AND right(d.catalog_item_id::text,12)='000000000001' AND d.site_id='50000000-0000-4000-8000-000000000003' THEN sqrt(0.75) ELSE 0 END ORDER BY k)
  FROM generate_series(1,1536) k), embedding_model='openai/text-embedding-3-small', embedding_source_hash=d.source_hash
WHERE d.site_id IN ('50000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000004');
UPDATE catalog_search_documents SET embedding_model='different/model' WHERE catalog_item_id='53000000-0000-4000-8000-000000000002';
UPDATE catalog_search_documents SET embedding_source_hash='stale' WHERE catalog_item_id='53000000-0000-4000-8000-000000000003';
UPDATE catalog_search_documents SET embedding_source_hash=NULL WHERE catalog_item_id='53000000-0000-4000-8000-000000000004';
UPDATE catalog_search_documents SET embedding=NULL WHERE catalog_item_id='53000000-0000-4000-8000-000000000005';
UPDATE catalog_search_documents SET site_id='50000000-0000-4000-8000-000000000002'
WHERE catalog_item_id='53000000-0000-4000-8000-000000000011';

SET ROLE service_role;
DO $assert$
DECLARE
  v_query double precision[] := ARRAY[1::double precision] || array_fill(0::double precision,ARRAY[1535]);
  v_ids uuid[]; v_count integer; v_channel text; v_score double precision; v_exact boolean;
  v_scope uuid := '50000000-0000-4000-8000-000000000001';
BEGIN
  SELECT array_agg(r.id ORDER BY r.score DESC,r.id) INTO v_ids
  FROM catalog_search_candidates(v_scope,'shop','semantic intent','{}','semantic',v_query,201,0.25) r;
  IF cardinality(v_ids)<>104 OR v_ids[103]<>'51000000-0000-4000-8000-000000000103'::uuid
    OR v_ids[104]<>'51000000-0000-4000-8000-000000000104'::uuid THEN
    RAISE EXCEPTION 'scoped recall must return all 104 eligible, including 0.332/0.317, excluding unrelated 0.1';
  END IF;
  SELECT count(*) INTO v_count FROM catalog_search_candidates(v_scope,'shop','semantic intent','{}','semantic',v_query,201);
  IF v_count<>102 THEN RAISE EXCEPTION 'SQL default similarity must remain 0.35'; END IF;
  SELECT array_agg(r.id ORDER BY r.score DESC,r.id) INTO v_ids
  FROM catalog_search_candidates(v_scope,'shop','semantic intent','{}','semantic',v_query,5,0.25) r;
  IF v_ids<>ARRAY(SELECT ('51000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,5) n) THEN
    RAISE EXCEPTION 'exact scoped top K must use deterministic distance/id ties';
  END IF;
  SELECT r.score,r.exact_match INTO v_score,v_exact
  FROM catalog_search_candidates(v_scope,'shop','RECALL-104','{"currency":"EUR"}','semantic',v_query,1,0.25) r;
  IF v_score IS NULL OR abs(v_score-0.317)>0.000001 OR v_exact IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'allowlisted currency filter must run before cap, preserving score/exact DTO';
  END IF;
  SELECT count(*) INTO v_count FROM catalog_search_candidates(v_scope,'shop','semantic intent','{}','semantic',v_query,201,1);
  IF v_count<>0 THEN RAISE EXCEPTION 'explicit similarity floor must not be lowered'; END IF;
  SELECT count(*) INTO v_count FROM catalog_search_candidates(NULL,'marketplace','semantic intent',
    '{"currency":"EUR"}','semantic',v_query,201,0.25);
  IF v_count<>1 THEN RAISE EXCEPTION 'global marketplace filter must run before cap'; END IF;

  FOREACH v_channel IN ARRAY ARRAY['shop','marketplace','tools','pos'] LOOP
    SELECT array_agg(r.id ORDER BY r.score DESC,r.id) INTO v_ids
    FROM catalog_search_candidates('50000000-0000-4000-8000-000000000003',v_channel,'semantic intent',
      '{"is_marketplace_listed":true,"is_pos_available":true}','semantic',v_query,1,0.25) r;
    IF v_ids IS DISTINCT FROM ARRAY['53000000-0000-4000-8000-000000000001'::uuid] THEN
      RAISE EXCEPTION 'current model/hash, live channel/parent/site eligibility before top K: %',v_channel;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_count FROM catalog_search_candidates('50000000-0000-4000-8000-000000000004',
    'catalog','semantic intent','{}','semantic',v_query,1,0.25);
  IF v_count<>0 THEN RAISE EXCEPTION 'archived site must not enter semantic candidates'; END IF;
  -- Admin channel intentionally admits archived items, keeping existing policy.
  SELECT r.id INTO v_scope FROM catalog_search_candidates('50000000-0000-4000-8000-000000000003',
    'catalog','semantic intent','{"status":"archived"}','semantic',v_query,1,0.25) r;
  IF v_scope IS DISTINCT FROM '53000000-0000-4000-8000-000000000006'::uuid THEN
    RAISE EXCEPTION 'catalog explicit status policy must remain unchanged';
  END IF;
END;
$assert$;
RESET ROLE;

-- Thousands of eligible vectors still produce a complete, deterministic 201-row
-- evidence window. This is a correctness fixture, NOT a native-vector benchmark.
INSERT INTO catalog_items(id,site_id,name,currency)
SELECT ('55000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  '50000000-0000-4000-8000-000000000002', 'Large eligible product ' || n, 'GBP'
FROM generate_series(1,4000) n;
UPDATE catalog_search_documents SET
  embedding=ARRAY[1::double precision] || array_fill(0::double precision,ARRAY[1535]),
  embedding_model='openai/text-embedding-3-small',embedding_source_hash=source_hash
WHERE catalog_item_id::text LIKE '55000000-%';
SET ROLE service_role;
DO $scale$
DECLARE
  v_query double precision[] := ARRAY[1::double precision] || array_fill(0::double precision,ARRAY[1535]);
  v_site uuid; v_limit integer; v_ids uuid[];
BEGIN
  FOREACH v_site IN ARRAY ARRAY[NULL::uuid,'50000000-0000-4000-8000-000000000002'::uuid] LOOP
    FOREACH v_limit IN ARRAY ARRAY[5,200,201] LOOP
      SELECT array_agg(r.id ORDER BY r.score DESC,r.id) INTO v_ids
      FROM catalog_search_candidates(v_site,'marketplace','semantic intent','{"currency":"GBP"}',
        'semantic',v_query,v_limit,0.25) r;
      IF v_ids IS DISTINCT FROM ARRAY(SELECT ('55000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
        FROM generate_series(1,v_limit) n) THEN
        RAISE EXCEPTION '4000 eligible must produce exact scoped/global % candidate prefix',v_limit;
      END IF;
    END LOOP;
  END LOOP;
END;
$scale$;
RESET ROLE;
ROLLBACK;