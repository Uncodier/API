-- Rollback:
--   drop policy if exists "workspaces service only" on storage.objects;
--   delete from storage.buckets where id = 'workspaces';
-- Only run the bucket deletion when its objects have already been preserved.

insert into storage.buckets (id, name, public)
values ('workspaces', 'workspaces', false)
on conflict (id) do update
set public = false;

drop policy if exists "workspaces public read" on storage.objects;
drop policy if exists "workspaces authenticated read" on storage.objects;
drop policy if exists "workspaces authenticated write" on storage.objects;

drop policy if exists "workspaces service only" on storage.objects;
create policy "workspaces service only"
  on storage.objects
  for all
  using (bucket_id = 'workspaces' and auth.role() = 'service_role')
  with check (bucket_id = 'workspaces' and auth.role() = 'service_role');
