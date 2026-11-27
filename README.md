# SXI Digital — website + client portal

One folder you can host anywhere that serves static files. No Node server, no build step.

```
(repo root)  ← upload this folder's contents to your web root
  index.html, services.html, …      existing marketing site (phone numbers fixed, "Client Login" added)
  login.html, reset-password.html   sign in / reset password
  dashboard/                        client dashboard   →  yourdomain.com/dashboard/
  admin/                            admin dashboard (staff and admins only)
  portal/                           styles + JavaScript (+ self-hosted Supabase library)
  _headers, vercel.json             security headers (Netlify/Cloudflare Pages, Vercel)
supabase/    ← database (run once in Supabase) + 164 database tests
tests/       ← unit + browser tests
```

## How it's secured

The browser talks directly to Supabase, so **the database is the security boundary**, not the page:

* **Row Level Security** on every table — a client can only ever read their own rows, whatever the front-end does. Draft invoices are invisible to clients. Roles can't be self-assigned. Invoices only become *paid* by recording a payment. The audit log can't be edited by anyone. (164 automated checks, including attempts to break each rule.)
* **XSS** is the main browser-side risk. All dynamic text is escaped by default (`html` templates in `portal/js/util.js`), links are limited to `http(s)`, and the portal pages ship with a strict Content-Security-Policy (no inline or third-party scripts). Tested by injecting `<img onerror>` into every field.
* The Supabase **anon key** in `config.js` is public by design. **Never** put the service-role key, or any hosting / mail / payment API key, anywhere in the deployed site files.

### Honest trade-offs of the plain-HTML approach
* The session token lives in browser storage (Supabase's default). That's why the CSP matters: **don't add third-party scripts (analytics, chat widgets, ad pixels) to `login.html`, `dashboard/` or `admin/`.**
* Login throttling is Supabase Auth's built-in rate limit plus a small client-side delay (no custom per-account limiter yet).
* Anything that needs a secret — cPanel/CloudPanel/Mailcow calls, Paynow/Stripe — must run server-side. That will be **Supabase Edge Functions** in Phase 8, never browser code.

## Setup

1. **Supabase project.** Authentication → disable *Allow new users to sign up* (SXI creates client accounts). Set minimum password length to 10+. Under *URL Configuration* set the Site URL to your domain and add `https://YOURDOMAIN/reset-password.html` to the redirect URLs (needed for password-reset emails).
2. **Database.** In the SQL editor run, in order: `supabase/migrations/0001_schema.sql`, `0002_security.sql`, `0003_client_helpers.sql`, `0004_admin_helpers.sql`, `0005_online_payments.sql`, `0006_recurring_billing.sql`, `0007_orders.sql`. Optional: run `supabase/seed_demo.sql` for a demo client with sample data.
3. **Connect the site.** Edit `portal/js/config.js`: your project URL + anon key (Project Settings → API). Optionally set `WEBMAIL_URL`.
4. **First admin.** Authentication → Add user, then in the SQL editor:
   ```sql
   update public.profiles set role = 'admin' where email = 'you@sxidigital.com';
   ```
5. **First client.** Create their login in Supabase → Authentication → Users (tick *Auto confirm*). Then sign in to `/admin/`, open **Clients → Add client**, and on the client's page use **Link a login by email**. Add their domains, hosting, websites, mailboxes and invoices from the other admin screens. Tell the client to use *Forgot password?* on the login page to set their own password.
6. **Deploy** the repo root (everything except `supabase/` and `tests/`) to your host. Netlify / Cloudflare Pages read `_headers`; Vercel reads `vercel.json`; on Nginx/Apache add the same headers for `/login.html`, `/reset-password.html`, `/dashboard/*`, `/admin/*`.
7. **Daily job** (overdue invoices, renewal reminders **and renewal invoice generation**), in the SQL editor:
   ```sql
   select cron.schedule('sxi-daily', '0 4 * * *', 'select public.run_daily_maintenance()');
   ```

## What's in the client dashboard
Overview · Websites · Domains · Email · Hosting · Invoices · Support · Profile · Settings, a notification bell, and a bottom tab bar + "More" sheet on phones.
Things a client can only *ask for* — renewals, transfers, DNS changes, website changes, new/deleted mailboxes, mailbox password resets — are filed as support tickets (through the `create_ticket` database function, which takes the client from the login session, never from the browser). Mailbox passwords are never shown. Nothing pretends to be connected when it isn't: **Open Webmail** stays disabled until `WEBMAIL_URL` is set, hosting usage says when it hasn't been synced, and invoices show no fake "Pay now" button.

## What's in the admin dashboard
Overview (open tickets, unpaid invoices, expiring domains, income this month) · Clients (with a detail page and login linking) · Services · Websites · Domains · Hosting · Email · Invoices (draft → add items → send → mark paid, printable) · Payments (mark paid / failed / refund) · Support (reply, status, priority, assignment, private notes) · Servers · Activity log · Team & logins (admins only) · Settings. Responsive: sidebar on desktop, bottom tab bar + "More" on phones.
Money rules are enforced by the database, not the screens: sent invoices are locked, invoices only become paid via a payment, and role changes are admin-only. Creating the *login itself* still happens in Supabase (browser code can't hold the service-role key). Hosting usage is typed in by hand until a control-panel integration exists.

### v2 additions
Glass-and-glow redesign across login, admin and client dashboard · **Ctrl/Cmd+K command palette** (jump to any screen, client, invoice, domain or ticket; run quick actions) · income chart, live activity feed and animated counters on the Overview · **sortable columns** and **Export CSV** on every list · **Renewals** screen (domains, hosting and services due within 120 days, one click to draft the invoice) · private notes on each client.

## Neural-network background
`login.html`, `reset-password.html` and `/admin/` show a faint animated network behind the content (`portal/js/neural.js`, same look as the marketing site). It's purely decorative: it ignores clicks, pauses when the tab is hidden, and shows a still frame for visitors who prefer reduced motion. Tune its strength with `startNeuralBackground({ faint: 0.8 })` (0 = invisible, 1 = as bright as the marketing site). The client dashboard is deliberately left clean; to add it there, import and call the same function in `portal/js/dashboard.js`.

## Tests
```
node --test tests/util.test.mjs                    # 10 unit tests (escaping, redirects, formatting)
pip install playwright && playwright install chromium
python3 tests/e2e.py                               # 97 client-dashboard browser checks against a mocked Supabase API
python3 tests/e2e_order.py                         # 31 checks on the public order form and the services-page links
python3 tests/e2e_admin.py                         # 64 admin browser checks (desktop + phone, actions, XSS)
bash supabase/run_tests.sh                         # 269 database checks (needs local PostgreSQL)
(cd supabase/functions && deno test --allow-env _shared/linkwa_test.ts)   # 7 payment-adapter tests
```
The browser tests use a *mock* of the Supabase API, so the first thing to verify after step 5 is a real sign-in against your project (and a real admin action, such as sending an invoice).

## Roadmap
- [x] 1 Inspection · [x] 2 Database + auth + roles · [x] 3 Client dashboard
- [x] 4 Admin dashboard + client management · [x] 5 Websites/domains/hosting admin · [x] 6 Invoices & payments UI
- [x] 7 Support (admin side) · [ ] 8 Provider abstractions (hosting, email, payments) · [ ] 9 Security review · [ ] 10 Polish

## Online payments (Linkwa)
Clients press **Pay online** on an invoice → `create-checkout` (Edge Function) makes a single-use Linkwa link for the invoice's remaining balance → Linkwa's hosted checkout (cards + mobile money) → Linkwa returns the client to `/dashboard/pay-return.html` → `verify-payment` asks Linkwa server-to-server and settles in the database. **Landing on the return page never marks anything paid**; only a confirmed Linkwa status whose amount, currency and link match does.

1. Run `supabase/migrations/0005_online_payments.sql`.
2. Create a Linkwa app (Developer or Growth plan). Set secrets, **server-side only**:
   `supabase secrets set LINKWA_API_KEY=... LINKWA_BASE_URL=... SITE_URL=https://yourdomain`
   (`LINKWA_BASE_URL` is `https://linkwa.co.zw/api/v1/third-party` for a Developer key or `.../integrations` for an Integration key; use the sandbox host while testing: `https://sandbox.linkwa.co.zw/api/v1/third-party` (or `/integrations`) — live is `https://linkwa.co.zw/...`. Register your domain with Linkwa so the return URL is accepted.)
3. `supabase functions deploy create-checkout verify-payment`
4. Test in the sandbox with Linkwa's test numbers/cards (success, insufficient funds, cancelled, expired, declined card) before switching the key.

**Webhook (Growth plan).** In your Linkwa dashboard add the endpoint `https://<project-ref>.supabase.co/functions/v1/linkwa-webhook` and copy its signing secret. Then:
`supabase secrets set LINKWA_WEBHOOK_SECRET=...` and `supabase functions deploy linkwa-webhook --no-verify-jwt` (no JWT, because Linkwa isn't a signed-in user; the HMAC signature is the authentication). Every `payment.completed` event is verified, matched to our own link, amount- and currency-checked, and settled idempotently, so the return page and the webhook can both fire safely. Without the Growth plan the return-page check and manual *Admin → Payments* still work, but a client who pays and never comes back is not picked up automatically.

Still not built: a scheduled reconcile. Paying an invoice (online or marked paid by staff) renews each recurring service on it exactly once, by one billing cycle from its current renewal date (or from today if that date has passed). One-off and cancelled services are never touched. This is intentional; if you'd rather renew by hand, drop the `invoice_paid_renew` trigger from `0005`.

The return page works with or without Linkwa's `short_url` / `payment_reference` parameters: with them it verifies with Linkwa immediately, without them it shows the database status and the webhook settles the payment.


## Recurring billing (migration 0006)
* **Renewal invoices are generated automatically.** Each day (and on demand from **Admin → Invoices → Renewal invoices**) every *active* service that is recurring (monthly / quarterly / yearly), has a price above zero, has *Create the renewal invoice automatically* ticked, and renews within the lead time (default 14 days) gets a line on a **draft** invoice. One invoice per client and currency; hosting + email for the same client land on one invoice, so they pay once. The invoice is due on the renewal date (today, if that has already passed).
* **Drafts by default.** Tick *Send generated invoices to clients automatically* in the same dialog if you would rather skip the review step; the client is then notified and can press **Pay online** straight away.
* **Never twice.** A service is invoiced once per renewal date (`services.invoiced_for`). Paying the invoice moves the renewal date forward one cycle, which makes the service eligible for the *next* invoice. If you cancel a generated invoice, that service is **not** regenerated automatically: create that invoice by hand, or clear *Create the renewal invoice automatically* and tick it again after changing the renewal date.
* **Hosting renewal dates stay in sync.** Link a hosting service to its hosting account (service form, *Linked hosting account*). The hosting account's renewal date is then copied from the service whenever it changes, so reminders use the date that was paid for.
* **Mailbox limits.** Set *Mailbox limit* on a hosting account and choose that account in each mailbox's *Hosting plan*. Adding a mailbox past the limit is refused by the database (deleted mailboxes free a slot). Mailboxes without a hosting plan are not limited.
* Settings live in the `settings` table: `billing.invoice_lead_days` (0-90) and `billing.auto_send` (true/false).

## Online orders (migration 0007)
The **Get started** buttons on `services.html` open `order.html` with the plan preselected. The flow:
1. The visitor sends the form. This calls `submit_order()`, the only thing the public (anon) key can do. It validates every field, takes the price from the server-side catalogue (`private.plan_def`, never from the browser), and is rate limited (3 orders per email per hour, 200 per hour overall). No payment is taken.
2. The order appears in **Admin → Orders** (status *New*). Check the details, then **Approve & send invoice**. Choose an existing client in the dialog if this person is already one of yours, otherwise leave it blank and a new client is created from the order.
3. Approving creates the client, the services (status *pending*) and an invoice that is sent immediately (due in 7 days). You are taken to the client page: **create their login there** (same as for any client), and they set a password with *Forgot password*.
4. The client signs in and presses **Pay online**. When the invoice is paid, the services become *active* and their renewal date moves one cycle on. From then on the renewal invoices of migration 0006 take over.
* Rejecting an order creates nothing. Only an admin can delete orders.
* **Changing a price or adding a plan:** edit `private.plan_def` in a new migration, the dropdowns in `order.html`, and `PRICES` in `order.js` (display only), and `PLANS` in `portal/js/admin/resources.js`. The server price list is the one that counts.
* **There is no email notification for new orders yet.** Check Admin → Orders, or tell us if you want an email/WhatsApp alert added.
* The domain a visitor types is kept on the order for you to read. It does not create a domain record automatically.

## Login service (admin-users)
The admin screens' **Create client login**, **Add team member** and **password reset link** buttons call the `admin-users` Edge Function, because creating a login needs the service-role key (never in browser code). Deploy it with `supabase functions deploy admin-users` (or paste `paste-into-supabase/admin-users.ts` into the dashboard; keep *Verify JWT* **on**). It needs the secret `SITE_URL` and checks the caller is an active staff member or admin; only admins can create team logins. *Invite* emails use Supabase's mailer (set up custom SMTP under Authentication for anything beyond a few emails per hour); *temporary password* needs no email at all.
