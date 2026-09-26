-- Repair deployments where instance_context_state and the usage RPC were
-- created without output_tokens. The existing ten-argument RPC refers to this
-- column and cannot save any measurement until it exists.
BEGIN;

ALTER TABLE public.instance_context_state
  ADD COLUMN IF NOT EXISTS output_tokens integer NOT NULL DEFAULT 0;

COMMIT;