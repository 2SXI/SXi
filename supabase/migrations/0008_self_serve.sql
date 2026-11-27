-- =====================================================================
-- 0008 — self-serve sign-up: a visitor creates an account, confirms their email, and lands on
--         their first invoice with "Pay online". No staff step.
--
-- Safety rules this migration enforces:
--  * Nothing is created until the email address is CONFIRMED (auth.users.email_confirmed_at).
--  * A self-serve sign-up always gets a brand-new client. It is never attached to an existing
--    client (that would let anyone who knows a client's email read their records). If the email
--    matches an existing client, the order is flagged for staff to review.
--  * Plans come from sign-up metadata but are validated against the server-side catalogue; role,
--    client_id and prices in metadata are ignored.
--  * One claim per login: only a client profile with no client yet can claim, once.
-- =====================================================================

alter table public.orders add column source text not null default 'request' check (source in ('request', 'signup'));

-- ---------- shared builder: services (pending) + a sent invoice -------
create function private.fulfil_plans(p_client uuid, p_plans text[], p_note text, p_actor uuid) returns uuid
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare v_inv uuid; v_p text; d jsonb; v_svc uuid; v_pos int := 0;
begin
  insert into public.invoices (client_id, currency, due_date, notes, created_by)
  values (p_client, 'USD', current_date + 7, p_note, p_actor) returning id into v_inv;
  foreach v_p in array p_plans loop
    d := private.plan_def(v_p);
    -- renewal_date = invoiced_for = today: this invoice IS the first period. Paying it moves the
    -- renewal a cycle on and activates the service (invoice_paid_activate).
    insert into public.services (client_id, type, name, status, price_cents, currency, billing_cycle, start_date, renewal_date, invoiced_for)
    values (p_client, (d->>'type')::public.service_type, d->>'name', 'pending', (d->>'price_cents')::bigint, 'USD',
            (d->>'cycle')::public.billing_cycle, current_date, current_date, current_date)
    returning id into v_svc;
    insert into public.invoice_items (invoice_id, service_id, description, quantity, unit_price_cents, position)
    values (v_inv, v_svc, d->>'name', 1, (d->>'price_cents')::bigint, v_pos);
    v_pos := v_pos + 1;
  end loop;
  update public.invoices set status = 'sent' where id = v_inv;
  return v_inv;
end $$;

-- staff approval now uses the shared builder (same behaviour as in 0007)
create or replace function public.staff_approve_order(p_order_id uuid, p_client_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare o public.orders; v_client uuid; v_inv uuid;
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
  v_inv := private.fulfil_plans(v_client, o.plans, 'Order ' || upper(left(o.id::text, 8)), auth.uid());
  update public.orders set status = 'approved', client_id = v_client, invoice_id = v_inv, handled_by = auth.uid(), handled_at = now()
  where id = o.id;
  return jsonb_build_object('client_id', v_client, 'invoice_id', v_inv);
end $$;

-- ---------- the signed-in user claims their sign-up order -------------
create function public.claim_signup_order() returns jsonb
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  u auth.users; p public.profiles; m jsonb; v_plans text[] := '{}'; v_el jsonb; v_key text; v_fams text[] := '{}'; v_fam text;
  v_client uuid; v_inv uuid; v_name text; v_company text; v_phone text; v_domain text; v_notes text; v_dup uuid; v_order uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into u from auth.users where id = auth.uid();
  if not found or u.email_confirmed_at is null then return jsonb_build_object('status', 'none'); end if;
  select * into p from public.profiles where id = auth.uid() for update;       -- serialises double clicks / two tabs
  if not found or p.role <> 'client' or p.client_id is not null or not p.is_active then return jsonb_build_object('status', 'none'); end if;

  m := coalesce(u.raw_user_meta_data, '{}'::jsonb);
  if jsonb_typeof(m->'order_plans') = 'array' then
    for v_el in select * from jsonb_array_elements(m->'order_plans') loop
      if jsonb_typeof(v_el) <> 'string' then return jsonb_build_object('status', 'none'); end if;
      v_key := v_el #>> '{}';
      if private.plan_def(v_key) is null then return jsonb_build_object('status', 'none'); end if;
      v_fam := private.plan_def(v_key)->>'family';
      if v_fam = any(v_fams) then return jsonb_build_object('status', 'none'); end if;
      v_fams := v_fams || v_fam; v_plans := v_plans || v_key;
    end loop;
  end if;
  if cardinality(v_plans) not between 1 and 2 then return jsonb_build_object('status', 'none'); end if;

  v_name    := left(coalesce(nullif(trim(p.full_name), ''), split_part(u.email, '@', 1)), 200);
  v_company := left(nullif(trim(coalesce(m->>'business', '')), ''), 200);
  v_phone   := left(nullif(trim(coalesce(m->>'phone', '')), ''), 40);
  v_domain  := left(nullif(lower(trim(coalesce(m->>'domain', ''))), ''), 253);

  select id into v_dup from public.clients where lower(email) = lower(u.email) limit 1;
  v_notes := case when v_dup is not null then 'Same email as an existing client. Check for a duplicate before merging.' end;

  insert into public.clients (company_name, contact_name, email, phone)
  values (coalesce(v_company, v_name), v_name, lower(u.email), v_phone) returning id into v_client;
  update public.profiles set client_id = v_client where id = p.id;
  v_inv := private.fulfil_plans(v_client, v_plans, 'Self-service sign-up', null);

  insert into public.orders (status, source, contact_name, company_name, email, phone, domain, plans, notes, client_id, invoice_id, handled_at)
  values ('approved', 'signup', v_name, v_company, lower(u.email), v_phone, v_domain, v_plans, v_notes, v_client, v_inv, now())
  returning id into v_order;
  return jsonb_build_object('status', 'created', 'client_id', v_client, 'invoice_id', v_inv, 'duplicate_email', v_dup is not null);
end $$;

revoke all on function private.fulfil_plans(uuid, text[], text, uuid) from public, anon, authenticated;
revoke all on function public.claim_signup_order() from public, anon;
grant execute on function public.claim_signup_order() to authenticated;
