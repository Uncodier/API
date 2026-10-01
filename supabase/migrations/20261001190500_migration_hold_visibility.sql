-- Target: Makinari. Publish a platform hold in the same transaction as its receipt.
-- Never rely on a later worker/LLM: the scheduler can revoke that worker's lease
-- as soon as the requirement becomes blocked. No holds are released or backfilled.
BEGIN;

CREATE FUNCTION public.publish_requirement_migration_hold()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_requirement public.requirements%ROWTYPE;
  v_instance_id uuid;
  v_message text;
  v_hold jsonb;
  v_remaining public.requirement_migration_lifecycle%ROWTYPE;
  v_public_reason text;
BEGIN
  SELECT * INTO v_requirement FROM public.requirements
    WHERE id = NEW.requirement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF NEW.state <> 'platform_review' THEN
    IF TG_OP = 'UPDATE' AND OLD.state = 'platform_review' THEN
      SELECT * INTO v_remaining FROM public.requirement_migration_lifecycle
        WHERE requirement_id = NEW.requirement_id AND state = 'platform_review'
        ORDER BY updated_at DESC, file LIMIT 1;
      IF FOUND THEN
        UPDATE public.requirements SET metadata = COALESCE(metadata, '{}'::jsonb) ||
          jsonb_build_object('execution_hold', jsonb_build_object('kind', 'migration_platform_review',
            'file', v_remaining.file, 'reason', 'Another database migration still requires technical reconciliation.', 'attempts', v_remaining.attempts,
            'updated_at', v_remaining.updated_at, 'resolution_actor', 'platform', 'user_action_required', false))
          WHERE id = NEW.requirement_id;
      ELSE
        UPDATE public.requirements SET metadata = COALESCE(metadata, '{}'::jsonb) - 'execution_hold'
          WHERE id = NEW.requirement_id;
      END IF;
    END IF;
    -- Clearing the projection does not reopen the requirement, instance or plan.
    RETURN NEW;
  END IF;

  -- Lifecycle reasons may contain SQL/provider diagnostics. Never copy those to
  -- browser-readable metadata or status messages; retain them in the private receipt.
  v_public_reason := CASE
    WHEN NEW.review ? 'diagnostic_id' THEN 'Independent migration diagnosis did not produce a validated correction. Technical reconciliation is required.'
    WHEN NEW.attempts >= 5 THEN 'The migration correction/review budget is exhausted. Technical reconciliation is required.'
    ELSE 'Database migration safety validation requires technical reconciliation.' END;
  v_hold := jsonb_build_object('kind', 'migration_platform_review', 'file', NEW.file,
    'reason', v_public_reason, 'attempts', NEW.attempts, 'updated_at', NEW.updated_at,
    'resolution_actor', 'platform', 'user_action_required', false);
  v_message := 'Execution blocked: ' || NEW.file || '. ' || v_public_reason ||
    ' Technical reconciliation is required; no customer approval is needed. ' ||
    'Updating a plan step does not resume execution. The attempt count records assignments/reviews, not proof of irreparability.';

  UPDATE public.requirements SET status = 'blocked', updated_at = clock_timestamp(),
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('execution_hold', v_hold)
    WHERE id = NEW.requirement_id;

  IF COALESCE(v_requirement.metadata->>'runner_instance_id', '')
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id INTO v_instance_id FROM public.remote_instances
      WHERE id = (v_requirement.metadata->>'runner_instance_id')::uuid
        AND site_id = v_requirement.site_id FOR UPDATE;
  END IF;
  IF v_instance_id IS NOT NULL THEN
    UPDATE public.instance_plans AS plan SET status = 'blocked', updated_at = clock_timestamp(),
      steps = CASE WHEN jsonb_typeof(plan.steps) = 'array' THEN
        (SELECT COALESCE(jsonb_agg(CASE WHEN step->>'status' IN ('pending', 'in_progress')
          THEN step || jsonb_build_object('status', 'blocked', 'error_message', v_message)
          ELSE step END ORDER BY ordinal), '[]'::jsonb)
         FROM jsonb_array_elements(plan.steps) WITH ORDINALITY items(step, ordinal))
        ELSE plan.steps END
      WHERE plan.instance_id = v_instance_id
        AND plan.metadata->>'requirement_id' = NEW.requirement_id::text
        AND COALESCE(plan.metadata->>'workflow_template', 'false') <> 'true'
        AND plan.status IN ('pending', 'in_progress', 'active', 'blocked');
    -- Preserve manual pauses, terminal plans and unrelated work sharing a chat.
    UPDATE public.remote_instances SET status = 'pending', updated_at = clock_timestamp()
      WHERE id = v_instance_id AND status IN ('running', 'starting')
        AND NOT EXISTS (SELECT 1 FROM public.instance_plans p
          WHERE p.instance_id = v_instance_id AND p.status IN ('pending', 'in_progress', 'active')
            AND p.metadata->>'requirement_id' IS DISTINCT FROM NEW.requirement_id::text
            AND COALESCE(p.metadata->>'workflow_template', 'false') <> 'true')
        AND NOT EXISTS (SELECT 1 FROM public.requirements r
          WHERE r.id <> NEW.requirement_id AND r.status IN ('backlog', 'in-progress')
            AND r.metadata->>'runner_instance_id' = v_instance_id::text);
  END IF;

  IF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.reason IS DISTINCT FROM NEW.reason THEN
    INSERT INTO public.requirement_status(requirement_id, site_id, instance_id, stage, message)
      VALUES (NEW.requirement_id, v_requirement.site_id, v_instance_id, 'blocked', v_message);
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.publish_requirement_migration_hold() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER requirement_migration_hold_visibility
  AFTER INSERT OR UPDATE ON public.requirement_migration_lifecycle
  FOR EACH ROW EXECUTE FUNCTION public.publish_requirement_migration_hold();

COMMIT;