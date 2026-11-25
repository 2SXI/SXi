-- =====================================================================
-- 0005 — online payments (Linkwa)
--
-- The gateway is the source of truth. Browser code can never mark anything paid:
-- only the three functions below (service_role only, called from Edge Functions) can
-- attach a gateway link to a payment, settle it, or fail it. Settling a payment fires
-- the existing payment_apply trigger, which is what marks the invoice paid.
-- =====================================================================

-- ---------- payments: gateway columns --------------------------------
alter table public.payments
  add column checkout_url      text,
  add column external_link_id  text,          -- Linkwa external_payment_link_id
  add column short_url         text,          -- Linkwa short_url (needed for the status check)
  add column provider_status   text,          -- last raw status seen from the gateway
  add column failure_reason    text,
  add column verified_at       timestamptz;   -- set only after a server-side check with the gateway

-- one gateway link belongs to exactly one payment row
create unique index payments_link_key
  on public.payments (provider, external_link_id) where external_link_id is not null;

-- at most one open (pending) Linkwa checkout per invoice
create unique index payments_one_open_linkwa
  on public.payments (invoice_id) where provider = 'linkwa' and status = 'pending';

-- ---------- gateway event log (idempotency) --------------------------
create table public.payment_events (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,
  idempotency_key text not null,
  event_type      text not null,
  payment_id      uuid references public.payments(id) on delete set null,
  payload         jsonb not null default '{}'::jsonb,
  signature_valid boolean,                     -- null = not a signed event (e.g. our own status check)
  received_at     timestamptz not null default now(),
  unique (provider, idempotency_key)
);
create index payment_events_payment_idx on public.payment_events (payment_id, received_at desc);
alter table public.payment_events enable row level security;
-- no write policies at all: only service_role (which bypasses RLS) can insert
create policy payment_events_admin_select on public.payment_events
  for select to authenticated using (private.is_admin());
revoke all on public.payment_events from anon, authenticated;
grant select on public.payment_events to authenticated;

-- ---------- 1. open (or reuse) a checkout for an invoice -------------
create function public.begin_linkwa_payment(p_invoice_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_inv public.invoices; v_paid bigint; v_remaining bigint; v_pay public.payments;
begin
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if v_inv.status not in ('sent', 'overdue') then raise exception 'Invoice is not payable'; end if;

  select coalesce(sum(amount_cents), 0) into v_paid
  from public.payments where invoice_id = p_invoice_id and status = 'paid';
  v_remaining := v_inv.total_cents - v_paid;
  if v_remaining <= 0 then raise exception 'Invoice is already fully paid'; end if;

  select * into v_pay from public.payments
  where invoice_id = p_invoice_id and provider = 'linkwa' and status = 'pending';
  if found then
    if v_pay.amount_cents = v_remaining and v_pay.checkout_url is not null then
      return jsonb_build_object('payment_id', v_pay.id, 'amount_cents', v_pay.amount_cents,
        'currency', v_pay.currency, 'number', v_inv.number, 'checkout_url', v_pay.checkout_url);
    end if;
    -- stale (amount changed, or the link was never created): retire it and start again
    update public.payments set status = 'failed', failure_reason = 'superseded' where id = v_pay.id;
  end if;

  insert into public.payments (invoice_id, client_id, provider, method, amount_cents, currency, status)
  values (p_invoice_id, v_inv.client_id, 'linkwa', 'online', v_remaining, v_inv.currency, 'pending')
  returning * into v_pay;

  return jsonb_build_object('payment_id', v_pay.id, 'amount_cents', v_pay.amount_cents,
    'currency', v_pay.currency, 'number', v_inv.number, 'checkout_url', null);
end $$;

-- ---------- 2. remember the link Linkwa gave us ----------------------
create function public.attach_linkwa_link(p_payment_id uuid, p_checkout_url text, p_external_link_id text, p_short_url text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_checkout_url !~ '^https://' then raise exception 'Checkout URL must be https'; end if;
  update public.payments
     set checkout_url = p_checkout_url, external_link_id = p_external_link_id, short_url = p_short_url
   where id = p_payment_id and provider = 'linkwa' and status = 'pending' and checkout_url is null;
  if not found then raise exception 'Payment not found or already has a link'; end if;
end $$;

-- ---------- 3. settle after the gateway confirmed it ------------------
-- Returns 'paid' | 'already_paid' | 'mismatch'. Idempotent. The amount and currency the
-- gateway reports must equal what we asked for, or nothing is recorded as paid.
create function public.settle_provider_payment(
  p_payment_id uuid, p_provider_reference text, p_amount_cents bigint, p_currency text, p_provider_status text default null
) returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.payments;
begin
  select * into v from public.payments where id = p_payment_id and provider = 'linkwa' for update;
  if not found then raise exception 'Payment not found'; end if;
  if coalesce(trim(p_provider_reference), '') = '' then raise exception 'A gateway reference is required'; end if;

  if v.status = 'paid' then
    if v.provider_reference is not distinct from p_provider_reference then return 'already_paid'; end if;
    raise exception 'Payment is already settled with a different reference';
  end if;
  if v.status = 'refunded' then raise exception 'Payment was refunded'; end if;

  if p_amount_cents is distinct from v.amount_cents or upper(p_currency) is distinct from v.currency then
    update public.payments set provider_status = p_provider_status, failure_reason = 'amount_or_currency_mismatch'
     where id = v.id;
    return 'mismatch';
  end if;

  -- a unique-index violation here means this gateway reference already settled another payment
  update public.payments
     set provider_reference = p_provider_reference, provider_status = p_provider_status,
         failure_reason = null, verified_at = now(), status = 'paid'
   where id = v.id;
  -- the invoice is now settled: retire any other open checkout for it
  if exists (select 1 from public.invoices where id = v.invoice_id and status = 'paid') then
    update public.payments set status = 'failed', failure_reason = 'invoice_paid_elsewhere'
     where invoice_id = v.invoice_id and id <> v.id and provider = 'linkwa' and status = 'pending';
  end if;
  return 'paid';
end $$;

-- ---------- 4. the gateway says it failed / was cancelled / expired ---
create function public.fail_provider_payment(p_payment_id uuid, p_provider_status text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.payments;
begin
  select * into v from public.payments where id = p_payment_id and provider = 'linkwa' for update;
  if not found then raise exception 'Payment not found'; end if;
  if v.status in ('paid', 'refunded') then return v.status::text; end if;
  update public.payments
     set status = 'failed', provider_status = left(p_provider_status, 100), failure_reason = left(p_provider_status, 100)
   where id = v.id;
  return 'failed';
end $$;

-- ---------- 5. idempotent event log -----------------------------------
create function public.record_payment_event(
  p_provider text, p_key text, p_type text, p_payload jsonb, p_signature_valid boolean, p_payment_id uuid default null
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  insert into public.payment_events (provider, idempotency_key, event_type, payload, signature_valid, payment_id)
  values (p_provider, left(p_key, 200), left(p_type, 100), coalesce(p_payload, '{}'::jsonb), p_signature_valid, p_payment_id)
  on conflict (provider, idempotency_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n = 1;        -- false = we have seen this exact event before
end $$;

-- ---------- 6. a paid invoice renews the services on it ---------------
create function private.invoice_paid_renew() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.services s set renewal_date =
    case s.billing_cycle
      when 'monthly'   then greatest(coalesce(s.renewal_date, current_date), current_date) + interval '1 month'
      when 'quarterly' then greatest(coalesce(s.renewal_date, current_date), current_date) + interval '3 months'
      when 'yearly'    then greatest(coalesce(s.renewal_date, current_date), current_date) + interval '1 year'
    end
  where s.status <> 'cancelled' and s.billing_cycle <> 'one_time'
    and s.id in (select service_id from public.invoice_items where invoice_id = new.id and service_id is not null);
  return null;
end $$;
create trigger invoice_paid_renew after update of status on public.invoices
  for each row when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function private.invoice_paid_renew();

-- ---------- permissions: service role only ----------------------------
revoke all on function
  public.begin_linkwa_payment(uuid),
  public.attach_linkwa_link(uuid, text, text, text),
  public.settle_provider_payment(uuid, text, bigint, text, text),
  public.fail_provider_payment(uuid, text),
  public.record_payment_event(text, text, text, jsonb, boolean, uuid)
from public, anon, authenticated;
grant execute on function
  public.begin_linkwa_payment(uuid),
  public.attach_linkwa_link(uuid, text, text, text),
  public.settle_provider_payment(uuid, text, bigint, text, text),
  public.fail_provider_payment(uuid, text),
  public.record_payment_event(text, text, text, jsonb, boolean, uuid)
to service_role;
