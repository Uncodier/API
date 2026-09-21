-- Rollback (only before a recovered requirement runs again):
-- UPDATE public.requirements
-- SET status = 'blocked'
-- WHERE metadata->>'requirement_last_resume_action_id' =
--   'migration:recover-legacy-global-blocks:20260921143000'
--   AND metadata->>'cron_last_cycle_outcome' = 'remediation_handoff';
--
-- This data repair converts only legacy requirement-wide blocks whose runner
-- is still active, whose backlog has no scoped blockers, and which still have
-- independent runnable work. Manually paused runners are deliberately ignored.

DO $$
DECLARE
  v_requirement record;
  v_exhausted_item_ids text[];
  v_now timestamptz := timezone('utc', now());
BEGIN
  FOR v_requirement IN
    SELECT requirement.id, requirement.metadata->>'runner_instance_id' AS instance_id
    FROM public.requirements AS requirement
    JOIN public.remote_instances AS instance
      ON instance.id::text = requirement.metadata->>'runner_instance_id'
    WHERE requirement.status = 'blocked'
      AND requirement.cron IS NULL
      AND instance.status = 'running'
      AND requirement.metadata->>'cron_last_cycle_outcome' =
        'remediation_handoff'
      AND COALESCE(requirement.metadata->>'no_progress_cycles', '0') = '0'
      AND NOT COALESCE(
        requirement.metadata ? 'cron_blocker_provenance',
        false
      )
      AND NOT COALESCE(
        requirement.metadata ? 'cron_blocker_event_id',
        false
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          COALESCE(requirement.backlog->'items', '[]'::jsonb)
        ) AS item(value)
        WHERE jsonb_array_length(
          CASE
            WHEN jsonb_typeof(item.value->'blocked_by') = 'array'
              THEN item.value->'blocked_by'
            ELSE '[]'::jsonb
          END
        ) > 0
      )
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          COALESCE(requirement.backlog->'items', '[]'::jsonb)
        ) AS item(value)
        WHERE item.value->>'status' IN ('pending', 'in_progress')
          AND (
            CASE
              WHEN COALESCE(item.value->>'attempts', '') ~ '^[0-9]{1,9}$'
                THEN (item.value->>'attempts')::integer
              ELSE 0
            END
          ) < CASE
            WHEN item.value->>'tier' = 'ornamental' THEN 2
            ELSE 4
          END
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(item.value->'depends_on') = 'array'
                  THEN item.value->'depends_on'
                ELSE '[]'::jsonb
              END
            ) AS dependency(value)
            WHERE NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                COALESCE(requirement.backlog->'items', '[]'::jsonb)
              ) AS completed(value)
              WHERE completed.value->>'id' = dependency.value
                AND completed.value->>'status' = 'done'
            )
          )
      )
    FOR UPDATE OF requirement
  LOOP
    SELECT COALESCE(
      array_agg(item.value->>'id')
        FILTER (WHERE NULLIF(item.value->>'id', '') IS NOT NULL),
      ARRAY[]::text[]
    )
    INTO v_exhausted_item_ids
    FROM public.requirements AS requirement
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(requirement.backlog->'items', '[]'::jsonb)
    ) AS item(value)
    WHERE requirement.id = v_requirement.id
      AND item.value->>'status' IN ('pending', 'in_progress')
      AND (
        CASE
          WHEN COALESCE(item.value->>'attempts', '') ~ '^[0-9]{1,9}$'
            THEN (item.value->>'attempts')::integer
          ELSE 0
        END
      ) >= CASE
        WHEN item.value->>'tier' = 'ornamental' THEN 2
        ELSE 4
      END;

    UPDATE public.requirements AS requirement
    SET
      backlog = jsonb_set(
        requirement.backlog,
        '{items}',
        (
          SELECT jsonb_agg(
            CASE
              WHEN item.value->>'status' IN ('pending', 'in_progress')
                AND (
                  CASE
                    WHEN COALESCE(item.value->>'attempts', '') ~ '^[0-9]{1,9}$'
                      THEN (item.value->>'attempts')::integer
                    ELSE 0
                  END
                ) >= CASE
                  WHEN item.value->>'tier' = 'ornamental' THEN 2
                  ELSE 4
                END
              THEN item.value || jsonb_build_object(
                'status', 'needs_review',
                'updated_at', v_now,
                'assumptions',
                  CASE
                    WHEN jsonb_typeof(item.value->'assumptions') = 'array'
                      THEN item.value->'assumptions'
                    ELSE '[]'::jsonb
                  END ||
                  jsonb_build_array(
                    'Legacy requirement-wide block recovered; this exhausted item remains isolated for review.'
                  )
              )
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
      updated_at = v_now
    WHERE requirement.id = v_requirement.id;

    IF cardinality(v_exhausted_item_ids) > 0 THEN
      UPDATE public.instance_plans AS plan
      SET
        steps = (
          SELECT COALESCE(
            jsonb_agg(
              CASE
                WHEN COALESCE(step.value->>'status', 'pending')
                    IN ('pending', 'in_progress', 'failed')
                  AND COALESCE(
                    step.value->'metadata'->>'backlog_item_id',
                    step.value->>'backlog_item_id'
                  ) = ANY (v_exhausted_item_ids)
                THEN step.value || jsonb_build_object(
                  'status', 'cancelled',
                  'completed_at', v_now,
                  'error_message',
                    'Cancelled because the linked legacy backlog item exhausted its attempt budget.',
                  'infrastructure_generation',
                    CASE
                      WHEN COALESCE(
                        step.value->>'infrastructure_generation',
                        ''
                      ) ~ '^[0-9]{1,9}$'
                        THEN (
                          step.value->>'infrastructure_generation'
                        )::integer + 1
                      ELSE 1
                    END
                )
                ELSE step.value
              END
              ORDER BY step.ordinality
            ),
            '[]'::jsonb
          )
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(plan.steps) = 'array'
                THEN plan.steps
              ELSE '[]'::jsonb
            END
          ) WITH ORDINALITY AS step(value, ordinality)
        ),
        updated_at = v_now
      WHERE plan.instance_id = v_requirement.instance_id::uuid
        AND plan.metadata->>'requirement_id' =
          v_requirement.id::text
        AND plan.status IN (
          'pending',
          'in_progress',
          'active',
          'paused',
          'failed',
          'blocked'
        )
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(plan.steps) = 'array'
                THEN plan.steps
              ELSE '[]'::jsonb
            END
          ) AS candidate(value)
          WHERE COALESCE(candidate.value->>'status', 'pending')
              IN ('pending', 'in_progress', 'failed')
            AND COALESCE(
              candidate.value->'metadata'->>'backlog_item_id',
              candidate.value->>'backlog_item_id'
            ) = ANY (v_exhausted_item_ids)
        );
    END IF;

    PERFORM public.resume_instance_execution_on_user_action(
      v_requirement.id,
      v_requirement.instance_id::uuid,
      false,
      'migration:recover-legacy-global-blocks:20260921143000',
      false
    );
  END LOOP;
END;
$$;
