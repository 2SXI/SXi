// POST { pid, short_url?, payment_reference? }  ->  { status: 'paid' | 'pending' | 'failed' | 'review' }
// Called by /pay-return.html after Linkwa redirects the customer back. The redirect proves
// nothing: we ask Linkwa server-to-server and only then settle, in the database, with checks.
import { cors, json, callerClient, serviceClient, isUuid } from "../_shared/http.ts";
import { getPaymentStatus, classify } from "../_shared/linkwa.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const caller = await callerClient(req);
    if (!caller) return json({ error: "Please sign in again." }, 401);

    const b = await req.json().catch(() => ({}));
    if (!isUuid(b?.pid)) return json({ error: "Invalid request." }, 400);
    const hasRef = typeof b?.short_url === "string" && typeof b?.payment_reference === "string" && b.short_url && b.payment_reference;

    const svc = serviceClient();
    const { data: ok } = await svc.rpc("rate_limit_hit", { p_key: `verify:${caller.user.id}`, p_max: 30, p_window_seconds: 600 });
    if (!ok) return json({ error: "Too many attempts. Please wait a few minutes." }, 429);

    // Read AS THE CALLER: RLS limits this to their own payments.
    const { data: pay } = await caller.db.from("payments")
      .select("id,status,provider,short_url,amount_cents,currency,provider_reference").eq("id", b.pid).maybeSingle();
    if (!pay || pay.provider !== "linkwa") return json({ error: "Payment not found." }, 404);
    if (pay.status === "paid") return json({ status: "paid" });
    if (pay.status === "failed") return json({ status: "failed" });
    // No gateway parameters on the return URL: we can't query Linkwa, but the webhook may settle it. Report what the DB says.
    if (!hasRef) return json({ status: "pending" });
    if (!pay.short_url || pay.short_url !== b.short_url) return json({ error: "Payment not found." }, 404); // the reference must belong to OUR link

    let st;
    try { st = await getPaymentStatus(b.short_url, b.payment_reference); }
    catch (err) { console.error("verify: gateway lookup failed", err); return json({ status: "pending" }); }

    // The gateway's answer must be about the payment we asked about.
    if (st.short_url !== pay.short_url || st.payment_reference !== b.payment_reference) return json({ status: "review" });

    const kind = classify(st.status);
    await svc.rpc("record_payment_event", {
      p_provider: "linkwa", p_key: `status:${pay.id}:${st.payment_reference}:${String(st.status).toUpperCase()}`,
      p_type: "status_check", p_payload: st, p_signature_valid: null, p_payment_id: pay.id,
    });

    if (kind === "paid") {
      const { data: res, error } = await svc.rpc("settle_provider_payment", {
        p_payment_id: pay.id, p_provider_reference: st.payment_reference,
        p_amount_cents: Math.round(Number(st.amount) * 100), p_currency: String(st.currency_code).toUpperCase(), p_provider_status: String(st.status),
      });
      if (error) { console.error("settle failed", error.message); return json({ status: "review" }); }
      return json({ status: res === "mismatch" ? "review" : "paid" });
    }
    if (kind === "failed") {
      await svc.rpc("fail_provider_payment", { p_payment_id: pay.id, p_provider_status: String(st.status).toUpperCase() });
      return json({ status: "failed" });
    }
    return json({ status: "pending" });
  } catch (err) {
    console.error("verify-payment", err);
    return json({ error: "Something went wrong." }, 500);
  }
});
