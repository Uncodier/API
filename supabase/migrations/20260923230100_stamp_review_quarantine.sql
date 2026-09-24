-- Rollback:
--   DROP TRIGGER IF EXISTS requirements_review_quarantine_stamp ON public.requirements;
--   DROP FUNCTION IF EXISTS public.stamp_requirement_review_quarantine();

CREATE OR REPLACE FUNCTION public.stamp_requirement_review_quarantine()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_changed boolean := false;
  v_now timestamptz := timezone('utc', now());
BEGIN
  IF jsonb_typeof(NEW.backlog->'items') <> 'array' THEN
    RETURN NEW;
  END IF;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(NEW.backlog->'items')
      WITH ORDINALITY
    ORDER BY ordinality
  LOOP
    IF v_item->>'status' = 'needs_review'
      AND COALESCE(
        v_item->'review_quarantine'->>'active',
        'false'
      ) <> 'true'
    THEN
      v_item := v_item || jsonb_build_object(
        'review_quarantine',
        jsonb_build_object(
          'active', true,
          'kind', 'manual',
          'reason', 'Review quarantine created by database guard',
          'quarantined_at', v_now,
          'external_action_revision',
            NEW.external_user_action_revision
        ),
        'plan_cancellation_pending',
        COALESCE(
          v_item->'plan_cancellation_pending',
          jsonb_build_object(
            'reason', 'Backlog item entered needs_review',
            'requested_at', v_now
          )
        )
      );
      v_changed := true;
    END IF;
    v_items := v_items || jsonb_build_array(v_item);
  END LOOP;

  IF v_changed THEN
    NEW.backlog := jsonb_set(NEW.backlog, '{items}', v_items, false);
    NEW.backlog_revision := GREATEST(
      COALESCE(NEW.backlog_revision, 0),
      COALESCE(OLD.backlog_revision, 0) + 1
    );
    NEW.updated_at := v_now;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS requirements_review_quarantine_stamp
  ON public.requirements;
CREATE TRIGGER requirements_review_quarantine_stamp
  BEFORE UPDATE OF backlog ON public.requirements
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_requirement_review_quarantine();
