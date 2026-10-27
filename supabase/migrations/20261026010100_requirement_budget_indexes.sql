-- Transaction-safe: this entire file can run in a migration or SQL Editor batch.
-- No table rewrite, but index builds block writes until the transaction completes.
-- Use a maintenance window. For online rollout, prebuild these same indexes with
-- CREATE INDEX CONCURRENTLY, one statement per autocommit request, then apply this
-- migration (IF NOT EXISTS skips existing indexes). Verify their validity first;
-- IF NOT EXISTS does not repair an invalid index left by a failed concurrent build.
-- These indexes bound cycle reads to the requirement's own history, not the site.
CREATE INDEX IF NOT EXISTS harness_model_requirement_cost_idx
  ON public.harness_model_credit_reservations (site_id, requirement_id)
  INCLUDE (state, charged);

CREATE INDEX IF NOT EXISTS credit_transactions_requirement_cost_idx
  ON public.credit_transactions (site_id, (metadata->>'requirement_id'))
  INCLUDE (amount)
  WHERE transaction_type NOT IN ('sandbox_usage','agent_model_reservation',
    'agent_model_refund','agent_model_refund_expired','agent_model_settlement','agent_model_actual_cost');

CREATE INDEX IF NOT EXISTS credit_transactions_session_cost_idx
  ON public.credit_transactions (site_id, (metadata->>'session_id'))
  WHERE transaction_type NOT IN ('sandbox_usage','agent_model_reservation',
    'agent_model_refund','agent_model_refund_expired','agent_model_settlement','agent_model_actual_cost');

CREATE INDEX IF NOT EXISTS harness_sessions_requirement_cost_idx
  ON public.harness_sessions (site_id, (snapshot#>>'{request,requirementId}')) INCLUDE (id);

CREATE INDEX IF NOT EXISTS sandbox_resources_requirement_cost_idx
  ON public.sandbox_billing_resources (site_id, owner_id) INCLUDE (sandbox_name)
  WHERE owner_kind='requirement';

CREATE INDEX IF NOT EXISTS sandbox_sessions_resource_cost_idx
  ON public.sandbox_billing_sessions (sandbox_name) INCLUDE (credits_charged);