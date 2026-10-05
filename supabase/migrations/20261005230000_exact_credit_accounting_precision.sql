BEGIN;
SET LOCAL lock_timeout = '5s';

-- Classified buckets and RPC arguments are unconstrained numeric. The legacy
-- numeric(10,4) aggregate rounds before the exact bucket CHECK (including when
-- the guard trigger recomputes it), and usage/ledger rounding loses conservation.
-- Removing only those typmods preserves every stored value, default, CHECK,
-- trigger, RPC, ACL and RLS policy. No balances are reset or rounded.
ALTER TABLE public.billing
  ALTER COLUMN credits_available TYPE numeric,
  ALTER COLUMN credits_used TYPE numeric;
ALTER TABLE public.credit_transactions
  ALTER COLUMN amount TYPE numeric;

-- Warm pooled sessions can retain the old NEW-record typmod in the guard's
-- compiled assignment even after ALTER TABLE. Reassert its EXISTING search_path
-- to invalidate that cached function without changing its body, ACL or security.
ALTER FUNCTION public.guard_billing_credit_buckets()
  SET search_path = public, pg_temp;

-- account_balance is already unconstrained numeric. payments.amount is monetary
-- numeric(10,2) and payments.credits is an integer purchase/invoice entitlement;
-- neither is the fractional usage ledger, so their contracts stay unchanged.
NOTIFY pgrst, 'reload schema';
COMMIT;