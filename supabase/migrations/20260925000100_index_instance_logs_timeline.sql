-- Makinari project only (rnjgeloamtszdjplmqxy).
--
-- This migration must run outside a transaction because PostgreSQL forbids
-- CREATE INDEX CONCURRENTLY inside a transaction block.
--
-- Rollback:
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_instance_logs_instance_created_at;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_instance_logs_instance_created_at
  ON public.instance_logs (instance_id, created_at DESC);