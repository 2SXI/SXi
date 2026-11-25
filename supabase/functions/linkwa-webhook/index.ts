// POST from Linkwa: { event: "payment.completed", status: "PAID", reference, amount, currency, external_payment_link_id, ... }
// Two delivery styles, both handled:
//  1. Signed `payment.completed` event (Developer API): HMAC-verified, then settled.
//  2. Unsigned "ping" { short_url, payment_reference, external_order_id } (Integration keys): the payload is
//     NEVER trusted; we only use its identifiers to ask Linkwa server-to-server, exactly like the return page.
// Public endpoint (deploy with --no-verify-jwt): the HMAC signature is the authentication.
// Linkwa retries on 5xx / 429 / 401 / timeout and NOT on other 4xx, so:
//   bad signature -> 401 (retryable, lets you fix the secret) · settle failure -> 500 (retry)
//   unknown payment / unsupported event / amount mismatch -> 200 (retrying can't help; mismatch is flagged in the DB)
import { json, serviceClient } from "../_shared/http.ts";
import { verifySignature, classify, getPaymentStatus } from "../_shared/linkwa.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const raw = await req.text();
    if (raw.length > 100_000) return json({ error: "Too large" }, 413);
    const secret = Deno.env.get("LINKWA_WEBHOOK_SECRET") ?? "";
    if (!req.headers.get("x-linkwa-signature")) return await handlePing(raw);
    if (!(await verifySignature(raw, req.headers.get("x-linkwa-signature"), secret))) {
      console.error("linkwa-webhook: invalid signature");   // nothing is written for unsigned requests
      return json({ error: "Invalid signature" }, 401);
    }

    let e: Record<string, unknown>;
    try { e = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }
    if (e.event !== "payment.completed" || classify(String(e.status)) !== "paid") return json({ ok: true, ignored: "event" });

    const linkId = typeof e.external_payment_link_id === "string" ? e.external_payment_link_id : "";
    const reference = typeof e.reference === "string" ? e.reference.trim() : "";
    const amount = Number(e.amount), currency = String(e.currency ?? "").toUpperCase();
    if (!linkId || !reference || !Number.isFinite(amount) || !currency) return json({ ok: true, ignored: "incomplete" });

    const svc = serviceClient();
    // Only links WE created (via the API) carry external_payment_link_id, and it is unique per payment.
    const { data: pay, error: findErr } = await svc.from("payments")
      .select("id,status,provider_reference").eq("provider", "linkwa").eq("external_link_id", linkId).maybeSingle();
    if (findErr) { console.error("linkwa-webhook: lookup failed", findErr.message); return json({ error: "Try again" }, 500); }
    if (!pay) return json({ ok: true, ignored: "unknown_link" });

    await svc.rpc("record_payment_event", {
      p_provider: "linkwa", p_key: `webhook:${reference}`, p_type: "payment.completed",
      p_payload: e, p_signature_valid: true, p_payment_id: pay.id,
    });

    // Already settled (e.g. the client's return page got there first): acknowledge, nothing to do.
    if (pay.status === "paid") return json({ ok: true, result: "already_paid" });

    const { data: res, error } = await svc.rpc("settle_provider_payment", {
      p_payment_id: pay.id, p_provider_reference: reference,
      p_amount_cents: Math.round(amount * 100), p_currency: currency, p_provider_status: "PAID",
    });
    if (error) {
      // Settled concurrently under a different reference string: it IS paid, so don't make Linkwa retry.
      if (/different reference|already settled/i.test(error.message)) return json({ ok: true, result: "already_paid" });
      console.error("linkwa-webhook: settle failed", error.message);
      return json({ error: "Try again" }, 500);
    }
    return json({ ok: true, result: res });   // 'paid' | 'already_paid' | 'mismatch' (mismatch is recorded for staff review)
  } catch (err) {
    console.error("linkwa-webhook", err);
    return json({ error: "Try again" }, 500);
  }
});

async function handlePing(raw: string): Promise<Response> {
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }
  const shortUrl = typeof b.short_url === "string" ? b.short_url : "", ref = typeof b.payment_reference === "string" ? b.payment_reference : "";
  if (!shortUrl || !ref) return json({ error: "Invalid signature" }, 401);   // neither signed nor a ping: reject
  const svc = serviceClient();
  const { data: pay } = await svc.from("payments").select("id,status,short_url").eq("provider", "linkwa").eq("short_url", shortUrl).maybeSingle();
  if (!pay) return json({ ok: true, ignored: "unknown_link" });
  if (pay.status === "paid" || pay.status === "failed") return json({ ok: true, result: pay.status });
  let st;
  try { st = await getPaymentStatus(shortUrl, ref); }
  catch (err) { console.error("linkwa-ping: gateway lookup failed", err); return json({ error: "Try again" }, 502); }
  if (st.short_url !== pay.short_url || st.payment_reference !== ref) return json({ ok: true, ignored: "mismatch" });
  await svc.rpc("record_payment_event", { p_provider: "linkwa", p_key: `ping:${pay.id}:${ref}:${String(st.status).toUpperCase()}`,
    p_type: "ping_status_check", p_payload: st, p_signature_valid: null, p_payment_id: pay.id });
  const kind = classify(st.status);
  if (kind === "paid") {
    const { data: res, error } = await svc.rpc("settle_provider_payment", {
      p_payment_id: pay.id, p_provider_reference: ref,
      p_amount_cents: Math.round(Number(st.amount) * 100), p_currency: String(st.currency_code).toUpperCase(), p_provider_status: String(st.status),
    });
    if (error) {
      if (/different reference|already settled/i.test(error.message)) return json({ ok: true, result: "already_paid" });
      console.error("linkwa-ping: settle failed", error.message); return json({ error: "Try again" }, 500);
    }
    return json({ ok: true, result: res });
  }
  if (kind === "failed") await svc.rpc("fail_provider_payment", { p_payment_id: pay.id, p_provider_status: String(st.status).toUpperCase() });
  return json({ ok: true, result: kind });
}
