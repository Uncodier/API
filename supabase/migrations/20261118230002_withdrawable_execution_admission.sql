BEGIN;
SET LOCAL lock_timeout='5s';

-- These existing gates must agree with the debit and reservation functions.
-- Preserve every scheduler/recovery/ownership guard, lock and function ACL.
-- Reviewed bodies match the active production definitions; refuse schema drift
-- rather than silently replacing a different scheduler or weakening its fences.
DO $migration$
DECLARE change record; target regprocedure; definition text; body text;
  restored text; occurrences integer;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('public.claim_agent_requirement_run_before_commands(uuid[],integer,integer,uuid[])',
      'a2480c1b9055bcc2b096d1dab3564f70',
      'admission_billing.credits_available>0',
      $predicate$admission_billing.credits_available>=0
        AND admission_billing.credits_available::text NOT IN ('NaN','Infinity','-Infinity')
        AND coalesce(admission_billing.account_balance,0)::text NOT IN ('NaN','Infinity','-Infinity')
        AND admission_billing.credits_available+coalesce(admission_billing.account_balance,0)>0$predicate$, 2),
    ('public.recheck_requirement_economic_pauses(uuid[])',
      'a66a878c03a8f875b0e6be329aa54e88',
      'SELECT credits_available INTO available FROM public.billing WHERE site_id=r.site_id FOR UPDATE;',
      $read$SELECT CASE WHEN credits_available>=0 AND credits_available::text NOT IN ('NaN','Infinity','-Infinity')
        AND coalesce(account_balance,0)::text NOT IN ('NaN','Infinity','-Infinity')
        THEN credits_available+coalesce(account_balance,0) END INTO available
        FROM public.billing WHERE site_id=r.site_id FOR UPDATE;$read$, 1),
    ('public.inspect_requirement_commands(uuid[],uuid)',
      '4a1cd43f9d2ad13ec3225b39f75ac120',
      'SELECT credits_available INTO available FROM public.billing WHERE site_id=r.site_id;',
      $read$SELECT CASE WHEN credits_available>=0 AND credits_available::text NOT IN ('NaN','Infinity','-Infinity')
        AND coalesce(account_balance,0)::text NOT IN ('NaN','Infinity','-Infinity')
        THEN credits_available+coalesce(account_balance,0) END INTO available
        FROM public.billing WHERE site_id=r.site_id;$read$, 1),
    ('public.register_sandbox_billing(text,text,uuid,uuid)',
      '0ca142342f3a82bb473467eb6770bf48',
      'SELECT credits_available INTO v_available FROM public.billing WHERE site_id=v_site FOR UPDATE;',
      $read$SELECT CASE WHEN credits_available>=0 AND credits_available::text NOT IN ('NaN','Infinity','-Infinity')
        AND coalesce(account_balance,0)::text NOT IN ('NaN','Infinity','-Infinity')
        THEN credits_available+coalesce(account_balance,0) END INTO v_available
        FROM public.billing WHERE site_id=v_site FOR UPDATE;$read$, 1)
  ) AS changes(signature,original_hash,old_fragment,new_fragment,expected_count)
  LOOP
    target:=to_regprocedure(change.signature);
    IF target IS NULL THEN RAISE EXCEPTION 'Missing withdrawable admission dependency: %',change.signature; END IF;
    SELECT prosrc INTO body FROM pg_proc WHERE oid=target;
    restored:=replace(body,change.new_fragment,change.old_fragment);
    IF body IS DISTINCT FROM restored THEN
      occurrences:=(length(body)-length(replace(body,change.new_fragment,'')))/length(change.new_fragment);
      IF occurrences=change.expected_count AND
        md5(regexp_replace(replace(restored,E'\r',''),'^[[:space:]]+|[[:space:]]+$','','g'))=change.original_hash THEN
        CONTINUE; -- Exact installed patch: safe reapplication, no data changes.
      END IF;
    END IF;
    occurrences:=(length(body)-length(replace(body,change.old_fragment,'')))/length(change.old_fragment);
    IF occurrences<>change.expected_count OR
      md5(regexp_replace(replace(body,E'\r',''),'^[[:space:]]+|[[:space:]]+$','','g'))<>change.original_hash THEN
      RAISE EXCEPTION 'Unexpected withdrawable admission definition; review before migration: %',change.signature;
    END IF;
    definition:=pg_get_functiondef(target);
    EXECUTE replace(definition,change.old_fragment,change.new_fragment);
  END LOOP;
END;
$migration$;

-- No candidate renewal or debit is added to scheduler/diagnostic scans. The
-- actual debit still renews under lock, and recovery retains its trusted minimum.
NOTIFY pgrst,'reload schema';
COMMIT;