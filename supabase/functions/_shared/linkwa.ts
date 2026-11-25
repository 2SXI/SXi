// Linkwa adapter. Everything here comes from Linkwa's Developer API documentation
// (Authentication, "Generate Payment Link", "Check Payment Status"). Nothing else is assumed.
//
// Secrets (Edge Function secrets, never in the browser or the repo):
//   LINKWA_API_KEY   Bearer key (sk_live_... / sandbox key). A Developer API key, or an
//                    Integration key (Growth plan) which can create links and check status.
//   LINKWA_BASE_URL  e.g. https://linkwa.co.zw/api/v1/third-party  (Developer key)
//                         https://linkwa.co.zw/api/v1/integrations (Integration key)
//                    For the sandbox, use the sandbox base URL from your Linkwa dashboard.
//                    No default on purpose: a missing value must fail loudly, not hit production.

const base = () => {
  const v = Deno.env.get("LINKWA_BASE_URL");
  if (!v || !/^https:\/\//.test(v)) throw new Error("LINKWA_BASE_URL is not configured");
  return v.replace(/\/+$/, "");
};

async function call(path: string, init: RequestInit = {}) {
  const key = Deno.env.get("LINKWA_API_KEY");
  if (!key) throw new Error("LINKWA_API_KEY is not configured");
  const res = await fetch(base() + path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Log the gateway's message server-side only; never forward it (or the key) to the browser.
    console.error("linkwa error", res.status, path.split("/").slice(0, 3).join("/"), JSON.stringify(body).slice(0, 500));
    throw new Error(`Linkwa request failed (${res.status})`);
  }
  return body;
}

export interface PaymentLinkInput {
  amount: number; currency_code: string; payment_link_name: string; description?: string; return_url: string; external_order_id?: string;
}

/** POST /payment-links  — single-use (stock 1) so a link can only be paid once. */
export async function createPaymentLink(p: PaymentLinkInput) {
  const out = await call("/payment-links", { method: "POST", body: JSON.stringify({ ...p, stock: 1 }) });
  const product = out?.product;
  if (!product?.checkout_url || !product?.external_payment_link_id) throw new Error("Unexpected Linkwa response");
  return { checkout_url: String(product.checkout_url), external_payment_link_id: String(product.external_payment_link_id) };
}

export interface LinkwaStatus {
  payment_reference: string; currency_code: string; status: string; short_url: string; amount: number; payment_date_time?: string;
}

/** GET /payment-links/{short_url}/payments/{payment_reference}/status */
export async function getPaymentStatus(shortUrl: string, paymentReference: string): Promise<LinkwaStatus> {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(shortUrl)) throw new Error("Bad short_url");
  if (!/^[0-9a-f-]{16,64}$/i.test(paymentReference)) throw new Error("Bad payment_reference");
  return await call(`/payment-links/${encodeURIComponent(shortUrl)}/payments/${encodeURIComponent(paymentReference)}/status`);
}

/** The short code is the last path segment of the checkout URL (e.g. https://linkwa.com/pay/b01jxYz). */
export const shortUrlFromCheckout = (u: string) => new URL(u).pathname.split("/").filter(Boolean).pop() ?? "";

/**
 * The docs show status "PAID" in the status endpoint but "COMPLETED" in the sandbox test table,
 * so both are accepted as success. FAILED / CANCELLED / EXPIRED are terminal failures.
 * Anything else stays pending.
 */
export function classify(status: string): "paid" | "failed" | "pending" {
  const s = String(status).toUpperCase();
  if (s === "PAID" || s === "COMPLETED") return "paid";
  if (s === "FAILED" || s === "CANCELLED" || s === "EXPIRED") return "failed";
  return "pending";
}

/**
 * Webhook signature: X-Linkwa-Signature = hex HMAC-SHA256 of the RAW request body, keyed with
 * the webhook signing secret (Linkwa docs, "Signature Verification"). Compared in constant time.
 */
export async function verifySignature(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const got = header.trim().toLowerCase();
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
