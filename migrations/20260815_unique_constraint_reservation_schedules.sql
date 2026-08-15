-- Migration to add unique constraint to reservation_schedules
-- This is required for the upsert (ON CONFLICT) operation to work correctly
-- when updating a service's reservation schedule.

ALTER TABLE public.reservation_schedules
  ADD CONSTRAINT reservation_schedules_catalog_item_id_key UNIQUE (catalog_item_id);
