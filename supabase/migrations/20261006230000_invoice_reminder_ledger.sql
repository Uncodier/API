-- Forward-only, service-owned collection reminder receipts. Apply after
-- 20261006210000_financial_due_dates.sql. No existing financial rows are changed.
begin;
create table public.invoice_reminders (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  reminder_key text not null check (length(reminder_key) between 1 and 200),
  state text not null default 'generating' check (state in ('generating', 'ready', 'sent', 'uncertain', 'cancelled')),
  message_id uuid references public.messages(id),
  command_id text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (site_id, sale_id, reminder_key)
);
create index invoice_reminders_sale_receipts on public.invoice_reminders(site_id, sale_id, created_at desc);
alter table public.invoice_reminders enable row level security;
revoke all on public.invoice_reminders from public, anon, authenticated;
grant all on public.invoice_reminders to service_role;

-- The sale row serializes claims across different caller keys/days. Uncertain
-- generation/delivery is never automatically retried with a new message.
create function public.claim_invoice_reminder(p_site_id uuid, p_sale_id uuid, p_reminder_key text,
  p_local_day date, p_interval_days integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sale public.sales%rowtype;
  v_receipt public.invoice_reminders%rowtype;
begin
  if p_interval_days is null or p_interval_days < 1 or p_interval_days > 365
    or p_local_day is null or not isfinite(p_local_day) or p_local_day < date '0001-01-01' or p_local_day > date '9999-12-31'
    or p_reminder_key is null or length(p_reminder_key) not between 1 and 200 then
    raise exception 'Invalid invoice reminder claim';
  end if;
  select * into v_sale from public.sales where id = p_sale_id and site_id = p_site_id for update;
  if not found then return jsonb_build_object('reason', 'sale_not_found'); end if;
  if v_sale.status is distinct from 'pending' or v_sale.amount_due is null or v_sale.amount_due <= 0
    or v_sale.amount_due::text in ('NaN', 'Infinity', '-Infinity')
    or v_sale.due_date is null or not isfinite(v_sale.due_date) or v_sale.due_date < date '0001-01-01'
    or v_sale.due_date > p_local_day then
    return jsonb_build_object('reason', 'invoice_not_due');
  end if;
  select * into v_receipt from public.invoice_reminders
    where site_id = p_site_id and sale_id = p_sale_id and state in ('generating', 'ready', 'uncertain')
    order by created_at desc limit 1;
  if found then
    return jsonb_build_object('reason', case when v_receipt.state = 'ready' then 'ready' else 'reminder_uncertain' end,
      'reminder', to_jsonb(v_receipt));
  end if;
  if exists (select 1 from public.invoice_reminders where site_id = p_site_id and sale_id = p_sale_id
    and (reminder_key = p_reminder_key or sent_at > now() - make_interval(days => p_interval_days))) then
    return jsonb_build_object('reason', 'repeat_interval');
  end if;
  insert into public.invoice_reminders(site_id, sale_id, reminder_key)
    values (p_site_id, p_sale_id, p_reminder_key) returning * into v_receipt;
  return jsonb_build_object('claimed', true, 'reminder', to_jsonb(v_receipt));
end;
$$;
revoke all on function public.claim_invoice_reminder(uuid, uuid, text, date, integer) from public, anon, authenticated;
grant execute on function public.claim_invoice_reminder(uuid, uuid, text, date, integer) to service_role;

-- Cancel only messages proven not to have entered transport. Taking the message
-- lock and changing custom_data invalidates a concurrent delivery CAS claim.
create function public.cancel_stale_invoice_reminder(p_site_id uuid, p_sale_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sale public.sales%rowtype;
  v_receipt public.invoice_reminders%rowtype;
  v_message public.messages%rowtype;
begin
  select * into v_sale from public.sales where id = p_sale_id and site_id = p_site_id for update;
  if not found then return false; end if;
  select * into v_receipt from public.invoice_reminders where site_id = p_site_id and sale_id = p_sale_id
    and state = 'ready' order by created_at desc limit 1 for update;
  if not found or v_receipt.sent_at is not null or v_receipt.provider_message_id is not null then return false; end if;
  select * into v_message from public.messages where id = v_receipt.message_id for update;
  if not found or (v_message.custom_data ? 'outreach_delivery'
      and v_message.custom_data->'outreach_delivery'->>'state' is distinct from 'blocked')
    or coalesce(v_message.custom_data->>'status', '') = 'sent'
    or v_message.custom_data->'delivery'->>'success' = 'true'
    or (v_message.custom_data->'outreach_delivery') ?| array['sent_at', 'provider_message_id', 'provider_call_id']
    or v_message.custom_data ?| array['sent_at', 'provider_message_id', 'provider_call_id', 'external_message_id'] then return false; end if;
  if v_sale.status = 'pending' and v_sale.amount_due > 0
    and v_sale.due_date::text is not distinct from v_message.custom_data->>'invoice_due_date'
    and v_sale.amount_due::numeric is not distinct from (v_message.custom_data->>'invoice_amount_due')::numeric
    and v_sale.currency is not distinct from v_message.custom_data->>'invoice_currency' then return false; end if;
  update public.messages set custom_data = coalesce(custom_data, '{}'::jsonb) || '{"status":"cancelled","invoice_cancelled":true}'::jsonb
    where id = v_message.id;
  update public.invoice_reminders set state = 'cancelled' where id = v_receipt.id;
  return true;
end;
$$;
revoke all on function public.cancel_stale_invoice_reminder(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_stale_invoice_reminder(uuid, uuid) to service_role;
notify pgrst, 'reload schema';
commit;