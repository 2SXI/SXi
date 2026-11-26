-- =====================================================================
-- 0006 — recurring invoices, hosting renewal sync, mailbox limits
--
-- 1. Recurring services get a DRAFT invoice generated shortly before they renew
--    (optionally sent automatically). One invoice per client + currency, one line per service.
-- 2. A service can be linked to a hosting account; its renewal_date is then copied onto the
--    hosting account, so the renewal reminders always use the date that was actually paid for.
-- 3. A hosting account's email_accounts_limit is enforced on mailboxes linked to it.
-- =====================================================================

-- ---------- columns ---------------------------------------------------
alter table public.services
  add column auto_invoice       boolean not null default true,
  add column invoiced_for       date,            -- the renewal_date an invoice was last generated for
  add column hosting_account_id uuid references public.hosting_accounts(id) on delete set null;
create index services_hosting_idx on public.services (hosting_account_id);
create index services_autoinvoice_idx on public.services (renewal_date) where status = 'active' and auto_invoice;

alter table public.email_accounts
  add column hosting_account_id uuid references public.hosting_accounts(id) on delete set null;
create index email_hosting_idx on public.email_accounts (hosting_account_id);

-- settings (admin-editable through the existing settings policy)
insert into public.settings (key, value) values
  ('billing.invoice_lead_days', '14'::jsonb),     -- generate this many days before renewal
  ('billing.auto_send',         'false'::jsonb)   -- true = generated invoices are sent, not left as drafts
on conflict (key) do nothing;

-- ---------- 2. service <-> hosting account ---------------------------
create function private.service_hosting_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.hosting_account_id is not null then
    if new.type <> 'hosting' then
      raise exception 'Only a hosting service can be linked to a hosting account';
    end if;
    if not exists (select 1 from public.hosting_accounts h
                   where h.id = new.hosting_account_id and h.client_id = new.client_id) then
      raise exception 'That hosting account belongs to a different client';
    end if;
  end if;
  return new;
end $$;
create trigger service_hosting_guard before insert or update of hosting_account_id, client_id, type on public.services
  for each row execute function private.service_hosting_guard();

create function private.service_sync_hosting() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.hosting_account_id is not null and new.renewal_date is not null then
    update public.hosting_accounts set renewal_date = new.renewal_date
    where id = new.hosting_account_id and renewal_date is distinct from new.renewal_date;
  end if;
  return null;
end $$;
create trigger service_sync_hosting after insert or update of renewal_date, hosting_account_id on public.services
  for each row execute function private.service_sync_hosting();

-- ---------- 3. mailbox limit -----------------------------------------
create function private.mailbox_limit_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_limit int; v_client uuid; v_used int;
begin
  if new.hosting_account_id is null or new.status = 'deleted' then return new; end if;
  select email_accounts_limit, client_id into v_limit, v_client
  from public.hosting_accounts where id = new.hosting_account_id for update;
  if not found or v_client <> new.client_id then
    raise exception 'That hosting account belongs to a different client';
  end if;
  if v_limit is null then return new; end if;
  select count(*) into v_used from public.email_accounts
  where hosting_account_id = new.hosting_account_id and status <> 'deleted' and id <> new.id;
  if v_used >= v_limit then
    raise exception 'Mailbox limit reached: this hosting plan allows % mailbox(es)', v_limit;
  end if;
  return new;
end $$;
create trigger mailbox_limit_guard before insert or update of status, hosting_account_id on public.email_accounts
  for each row execute function private.mailbox_limit_guard();

-- ---------- 1. recurring invoice generation --------------------------
-- Idempotent: a service is invoiced once per renewal_date (services.invoiced_for).
-- Paying the invoice moves renewal_date forward, which makes the service eligible again next cycle.
create function private.generate_renewal_invoices() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead int := coalesce((select (value #>> '{}')::int from public.settings where key = 'billing.invoice_lead_days'), 14);
  v_send boolean := coalesce((select (value #>> '{}')::boolean from public.settings where key = 'billing.auto_send'), false);
  g record; s record; v_inv uuid; v_pos int; v_made int := 0; v_lines int := 0; v_due date; v_label text;
begin
  perform set_config('app.invoice_paid_ok', '', true);
  for g in
    select client_id, currency, min(renewal_date) as first_renewal
    from public.services
    where status = 'active' and auto_invoice and billing_cycle <> 'one_time'
      and price_cents > 0 and renewal_date is not null
      and renewal_date <= current_date + v_lead
      and invoiced_for is distinct from renewal_date
    group by client_id, currency
  loop
    v_due := greatest(g.first_renewal, current_date);
    insert into public.invoices (client_id, currency, issue_date, due_date, notes)
    values (g.client_id, g.currency, current_date, v_due, 'Automatically generated renewal invoice')
    returning id into v_inv;
    v_pos := 0;
    for s in
      select * from public.services
      where client_id = g.client_id and currency = g.currency
        and status = 'active' and auto_invoice and billing_cycle <> 'one_time'
        and price_cents > 0 and renewal_date is not null
        and renewal_date <= current_date + v_lead
        and invoiced_for is distinct from renewal_date
      order by renewal_date, name
    loop
      v_label := case s.billing_cycle when 'monthly' then 'month' when 'quarterly' then 'quarter' else 'year' end;
      insert into public.invoice_items (invoice_id, service_id, description, quantity, unit_price_cents, position)
      values (v_inv, s.id, s.name || ' — renewal from ' || to_char(s.renewal_date, 'DD Mon YYYY') || ' (1 ' || v_label || ')',
              1, s.price_cents, v_pos);
      update public.services set invoiced_for = s.renewal_date where id = s.id;
      v_pos := v_pos + 1; v_lines := v_lines + 1;
    end loop;
    if v_send then update public.invoices set status = 'sent' where id = v_inv; end if;
    v_made := v_made + 1;
  end loop;
  return jsonb_build_object('renewal_invoices_created', v_made, 'renewal_lines', v_lines, 'auto_sent', v_send);
end $$;

-- Admin button: "Generate renewal invoices now"
create function public.admin_generate_renewal_invoices() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not private.is_admin() then raise exception 'Not allowed'; end if;
  return private.generate_renewal_invoices();
end $$;

-- the daily job now also generates renewal invoices (the cron command from the README is unchanged)
alter function public.run_daily_maintenance() rename to run_daily_maintenance_base;
alter function public.run_daily_maintenance_base() set schema private;
create function public.run_daily_maintenance() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a jsonb; b jsonb;
begin
  b := private.generate_renewal_invoices();   -- first, so freshly sent invoices are in the same run's reminders
  a := private.run_daily_maintenance_base();
  return a || b;
end $$;

-- ---------- permissions ----------------------------------------------
revoke all on function private.generate_renewal_invoices(), private.run_daily_maintenance_base() from public, anon, authenticated;
revoke all on function public.run_daily_maintenance(), public.admin_generate_renewal_invoices() from public, anon, authenticated;
grant execute on function public.run_daily_maintenance() to service_role;
grant execute on function public.admin_generate_renewal_invoices() to authenticated;
