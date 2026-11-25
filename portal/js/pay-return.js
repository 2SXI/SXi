// Landing page after Linkwa checkout. The redirect itself proves nothing: this page only
// asks our server to confirm the payment with Linkwa, then shows what the database says.
import { db, configured, $ } from "./core.js";

const params = new URLSearchParams(location.search);
const pid = params.get("pid"), shortUrl = params.get("short_url"), ref = params.get("payment_reference");
const title = $("#title"), sub = $("#sub"), msg = $("#msg");
const show = (t, s, kind = "") => { title.textContent = t; sub.textContent = ""; msg.className = kind ? "alert " + kind : ""; msg.textContent = kind ? s : ""; if (!kind) sub.textContent = s; };

const SHOW = {
  paid:    ["Payment received", "Thank you. Your invoice has been marked as paid and a receipt is in your invoices.", "ok"],
  failed:  ["Payment not completed", "No money was taken for this attempt. You can try again from your invoice.", "warn"],
  review:  ["We're confirming your payment", "Your payment needs a quick manual check by SXI Digital. You don't need to pay again. We'll update your invoice.", "info"],
  pending: ["Still confirming…", "Your bank or wallet hasn't confirmed yet. Check your invoice in a few minutes. If you were charged, it will update automatically.", "info"],
};

async function run() {
  if (!configured) return show("Unavailable", "The portal isn't configured.");
  if (!pid) return show("No payment found", "We couldn't see a completed payment in this link. If you paid, check your invoices in a few minutes.");

  const { data: { session } } = await db.auth.getSession();
  if (!session) { location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search)); return; }

  for (let i = 0; i < 5; i++) {
    const { data, error } = await db.functions.invoke("verify-payment", { body: { pid, ...(shortUrl && ref ? { short_url: shortUrl, payment_reference: ref } : {}) } });
    const st = error ? "error" : data?.status;
    if (st === "paid" || st === "failed" || st === "review") return show(...SHOW[st]);
    if (st === "error") return show("Couldn't check your payment", "Please check your invoices in a few minutes. If you were charged, we will update it.");
    show(...SHOW.pending); await new Promise((r) => setTimeout(r, 3000));
  }
  show(...SHOW.pending);
}
run();
