// POST { invoice_id }  ->  { checkout_url }
// Auth: the signed-in client (or staff). The invoice is read AS THE CALLER, so row-level
// security decides whether they may see it. The amount always comes from the database.
import { cors, json, callerClient, serviceClient, isUuid, siteUrl } from "../_shared/http.ts";
import { createPaymentLink, shortUrlFromCheckout } from "../_shared/linkwa.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const caller = await callerClient(req);
    if (!caller) return json({ error: "Please sign in again." }, 401);

    const body = await req.json().catch(() => ({}));
    if (!isUuid(body?.invoice_id)) return json({ error: "Invalid request." }, 400);

    const svc = serviceClient();
    const { data: ok } = await svc.rpc("rate_limit_hit", { p_key: `checkout:${caller.user.id}`, p_max: 10, p_window_seconds: 600 });
    if (!ok) return json({ error: "Too many attempts. Please wait a few minutes." }, 429);

    // RLS: a client only sees their own, non-draft invoices.
    const { data: inv } = await caller.db.from("invoices").select("id,number,status").eq("id", body.invoice_id).maybeSingle();
    if (!inv) return json({ error: "Invoice not found." }, 404);
    if (!["sent", "overdue"].includes(inv.status)) return json({ error: "This invoice can't be paid online." }, 409);

    const { data: begun, error: e1 } = await svc.rpc("begin_linkwa_payment", { p_invoice_id: inv.id });
    if (e1) return json({ error: /already fully paid|not payable/.test(e1.message) ? "This invoice can't be paid online." : "Couldn't start the payment." }, 409);
    if (begun.checkout_url) return json({ checkout_url: begun.checkout_url });

    try {
      const link = await createPaymentLink({
        amount: begun.amount_cents / 100,
        currency_code: begun.currency,
        payment_link_name: `Invoice ${begun.number} · SXI Digital`.slice(0, 120),
        description: `Payment for invoice ${begun.number}`,
        return_url: `${siteUrl()}/dashboard/pay-return.html?pid=${begun.payment_id}`,
        // Integration keys: Linkwa's status ping is keyed on this (the official plugin sends it too).
        ...((Deno.env.get("LINKWA_BASE_URL") ?? "").includes("/integrations") ? { external_order_id: begun.payment_id } : {}),
      });
      const { error: e2 } = await svc.rpc("attach_linkwa_link", {
        p_payment_id: begun.payment_id, p_checkout_url: link.checkout_url,
        p_external_link_id: link.external_payment_link_id, p_short_url: shortUrlFromCheckout(link.checkout_url),
      });
      if (e2) throw e2;
      return json({ checkout_url: link.checkout_url });
    } catch (err) {
      console.error("create-checkout failed", err);
      await svc.rpc("fail_provider_payment", { p_payment_id: begun.payment_id, p_provider_status: "LINK_CREATION_FAILED" });
      return json({ error: "Couldn't start the payment. Please try again shortly." }, 502);
    }
  } catch (err) {
    console.error("create-checkout", err);
    return json({ error: "Something went wrong." }, 500);
  }
});
