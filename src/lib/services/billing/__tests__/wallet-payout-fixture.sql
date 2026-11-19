-- Offline snapshot of the live payout debit, not a replacement/mock UPDATE.
-- Source: market-fit/supabase/migrations/20260917190000_payout_security_hardening.sql
-- Function lines 56-85 and its REVOKE/GRANT lines 115-116,119, unchanged.
-- Kept locally so tests do not require a sibling checkout or database access.
CREATE OR REPLACE FUNCTION public.deduct_balance(
  p_site_id uuid,
  p_amount numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  UPDATE public.billing
  SET account_balance = account_balance - p_amount,
      updated_at = now()
  WHERE site_id = p_site_id
    AND coalesce(account_balance, 0) >= p_amount
  RETURNING account_balance INTO v_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing record not found or insufficient balance';
  END IF;

  RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.deduct_balance(uuid, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_balance(uuid, numeric) TO service_role;