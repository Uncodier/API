-- Rollback:
--   alter table public.requirements drop column if exists backlog_revision;

alter table if exists public.requirements
  add column if not exists backlog_revision bigint not null default 0;

comment on column public.requirements.backlog_revision is
  'Optimistic concurrency token incremented on every requirements.backlog mutation.';
