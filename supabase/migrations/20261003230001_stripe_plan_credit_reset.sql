BEGIN;
SET LOCAL lock_timeout = '5s';

-- Forward replacement of the verified invoice RPC. Invoice identity still owns
-- payment/settlement effects; the period helper owns the non-accumulating bucket.
-- Existing completed invoices without a settlement marker remain fail-closed.
CREATE OR REPLACE FUNCTION public.settle_stripe_subscription_invoice(p_invoice jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_site uuid := (p_invoice->>'site_id')::uuid;
  v_invoice text := p_invoice->>'invoice_id';
  v_customer text := p_invoice->>'customer_id';
  v_subscription text := p_invoice->>'subscription_id';
  v_status text := p_invoice->>'status';
  v_amount numeric := (p_invoice->>'amount')::numeric;
  v_currency text := p_invoice->>'currency';
  v_plan text := p_invoice->>'plan';
  v_addons integer := (p_invoice->>'addons_count')::integer;
  v_reason text := p_invoice->>'billing_reason';
  v_current_status text := lower(nullif(p_invoice->>'current_subscription_status', ''));
  v_period_start timestamptz := nullif(p_invoice->>'period_start', '')::timestamptz;
  v_period_end timestamptz := nullif(p_invoice->>'period_end', '')::timestamptz;
  v_paid_at timestamptz := nullif(p_invoice->>'paid_at', '')::timestamptz;
  v_credits integer := 0;
  v_reset jsonb;
  v_credit_outcome text := 'not_eligible';
  v_billing public.billing%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_settlement public.stripe_subscription_invoice_settlements%ROWTYPE;
  v_details jsonb;
BEGIN
  IF jsonb_typeof(p_invoice) IS DISTINCT FROM 'object'
    OR v_site IS NULL OR v_invoice IS NULL OR v_invoice !~ '^in_[A-Za-z0-9]+$'
    OR v_customer IS NULL OR v_customer !~ '^cus_[A-Za-z0-9]+$'
    OR v_subscription IS NULL OR v_subscription !~ '^sub_[A-Za-z0-9]+$'
    OR v_status IS NULL OR v_status NOT IN ('paid', 'failed')
    OR v_amount IS NULL OR v_amount < 0 OR v_amount::text IN ('NaN', 'Infinity', '-Infinity')
    OR v_currency IS NULL OR v_currency !~ '^[A-Z]{3}$'
    OR v_plan IS NULL OR v_plan NOT IN ('engine', 'foundry', 'enterprise')
    OR v_addons IS NULL OR v_addons < 0 OR v_addons > 100
    OR v_reason IS NULL
    OR (v_current_status IS NOT NULL AND v_current_status NOT IN
      ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused', 'canceled', 'cancelled', 'incomplete_expired'))
    OR (v_status = 'paid' AND (v_paid_at IS NULL OR NOT isfinite(v_paid_at)))
    OR ((v_period_start IS NULL) <> (v_period_end IS NULL))
    OR (v_period_start IS NOT NULL AND (NOT isfinite(v_period_start)
      OR NOT isfinite(v_period_end) OR v_period_end <= v_period_start))
    OR (v_reason IN ('subscription_create', 'subscription_cycle') AND v_period_start IS NULL)
    OR (v_status = 'paid' AND v_reason IN ('subscription_create', 'subscription_cycle')
      AND v_period_start > now())
  THEN RAISE EXCEPTION 'Invalid verified Stripe invoice'; END IF;

  -- Same invoice on different sites must serialize before tenant validation.
  PERFORM pg_advisory_xact_lock(hashtextextended('stripe-invoice:' || v_invoice, 0));
  SELECT * INTO v_billing FROM public.billing WHERE site_id = v_site FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice site has no billing record'; END IF;
  IF v_billing.stripe_customer_id IS DISTINCT FROM v_customer
    OR (v_billing.stripe_subscription_id IS NOT NULL
      AND v_billing.stripe_subscription_id <> v_subscription)
  THEN RAISE EXCEPTION 'Stripe invoice billing identity mismatch'; END IF;

  SELECT * INTO v_payment FROM public.payments
    WHERE transaction_id = 'stripe_invoice_' || v_invoice FOR UPDATE;
  IF FOUND AND (v_payment.site_id <> v_site OR v_payment.transaction_type <> 'subscription')
  THEN RAISE EXCEPTION 'Stripe invoice payment identity mismatch'; END IF;

  SELECT * INTO v_settlement FROM public.stripe_subscription_invoice_settlements
    WHERE invoice_id = v_invoice;
  IF FOUND THEN
    IF v_settlement.site_id <> v_site OR v_settlement.customer_id <> v_customer
      OR v_settlement.subscription_id <> v_subscription
      OR (v_status = 'paid' AND (v_settlement.amount <> v_amount OR v_settlement.currency <> v_currency))
    THEN RAISE EXCEPTION 'Stripe invoice settlement identity mismatch'; END IF;
  END IF;

  -- The app also verifies the subscription's current status. A missed deletion
  -- webhook must not leave stale active DB state eligible for a paid reset.
  -- Synchronize only authoritative terminal status, never revive a terminated
  -- subscription from a historical/nonterminal snapshot. The core guard grants
  -- the commission fallback once and preserves all protected balances.
  IF v_current_status IN ('canceled', 'cancelled', 'incomplete_expired')
    AND v_billing.subscription_status IS DISTINCT FROM v_current_status THEN
    UPDATE public.billing SET subscription_status = v_current_status, updated_at = now()
      WHERE id = v_billing.id RETURNING * INTO v_billing;
  END IF;
  IF v_settlement.invoice_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', CASE WHEN v_status = 'paid' THEN 'duplicate' ELSE 'ignored_failure' END,
      'payment_id', v_settlement.payment_id, 'credits_granted', 0);
  END IF;

  IF v_status = 'failed' AND v_payment.status IS NOT NULL AND v_payment.status <> 'failed' THEN
    RETURN jsonb_build_object('outcome', 'ignored_failure', 'payment_id', v_payment.id, 'credits_granted', 0);
  END IF;
  IF v_status = 'paid' AND v_payment.status IS NOT NULL AND v_payment.status <> 'failed' THEN
    RAISE EXCEPTION 'Legacy completed invoice requires credit reconciliation';
  END IF;
  IF v_status = 'paid' AND EXISTS (
    SELECT 1 FROM public.credit_transactions
    WHERE site_id = v_site AND metadata->>'stripe_invoice_id' = v_invoice AND amount > 0
  ) THEN RAISE EXCEPTION 'Invoice already has historical credits; reconciliation required'; END IF;
  IF v_status = 'paid' AND v_reason = 'subscription_create' AND EXISTS (
    SELECT 1 FROM public.payments WHERE site_id = v_site AND status = 'completed'
      AND transaction_type = 'subscription' AND details->>'stripe_subscription_id' = v_subscription
      AND details ? 'stripe_session_id'
  ) THEN RAISE EXCEPTION 'Legacy subscription checkout requires credit reconciliation'; END IF;

  IF v_status = 'paid' AND v_reason IN ('subscription_create', 'subscription_cycle') THEN
    IF lower(coalesce(v_billing.subscription_status, '')) IN ('canceled', 'cancelled', 'incomplete_expired') THEN
      -- Historical payment is still auditable, but must never resurrect paid
      -- entitlement after the current subscription has terminated.
      v_credit_outcome := 'terminal_subscription';
    ELSIF coalesce(v_billing.status, '') <> 'active' OR EXISTS (
      SELECT 1 FROM public.sites WHERE id = v_site AND archived_at IS NOT NULL
    ) THEN
      v_credit_outcome := 'inactive';
    ELSIF v_period_end <= now() THEN
      -- Do not retry an already expired historical invoice forever. Record it
      -- without a grant rather than asking the current-period helper to reject it.
      v_credit_outcome := 'stale_period';
    ELSE
      v_reset := public.reset_site_plan_credit_period(v_site, v_period_start, v_period_end,
        public.site_plan_credit_allowance(v_plan, v_addons), 'stripe_invoice:' || v_invoice);
      IF (v_reset->>'success')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Stripe plan credit reset failed';
      END IF;
      v_credits := (v_reset->>'credits_granted')::integer;
      v_credit_outcome := v_reset->>'outcome';
    END IF;
  END IF;

  v_details := jsonb_strip_nulls(jsonb_build_object(
    'stripe_invoice_id', v_invoice, 'stripe_subscription_id', v_subscription,
    'stripe_customer_id', v_customer, 'stripe_payment_intent_id', p_invoice->>'payment_intent_id',
    'billing_reason', v_reason, 'plan', v_plan, 'addons_count', v_addons,
    'stripe_event_id', p_invoice->>'event_id', 'paid_at', p_invoice->>'paid_at',
    'period_start', v_period_start, 'period_end', v_period_end,
    'credit_bucket', 'plan', 'credit_outcome', v_credit_outcome
  ));
  IF v_payment.id IS NULL THEN
    INSERT INTO public.payments(site_id, transaction_id, transaction_type, amount, currency,
      status, payment_method, details, credits, invoice_url)
    VALUES (v_site, 'stripe_invoice_' || v_invoice, 'subscription', v_amount, v_currency,
      CASE WHEN v_status = 'paid' THEN 'completed' ELSE 'failed' END, 'stripe', v_details,
      v_credits, p_invoice->>'invoice_url') RETURNING * INTO v_payment;
  ELSE
    UPDATE public.payments SET amount = v_amount, currency = v_currency,
      status = CASE WHEN v_status = 'paid' THEN 'completed' ELSE 'failed' END,
      details = coalesce(details, '{}'::jsonb) || v_details,
      credits = v_credits, invoice_url = coalesce(p_invoice->>'invoice_url', invoice_url), updated_at = now()
    WHERE id = v_payment.id;
  END IF;
  IF v_status = 'failed' THEN
    RETURN jsonb_build_object('outcome', 'failed_recorded', 'payment_id', v_payment.id, 'credits_granted', 0);
  END IF;

  INSERT INTO public.stripe_subscription_invoice_settlements(invoice_id, site_id, payment_id,
    customer_id, subscription_id, amount, currency, credits_granted, event_id)
  VALUES (v_invoice, v_site, v_payment.id, v_customer, v_subscription, v_amount, v_currency,
    v_credits, p_invoice->>'event_id');
  -- The helper wrote the plan reset ledger atomically. Never also append an
  -- additive subscription grant or change purchased/legacy/account_balance.
  RETURN jsonb_build_object('outcome', 'settled', 'payment_id', v_payment.id, 'credits_granted', v_credits);
END;
$$;
REVOKE ALL ON FUNCTION public.settle_stripe_subscription_invoice(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_stripe_subscription_invoice(jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;