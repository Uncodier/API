-- Rollback: restore the previous JSONB counters from a database backup.
-- The legacy counters were unbounded telemetry, so their exact values cannot
-- be reconstructed safely after this one-time normalization.

UPDATE public.requirements AS requirement
SET
  backlog = jsonb_set(
    requirement.backlog,
    '{items}',
    (
      SELECT jsonb_agg(
        CASE
          WHEN COALESCE(item.value->>'status', '') IN ('pending', 'in_progress')
          THEN
            CASE
              WHEN COALESCE(
                item.value->'tool_failures'->>'acceptance_contract',
                ''
              ) ~ '^[0-9]{1,9}$'
                AND (
                  item.value->'tool_failures'->>'acceptance_contract'
                )::integer >= 3
              THEN jsonb_set(
                CASE
                  WHEN COALESCE(
                    item.value->'tool_failures'->>'evidence_collector',
                    ''
                  ) ~ '^[0-9]{1,9}$'
                    AND (
                      item.value->'tool_failures'->>'evidence_collector'
                    )::integer >= 3
                  THEN jsonb_set(
                    item.value,
                    '{tool_failures,evidence_collector}',
                    '0'::jsonb,
                    true
                  )
                  ELSE item.value
                END,
                '{tool_failures,acceptance_contract}',
                '0'::jsonb,
                true
              )
              WHEN COALESCE(
                item.value->'tool_failures'->>'evidence_collector',
                ''
              ) ~ '^[0-9]{1,9}$'
                AND (
                  item.value->'tool_failures'->>'evidence_collector'
              )::integer >= 3
              THEN jsonb_set(
                item.value,
                '{tool_failures,evidence_collector}',
                '0'::jsonb,
                true
              )
              ELSE item.value
            END
          ELSE item.value
        END
        ORDER BY item.ordinality
      )
      FROM jsonb_array_elements(
        COALESCE(requirement.backlog->'items', '[]'::jsonb)
      ) WITH ORDINALITY AS item(value, ordinality)
    )
  ),
  backlog_revision = COALESCE(requirement.backlog_revision, 0) + 1,
  updated_at = timezone('utc', now())
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(
    COALESCE(requirement.backlog->'items', '[]'::jsonb)
  ) AS item(value)
  WHERE COALESCE(item.value->>'status', '') IN ('pending', 'in_progress')
    AND (
      (
        COALESCE(
          item.value->'tool_failures'->>'evidence_collector',
          ''
        ) ~ '^[0-9]{1,9}$'
        AND (
          item.value->'tool_failures'->>'evidence_collector'
        )::integer >= 3
      )
      OR (
        COALESCE(
          item.value->'tool_failures'->>'acceptance_contract',
          ''
        ) ~ '^[0-9]{1,9}$'
        AND (
          item.value->'tool_failures'->>'acceptance_contract'
        )::integer >= 3
      )
    )
);
