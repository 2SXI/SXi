# Edge Functions

| Function | Purpose |
|---|---|
| `create-checkout` | Client presses **Pay online** → creates a single-use Linkwa payment link for the invoice's remaining balance. |
| `linkwa-webhook`  | Linkwa posts `payment.completed` → verifies the HMAC signature → settles the payment even if the client never returns. Deploy with `--no-verify-jwt`. |
| `verify-payment`  | Client returns from Linkwa → asks Linkwa server-to-server, then settles the payment in the database. |

## Secrets (server-side only)
```
supabase secrets set LINKWA_API_KEY=...        # sandbox key first
supabase secrets set LINKWA_BASE_URL=...       # https://sandbox.linkwa.co.zw/api/v1/third-party (sandbox), then https://linkwa.co.zw/api/v1/third-party (live); use .../integrations for an Integration key
supabase secrets set SITE_URL=https://yourdomain
supabase secrets set LINKWA_WEBHOOK_SECRET=...   # signing secret from the Linkwa webhook page
supabase functions deploy create-checkout verify-payment
supabase functions deploy linkwa-webhook --no-verify-jwt
```
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase automatically.
