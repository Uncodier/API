-- Rollback:
--   Remove review_quarantine only from rows whose reason is
--   'Backfilled review quarantine', then increment backlog_revision.

-- Historical user_action rows remain untrusted and cannot release review work.
-- The existing requirements write guard expects JWT service-role provenance,
-- so the backfill supplies it transaction-locally without disabling triggers.
ALTER TABLE IF EXISTS public.requirements
  ADD COLUMN IF NOT EXISTS external_user_action_revision bigint
  NOT NULL DEFAULT 0;

DO $migration$
BEGIN
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );

  UPDATE public.requirements AS requirement
  SET
    backlog = jsonb_set(
      requirement.backlog,
      '{items}',
      (
        SELECT COALESCE(
          jsonb_agg(
            CASE
              WHEN item.value->>'status' = 'needs_review'
                AND COALESCE(
                  item.value->'review_quarantine'->>'active',
                  'false'
                ) <> 'true'
              THEN item.value || jsonb_build_object(
                'review_quarantine',
                jsonb_build_object(
                  'active', true,
                  'kind', 'manual',
                  'reason', 'Backfilled review quarantine',
                  'quarantined_at', COALESCE(
                    NULLIF(item.value->>'updated_at', ''),
                    timezone('utc', now())::text
                  ),
                  'external_action_revision',
                    requirement.external_user_action_revision
                )
              )
              ELSE item.value
            END
            ORDER BY item.ordinality
          ),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(requirement.backlog->'items')
          WITH ORDINALITY AS item(value, ordinality)
      ),
      false
    ),
    backlog_revision = COALESCE(requirement.backlog_revision, 0) + 1,
    updated_at = timezone('utc', now())
  WHERE jsonb_typeof(requirement.backlog->'items') = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(requirement.backlog->'items') AS item(value)
      WHERE item.value->>'status' = 'needs_review'
        AND COALESCE(
          item.value->'review_quarantine'->>'active',
          'false'
        ) <> 'true'
    );
END;
$migration$;
