-- =====================================================================
-- 0007 — public orders (website "Get started" form -> admin approval -> invoice -> pay online)
--
-- Visitors have no login, so they can only call submit_order(). It validates everything,
-- takes prices from the server-side catalogue below (the browser never sends a price),
-- and is rate limited. Staff review the order in Admin -> Orders; approving it creates the
-- client (or attaches to an existing one), the services (pending) and a sent invoice.
-- The client then logs in (admin creates the login) and presses "Pay online".
-- =====================================================================

create table public.orders (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'new' check (status in ('new','approved','rejected')),
  contact_name  text not null check (length(trim(contact_name)) between 1 and 200),
  company_name  text check (length(company_name) <= 200),
  email         text not null check (length(email) <= 320),
  phone         text check (length(phone) <= 40),
  domain        text check (length(domain) <= 253),
  plans         text[] not null check (cardinality(plans) between 1 and 2),
  notes         text check (length(notes) <= 2000),
  client_id     uuid references public.clients(id) on delete set null,
  invoice_id    uuid references public.invoices(id) on delete set null,
  handled_by    uuid references auth.users(id) on delete set null,
  handled_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index orders_status_idx on public.orders (status, created_at desc);

alter table public.orders enable row level security;
create policy orders_staff_select on public.orders for select to authenticated using (private.is_staff());
create policy orders_admin_delete on public.orders for delete to authenticated using (private.is_admin());
grant select on public.orders to authenticated;
grant delete on public.orders to authenticated;       -- admin only, through the policy
create trigger touch_updated_at before update on public.orders
  for each row execute function private.touch_updated_at();

-- ---------- server-side catalogue (the only source of prices) --------
create function private.plan_def(p_key text) returns jsonb
language sql immutable set search_path = pg_temp as $$
  select case p_key
    when 'hosting-monthly'            then '{"type":"hosting","name":"SXI Website Hosting & Care (monthly)","price_cents":1500,"cycle":"monthly","family":"hosting"}'
    when 'hosting-yearly'             then '{"type":"hosting","name":"SXI Website Hosting & Care (yearly)","price_cents":12000,"cycle":"yearly","family":"hosting"}'
    when 'email-starter-monthly'      then '{"type":"business_email","name":"SXI Business Email, Starter, 3 mailboxes (monthly)","price_cents":500,"cycle":"monthly","family":"email"}'
    when 'email-starter-yearly'       then '{"type":"business_email","name":"SXI Business Email, Starter, 3 mailboxes (yearly)","price_cents":5000,"cycle":"yearly","family":"email"}'
    when 'email-business-monthly'     then '{"type":"business_email","name":"SXI Business Email, Business, 5 mailboxes (monthly)","price_cents":800,"cycle":"monthly","family":"email"}'
    when 'email-business-yearly'      then '{"type":"business_email","name":"SXI Business Email, Business, 5 mailboxes (yearly)","price_cents":8000,"cycle":"yearly","family":"email"}'
    when 'email-professional-monthly' then '{"type":"business_email","name":"SXI Business Email, Professional, 20 mailboxes (monthly)","price_cents":2500,"cycle":"monthly","family":"email"}'
    when 'email-professional-yearly'  then '{"type":"business_email","name":"SXI Business Email, Professional, 20 mailboxes (yearly)","price_cents":25000,"cycle":"yearly","family":"email"}'
  end::jsonb
$$;

-- ---------- visitors: submit an order --------------------------------
create function public.submit_order(
  p_contact_name text, p_company_name text, p_email text, p_phone text,
  p_domain text, p_plans text[], p_notes text
) returns jsonb
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_plans text[] := coalesce(p_plans, '{}');
  v_p text; v_fams text[] := '{}'; v_fam text; v_id uuid;
begin
  if length(trim(coalesce(p_contact_name, ''))) not between 1 and 200 then raise exception 'Please enter your name.'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 320 then raise exception 'Please enter a valid email address.'; end if;
  if length(coalesce(p_company_name, '')) > 200 or length(coalesce(p_phone, '')) > 40
     or length(coalesce(p_domain, '')) > 253 or length(coalesce(p_notes, '')) > 2000 then
    raise exception 'One of the fields is too long.';
  end if;
  if cardinality(v_plans) not between 1 and 2 then raise exception 'Please choose a plan.'; end if;
  foreach v_p in array v_plans loop
    if private.plan_def(v_p) is null then raise exception 'Unknown plan.'; end if;
    v_fam := private.plan_def(v_p)->>'family';
    if v_fam = any(v_fams) then raise exception 'Choose one hosting plan and/or one email plan.'; end if;
    v_fams := v_fams || v_fam;
  end loop;

  if not public.rate_limit_hit('order:' || v_email, 3, 3600) or not public.rate_limit_hit('order:all', 200, 3600) then
    raise exception 'Too many requests. Please try again later or message us on WhatsApp.';
  end if;

  insert into public.orders (contact_name, company_name, email, phone, domain, plans, notes)
  values (trim(p_contact_name), nullif(trim(p_company_name), ''), v_email, nullif(trim(p_phone), ''),
          nullif(lower(trim(p_domain)), ''), v_plans, nullif(trim(p_notes), ''))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'reference', upper(left(v_id::text, 8)));
end $$;

-- ---------- staff: approve / reject ----------------------------------
create function public.staff_approve_order(p_order_id uuid, p_client_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  o public.orders; v_client uuid; v_inv uuid; v_p text; d jsonb; v_svc uuid; v_pos int := 0;
begin
  if not private.is_staff() then raise exception 'Not allowed'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'new' then raise exception 'This order was already %', o.status; end if;

  if p_client_id is not null then
    if not exists (select 1 from public.clients where id = p_client_id) then raise exception 'Client not found'; end if;
    v_client := p_client_id;
  else
    insert into public.clients (company_name, contact_name, email, phone)
    values (coalesce(nullif(trim(o.company_name), ''), o.contact_name), o.contact_name, o.email, o.phone)
    returning id into v_client;
  end if;

  insert into public.invoices (client_id, currency, due_date, notes, created_by)
  values (v_client, 'USD', current_date + 7, 'Order ' || upper(left(o.id::text, 8)), auth.uid())
  returning id into v_inv;

  foreach v_p in array o.plans loop
    d := private.plan_def(v_p);
    -- renewal_date = today and invoiced_for = today: this order's invoice IS the first period.
    -- Paying it moves the renewal a cycle on and activates the service (trigger below).
    insert into public.services (client_id, type, name, status, price_cents, currency, billing_cycle, start_date, renewal_date, invoiced_for)
    values (v_client, (d->>'type')::public.service_type, d->>'name', 'pending', (d->>'price_cents')::bigint, 'USD',
            (d->>'cycle')::public.billing_cycle, current_date, current_date, current_date)
    returning id into v_svc;
    insert into public.invoice_items (invoice_id, service_id, description, quantity, unit_price_cents, position)
    values (v_inv, v_svc, d->>'name', 1, (d->>'price_cents')::bigint, v_pos);
    v_pos := v_pos + 1;
  end loop;
  update public.invoices set status = 'sent' where id = v_inv;

  update public.orders set status = 'approved', client_id = v_client, invoice_id = v_inv, handled_by = auth.uid(), handled_at = now()
  where id = o.id;
  return jsonb_build_object('client_id', v_client, 'invoice_id', v_inv);
end $$;

create function public.staff_reject_order(p_order_id uuid) returns void
language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if not private.is_staff() then raise exception 'Not allowed'; end if;
  update public.orders set status = 'rejected', handled_by = auth.uid(), handled_at = now()
  where id = p_order_id and status = 'new';
  if not found then raise exception 'Order not found or already handled'; end if;
end $$;

-- ---------- paying an invoice activates the pending services on it ----
create function private.invoice_paid_activate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.services set status = 'active'
  where status = 'pending' and id in (select service_id from public.invoice_items where invoice_id = new.id and service_id is not null);
  return null;
end $$;
create trigger invoice_paid_activate after update of status on public.invoices
  for each row when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function private.invoice_paid_activate();

-- ---------- permissions ----------------------------------------------
revoke all on function private.plan_def(text), private.invoice_paid_activate() from public, anon, authenticated;
revoke all on function public.submit_order(text, text, text, text, text, text[], text),
  public.staff_approve_order(uuid, uuid), public.staff_reject_order(uuid) from public, anon, authenticated;
grant execute on function public.submit_order(text, text, text, text, text, text[], text) to anon, authenticated;
grant execute on function public.staff_approve_order(uuid, uuid), public.staff_reject_order(uuid) to authenticated;
