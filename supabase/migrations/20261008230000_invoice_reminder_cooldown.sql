-- Add progressive per-invoice cooldown without modifying the existing atomic claim.
begin;
create function public.claim_invoice_reminder_with_cooldown(p_site_id uuid, p_sale_id uuid, p_reminder_key text,
  p_local_day date, p_interval_days integer, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sale public.sales%rowtype;
  v_receipt public.invoice_reminders%rowtype;
  v_last_sent timestamptz;
  v_sent_count bigint;
  v_days integer;
begin
  if p_mode is null or p_mode not in ('progressive', 'fixed')
    or p_interval_days is null or p_interval_days < 1 or p_interval_days > 365
    or p_local_day is null or not isfinite(p_local_day) or p_local_day < date '0001-01-01' or p_local_day > date '9999-12-31'
    or p_reminder_key is null or length(p_reminder_key) not between 1 and 200 then
    raise exception 'Invalid invoice reminder claim';
  end if;
  -- Serialize competing keys and changing cadences for the same invoice.
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
    and reminder_key = p_reminder_key) then return jsonb_build_object('reason', 'repeat_interval'); end if;
  select count(*), max(sent_at) into v_sent_count, v_last_sent from public.invoice_reminders
    where site_id = p_site_id and sale_id = p_sale_id and state = 'sent';
  if v_sent_count > 0 then
    v_days := case when p_mode = 'fixed' then p_interval_days
      else case when v_sent_count <= 2 then 1 when v_sent_count = 3 then 3
        when v_sent_count = 4 then 7 else 14 end end;
    if v_last_sent is null or v_last_sent > now() - make_interval(days => v_days) then
      return jsonb_build_object('reason', 'repeat_interval');
    end if;
  end if;
  insert into public.invoice_reminders(site_id, sale_id, reminder_key)
    values (p_site_id, p_sale_id, p_reminder_key) returning * into v_receipt;
  return jsonb_build_object('claimed', true, 'reminder', to_jsonb(v_receipt));
end;
$$;
revoke all on function public.claim_invoice_reminder_with_cooldown(uuid, uuid, text, date, integer, text) from public, anon, authenticated;
grant execute on function public.claim_invoice_reminder_with_cooldown(uuid, uuid, text, date, integer, text) to service_role;
notify pgrst, 'reload schema';
commit;