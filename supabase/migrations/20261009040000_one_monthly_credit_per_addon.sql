BEGIN;
SET LOCAL lock_timeout = '5s';

-- Forward-only allowance change: do not rewrite current-period balances, past
-- payments, credit ledgers or immutable paid subscription coverage. Future
-- eligible renewals and paid subscription changes use the new allowance.
CREATE OR REPLACE FUNCTION public.site_plan_credit_allowance(p_plan text, p_addons integer DEFAULT 0)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN CASE lower(trim(p_plan))
    WHEN 'engine' THEN 20 WHEN 'starter' THEN 20
    WHEN 'foundry' THEN 100 WHEN 'startup' THEN 100
    WHEN 'enterprise' THEN 500
    WHEN 'commission' THEN 1 WHEN 'free' THEN 1 WHEN 'toolbox' THEN 1
    ELSE 0 END
    + CASE WHEN lower(trim(p_plan)) IN ('engine','starter','foundry','startup','enterprise')
      THEN greatest(coalesce(p_addons, 0), 0) ELSE 0 END;
END;
$$;

REVOKE ALL ON FUNCTION public.site_plan_credit_allowance(text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.site_plan_credit_allowance(text,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;