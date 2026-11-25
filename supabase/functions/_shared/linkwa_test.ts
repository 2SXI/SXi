import assert from "node:assert/strict";
const assertEquals = (a: unknown, b: unknown) => assert.deepEqual(a, b);
const assertRejects = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { return e; } throw new Error("expected a rejection"); };
import { classify, shortUrlFromCheckout, createPaymentLink, getPaymentStatus, verifySignature } from "./linkwa.ts";

Deno.env.set("LINKWA_API_KEY", "sk_test_secret");
Deno.env.set("LINKWA_BASE_URL", "https://sandbox.linkwa.test/api/v1/third-party/");

const mock = (res: unknown, status = 200) => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => { calls.push({ url, init }); return Promise.resolve(new Response(JSON.stringify(res), { status })); }) as typeof fetch;
  return calls;
};

Deno.test("classify maps gateway statuses", () => {
  for (const s of ["PAID", "completed", "Completed"]) assertEquals(classify(s), "paid");
  for (const s of ["FAILED", "CANCELLED", "EXPIRED"]) assertEquals(classify(s), "failed");
  for (const s of ["PENDING", "PROCESSING", "", "weird"]) assertEquals(classify(s), "pending");
});

Deno.test("short url comes from the checkout url", () => {
  assertEquals(shortUrlFromCheckout("https://linkwa.com/pay/b01jxYz"), "b01jxYz");
  assertEquals(shortUrlFromCheckout("https://linkwa.com/pay/b01jxYz/"), "b01jxYz");
});

Deno.test("createPaymentLink is single-use, authenticated, and sends the documented fields", async () => {
  const calls = mock({ product: { checkout_url: "https://linkwa.com/pay/abc", external_payment_link_id: "01k" } });
  const out = await createPaymentLink({ amount: 120, currency_code: "USD", payment_link_name: "Invoice INV-1", return_url: "https://sxi.test/pay-return.html?pid=1" });
  assertEquals(out.checkout_url, "https://linkwa.com/pay/abc");
  assertEquals(calls[0].url, "https://sandbox.linkwa.test/api/v1/third-party/payment-links");
  assertEquals((calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk_test_secret");
  const sent = JSON.parse(String(calls[0].init.body));
  assertEquals(sent.stock, 1);
  assertEquals(sent.amount, 120);
});

Deno.test("gateway errors never leak the key or the gateway message", async () => {
  mock({ message: "Invalid API Key." }, 401);
  const err = await assertRejects(() => createPaymentLink({ amount: 1, currency_code: "USD", payment_link_name: "x", return_url: "https://a.test" }));
  assertEquals(String((err as Error).message).includes("sk_test_secret"), false);
  assertEquals(String((err as Error).message).includes("Invalid API Key"), false);
});

Deno.test("status lookups reject malformed identifiers before any request", async () => {
  const calls = mock({});
  await assertRejects(() => getPaymentStatus("../../balance", "e14394bd-26c2-41ec-87ad-6fed0aa362ee"));
  await assertRejects(() => getPaymentStatus("7pRGnPe", "x/../y"));
  assertEquals(calls.length, 0);
});

Deno.test("status lookup builds the documented path", async () => {
  const calls = mock({ status: "PAID" });
  await getPaymentStatus("7pRGnPe", "e14394bd-26c2-41ec-87ad-6fed0aa362ee");
  assertEquals(calls[0].url, "https://sandbox.linkwa.test/api/v1/third-party/payment-links/7pRGnPe/payments/e14394bd-26c2-41ec-87ad-6fed0aa362ee/status");
});

Deno.test("verifySignature accepts the correct HMAC and rejects everything else", async () => {
  const body = '{"event":"payment.completed","amount":15.5}', secret = "whsec_test";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(await verifySignature(body, sig, secret), true);
  assertEquals(await verifySignature(body, sig.toUpperCase(), secret), true);
  assertEquals(await verifySignature(body + " ", sig, secret), false);   // body altered
  assertEquals(await verifySignature(body, sig, "other"), false);        // wrong secret
  assertEquals(await verifySignature(body, null, secret), false);
  assertEquals(await verifySignature(body, sig, ""), false);             // secret not configured
  assertEquals(await verifySignature(body, "abc", secret), false);
});
