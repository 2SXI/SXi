import { CONFIG } from "./portal/js/config.js";

const PRICES = { // display only. The server uses its own price list.
  "hosting-monthly": ["Hosting & Care (monthly)", 1500], "hosting-yearly": ["Hosting & Care (yearly)", 12000],
  "email-starter-monthly": ["Email Starter (monthly)", 500], "email-starter-yearly": ["Email Starter (yearly)", 5000],
  "email-business-monthly": ["Email Business (monthly)", 800], "email-business-yearly": ["Email Business (yearly)", 8000],
  "email-professional-monthly": ["Email Professional (monthly)", 2500], "email-professional-yearly": ["Email Professional (yearly)", 25000],
};
const $ = (s) => document.querySelector(s);
const form = $("#orderForm"), summary = $("#summary"), errBox = $("#orderError"), btn = $("#orderBtn");
const usd = (c) => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);
const configured = !/YOUR-PROJECT|YOUR-ANON/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_ANON_KEY);

// Pre-select from the link on the services page: order.html?plan=hosting-monthly&plan=email-starter-yearly
for (const p of new URLSearchParams(location.search).getAll("plan")) {
  const sel = p.startsWith("hosting-") ? form.hosting : p.startsWith("email-") ? form.email_plan : null;
  if (sel && PRICES[p]) sel.value = p;
}

const chosen = () => [form.hosting.value, form.email_plan.value].filter(Boolean);
function drawSummary() {
  const rows = chosen();
  summary.textContent = "";
  if (!rows.length) { const p = document.createElement("div"); p.className = "empty"; p.textContent = "Choose a plan to see your first invoice."; summary.append(p); return; }
  let total = 0;
  for (const k of rows) {
    const [name, cents] = PRICES[k]; total += cents;
    const r = document.createElement("div"); r.className = "row";
    const a = document.createElement("span"); a.textContent = name; const b = document.createElement("span"); b.textContent = usd(cents);
    r.append(a, b); summary.append(r);
  }
  const t = document.createElement("div"); t.className = "row total";
  const a = document.createElement("span"); a.textContent = "First invoice"; const b = document.createElement("span"); b.textContent = usd(total);
  t.append(a, b); summary.append(t);
}
form.hosting.addEventListener("change", drawSummary); form.email_plan.addEventListener("change", drawSummary); drawSummary();

const fail = (m) => { errBox.textContent = m; errBox.hidden = false; errBox.scrollIntoView({ block: "nearest", behavior: "smooth" }); };

// Two modes. "account" (default): create a login, confirm the email, then the portal shows the invoice.
// "request": no account; staff set it up and send the invoice.
let mode = "account";
function setMode(m) {
  mode = m; errBox.hidden = true;
  document.querySelectorAll("[data-mode]").forEach((el) => { el.hidden = el.dataset.mode !== m; });
  btn.firstChild.textContent = m === "account" ? "Create my account " : "Send my request ";
  $("#modeBtn").textContent = m === "account" ? "Prefer us to set it up for you? Send a request instead." : "Back: create my account now instead.";
}
$("#modeBtn").addEventListener("click", () => setMode(mode === "account" ? "request" : "account"));
setMode("account");

const finish = (which) => { form.hidden = true; $(".contact-info").hidden = true; $("#orderDone").hidden = false; $(which).hidden = false; $("#orderDone").scrollIntoView({ behavior: "smooth", block: "start" }); };

async function createAccount(plans, name, email) {
  const pw = form.password.value;
  if (pw.length < 10) return fail("Please choose a password of at least 10 characters.");
  if (pw !== form.password2.value) return fail("The two passwords do not match.");
  const redirect = new URL("login.html?confirmed=1", location.href).href;
  const res = await fetch(CONFIG.SUPABASE_URL + "/auth/v1/signup?redirect_to=" + encodeURIComponent(redirect), {
    method: "POST", headers: { "Content-Type": "application/json", apikey: CONFIG.SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password: pw, data: { full_name: name, business: form.business.value.trim(), phone: form.phone.value.trim(),
      domain: form.domain.value.trim(), order_plans: plans } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.error_code === "weak_password") return fail("That password is too easy to guess. Please choose a longer, less common one.");
    if (res.status === 429 || body.error_code === "over_email_send_rate_limit" || body.error_code === "over_request_rate_limit") return fail("Too many attempts. Please wait a few minutes and try again.");
    if (body.error_code === "signup_disabled") return fail("Online sign-up is not switched on yet. Please send a request instead, or message us on WhatsApp.");
    return fail("Sorry, we could not create your account. Please try again or message us on WhatsApp.");
  }
  // Same screen whether or not the email already had an account (no account enumeration).
  $("#doneEmail").textContent = email; finish("#doneAccount");
}

async function sendRequest(plans, name, email) {
  const res = await fetch(CONFIG.SUPABASE_URL + "/rest/v1/rpc/submit_order", {
    method: "POST", headers: { "Content-Type": "application/json", apikey: CONFIG.SUPABASE_ANON_KEY },
    body: JSON.stringify({ p_contact_name: name, p_company_name: form.business.value, p_email: email, p_phone: form.phone.value,
      p_domain: form.domain.value, p_plans: plans, p_notes: form.notes.value }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // our own validation messages are safe to show; anything else gets a generic message
    return fail(body && body.code === "P0001" && body.message ? body.message : "Sorry, we could not send your request. Please try again or message us on WhatsApp.");
  }
  $("#orderRef").textContent = body.reference;
  $("#orderWa").href = "https://wa.me/263781053299?text=" + encodeURIComponent("Hi SXI Digital, I just placed order " + body.reference + ".");
  finish("#doneRequest");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault(); errBox.hidden = true;
  if (form._honey.value) return;                       // bots fill the hidden field
  const plans = chosen();
  const name = form.name.value.trim(), email = form.email.value.trim().toLowerCase();
  if (!plans.length) return fail("Please choose a hosting or email plan.");
  if (!name) return fail("Please enter your name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Please enter a valid email address.");
  if (!configured) return fail("Online orders are not switched on yet. Please message us on WhatsApp.");
  btn.disabled = true;
  try { await (mode === "account" ? createAccount(plans, name, email) : sendRequest(plans, name, email)); }
  catch { fail("Could not reach the server. Check your connection or message us on WhatsApp."); }
  finally { btn.disabled = false; }
});
