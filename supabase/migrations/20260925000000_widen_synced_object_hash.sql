-- Makinari project only (rnjgeloamtszdjplmqxy).
--
-- FNV-1a produces an unsigned 64-bit value (0..18446744073709551615), while
-- PostgreSQL bigint is signed and stops at 9223372036854775807. numeric(20, 0)
-- stores the complete uint64 range exactly and PostgREST accepts decimal strings.
--
-- Existing negative values were previously produced with BigInt.asIntN(64).
-- Adding 2^64 restores their canonical unsigned representation so old and new
-- deduplication lookups use the same value.
--
-- Rollback (only possible after confirming every value fits signed bigint):
-- ALTER TABLE public.synced_objects
--   ALTER COLUMN hash TYPE bigint USING hash::bigint;

BEGIN;

UPDATE public.synced_objects
SET external_id = 'hash-' || (
  hash::numeric + 18446744073709551616::numeric
)::text
WHERE hash < 0
  AND external_id = 'hash-' || hash::text;

ALTER TABLE public.synced_objects
  ALTER COLUMN hash TYPE numeric(20, 0)
  USING CASE
    WHEN hash IS NULL THEN NULL
    WHEN hash < 0 THEN hash::numeric + 18446744073709551616::numeric
    ELSE hash::numeric
  END;

ALTER TABLE public.synced_objects
  DROP CONSTRAINT IF EXISTS synced_objects_hash_uint64_check;

ALTER TABLE public.synced_objects
  ADD CONSTRAINT synced_objects_hash_uint64_check
  CHECK (
    hash IS NULL
    OR hash BETWEEN 0::numeric AND 18446744073709551615::numeric
  ) NOT VALID;

ALTER TABLE public.synced_objects
  VALIDATE CONSTRAINT synced_objects_hash_uint64_check;

COMMENT ON COLUMN public.synced_objects.hash IS
  'Canonical unsigned FNV-1a 64-bit hash stored exactly as numeric(20,0).';

COMMIT;