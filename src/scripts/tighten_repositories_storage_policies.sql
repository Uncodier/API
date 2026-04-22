-- =====================================================================
-- Repositories storage hygiene — runs on the Apps Supabase project.
--
-- Goal: keep the legacy `workspaces` bucket reachable ONLY by service-role
-- callers (Uncodie API uploads tarballs / screenshots). Anonymous reads
-- and authenticated tenant JWTs MUST NOT see workspaces. New per-tenant
-- buckets follow `tenant-<requirementId-no-dashes>` naming with policies
-- that match `auth.jwt()->>'tenant_id'`.
-- =====================================================================

-- Workspaces bucket: service-role-only. Drop legacy permissive rules.
drop policy if exists "workspaces public read" on storage.objects;
drop policy if exists "workspaces authenticated read" on storage.objects;
drop policy if exists "workspaces authenticated write" on storage.objects;

drop policy if exists "workspaces service only" on storage.objects;
create policy "workspaces service only"
  on storage.objects
  for all
  using (bucket_id = 'workspaces' and auth.role() = 'service_role')
  with check (bucket_id = 'workspaces' and auth.role() = 'service_role');

-- Tenant buckets template. Apply per-bucket via tenant-provisioner.
-- For each tenant bucket `tenant-<tid>`, four policies are needed.
-- Example DDL emitted by ensureTenant (kept here as documentation):
--
-- create policy "tenant_<tid>_read" on storage.objects
--   for select using (
--     bucket_id = 'tenant-<tid>'
--     and auth.jwt()->>'tenant_id' = '<tenant_uuid>'
--   );
-- create policy "tenant_<tid>_insert" on storage.objects
--   for insert with check (
--     bucket_id = 'tenant-<tid>'
--     and auth.jwt()->>'tenant_id' = '<tenant_uuid>'
--   );
-- create policy "tenant_<tid>_update" on storage.objects
--   for update using (
--     bucket_id = 'tenant-<tid>'
--     and auth.jwt()->>'tenant_id' = '<tenant_uuid>'
--   );
-- create policy "tenant_<tid>_delete" on storage.objects
--   for delete using (
--     bucket_id = 'tenant-<tid>'
--     and auth.jwt()->>'tenant_id' = '<tenant_uuid>'
--   );
