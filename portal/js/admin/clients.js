import { db, q, html, raw, $, $$, toast, money, fmtDate, timeAgo, pill, icon, confirmDialog, titleCase } from "../core.js";
import { lookup, bust, formDialog, listPage, adminError } from "./kit.js";

const FIELDS = [
  { name: "company_name", label: "Company", required: true, max: 200 }, { name: "contact_name", label: "Contact person", max: 200 },
  { name: "email", label: "Email", max: 320 }, { name: "phone", label: "Phone", max: 40 },
  { name: "address", label: "Address", type: "textarea", max: 1000 },
  { name: "status", label: "Account status", type: "select", required: true, options: [["active", "Active"], ["suspended", "Suspended"], ["archived", "Archived"]], default: "active" },
];

export async function render(ctx, id) {
  if (id && id !== "new") return detail(ctx, id);
  const rows = await q(db.from("clients").select("*").order("company_name").limit(1000));
  const add = () => formDialog({ title: "Add client", fields: FIELDS, onSave: async (v) => {
    const c = await q(db.from("clients").insert(v).select("id").single()); bust(); toast("Client added.", "ok"); ctx.go("#/clients/" + c.id);
  } });
  const page = listPage({
    title: "Clients", sub: "Every company you look after.", rows, searchText: (r) => `${r.company_name} ${r.contact_name || ""} ${r.email || ""}`,
    statuses: ["active", "suspended", "archived"], statusOf: (r) => r.status, addLabel: "Add client", onAdd: add, onOpen: (r) => ctx.go("#/clients/" + r.id),
    cols: [{ label: "Company", cell: (r) => html`<strong>${r.company_name}</strong><div class="meta">${r.contact_name || ""}</div>` },
      { label: "Email", cell: (r) => r.email || "—", hideM: true }, { label: "Since", cell: (r) => fmtDate(r.created_at.slice(0, 10)), hideM: true },
      { label: "Status", cell: (r) => pill("account", r.status) }],
  });
  return { title: "Clients", ...page, mount: (v) => { page.mount(v); if (id === "new") { history.replaceState(null, "", "#/clients"); add(); } } };
}

async function detail(ctx, id) {
  const c = await q(db.from("clients").select("*").eq("id", id).maybeSingle());
  if (!c) throw new Error("Client not found");
  const [users, domains, hosting, sites, mail, invoices, tickets, services, notes] = await Promise.all([
    q(db.from("profiles").select("id,email,full_name,is_active").eq("client_id", id)),
    q(db.from("domains").select("id,name,status,expires_at").eq("client_id", id).order("name")),
    q(db.from("hosting_accounts").select("id,plan_name,status").eq("client_id", id)),
    q(db.from("websites").select("id,name,status").eq("client_id", id)),
    q(db.from("email_accounts").select("id,address,status").eq("client_id", id)),
    q(db.from("invoices").select("id,number,status,total_cents,currency,due_date").eq("client_id", id).order("created_at", { ascending: false }).limit(10)),
    q(db.from("support_tickets").select("id,subject,status").eq("client_id", id).order("updated_at", { ascending: false }).limit(10)),
    q(db.from("services").select("id,name,status").eq("client_id", id)),
    q(db.from("internal_notes").select("id,body,created_at").eq("entity_type", "client").eq("entity_id", id).order("created_at", { ascending: false })),
  ]);
  const section = (title, items, route, line) => html`<div class="card"><div class="card-head"><h2>${title}</h2><span class="faint">${items.length}</span></div>
    ${items.length ? html`<div class="list">${items.map((i) => html`<a class="item" href="${route(i)}"><div class="item-main">${line(i)}</div></a>`)}</div>` : html`<p class="faint">None yet.</p>`}</div>`;
  const out = html`<a class="back" href="#/clients">${icon("back")}All clients</a>
    <div class="page-head"><div><h1>${c.company_name}</h1><p>${pill("account", c.status)} <span class="faint">· client since ${fmtDate(c.created_at.slice(0, 10))}</span></p></div>
      <div class="row"><button class="btn btn-ghost" data-edit type="button">Edit details</button><button class="btn btn-primary" data-invoice type="button">${icon("plus")}New invoice</button></div></div>
    <div class="grid cols-2">
      <div class="card"><div class="card-head"><h2>Contact</h2></div><dl class="kv"><dt>Contact</dt><dd>${c.contact_name || "—"}</dd><dt>Email</dt><dd>${c.email || "—"}</dd><dt>Phone</dt><dd>${c.phone || "—"}</dd><dt>Address</dt><dd>${c.address || "—"}</dd></dl></div>
      <div class="card"><div class="card-head"><h2>Logins</h2></div>
        ${users.length ? html`<div class="list">${users.map((u) => html`<div class="item"><div class="item-main"><div class="title">${u.full_name || u.email}</div><div class="meta">${u.email}</div></div>${u.is_active ? "" : pill("account", "suspended")}</div>`)}</div>` : html`<p class="faint">No login linked yet.</p>`}
        <form class="form mt-l" data-link novalidate><div class="field"><label for="link-email">Link a login by email</label>
          <input class="input" id="link-email" type="email" placeholder="them@company.co.zw" autocomplete="off"><span class="hint">Create the user first in Supabase → Authentication → Users, then link it here.</span></div>
          <div class="row"><button class="btn btn-ghost" type="submit">Link login</button></div></form></div>
      ${section("Services", services, () => "#/services", (s) => html`<div class="title">${s.name}</div>`)}
      ${section("Domains", domains, () => "#/domains", (d) => html`<div class="title">${d.name}</div><div class="meta">Expires ${fmtDate(d.expires_at)}</div>`)}
      ${section("Hosting", hosting, () => "#/hosting", (h) => html`<div class="title">${h.plan_name || "Hosting"}</div><div class="meta">${titleCase(h.status)}</div>`)}
      ${section("Websites", sites, () => "#/websites", (w) => html`<div class="title">${w.name}</div><div class="meta">${titleCase(w.status)}</div>`)}
      ${section("Mailboxes", mail, () => "#/email", (m) => html`<div class="title">${m.address}</div>`)}
      ${section("Invoices", invoices, (i) => "#/invoices/" + i.id, (i) => html`<div class="title">${i.number}</div><div class="meta">${money(i.total_cents, i.currency)} · ${titleCase(i.status)}</div>`)}
      ${section("Support tickets", tickets, (t) => "#/support/" + t.id, (t) => html`<div class="title">${t.subject}</div><div class="meta">${titleCase(t.status)}</div>`)}
      <div class="card notes"><div class="card-head"><h2>Private notes</h2><span class="faint">Staff only</span></div>
        ${notes.map((n) => html`<div class="note"><div class="pre">${n.body}</div><div class="meta faint">${fmtDate(n.created_at.slice(0, 10))}</div></div>`)}
        <form class="form mt" data-note novalidate><textarea class="input" id="cnote" maxlength="10000" aria-label="New private note" placeholder="Add a note about this client…"></textarea><div class="row"><button class="btn btn-ghost" type="submit">Add note</button></div></form></div>
    </div>`;
  const mount = (view) => {
    $("[data-edit]", view).onclick = () => formDialog({ title: "Edit client", fields: FIELDS, row: c, onSave: async (v) => { await q(db.from("clients").update(v).eq("id", id)); bust(); toast("Saved.", "ok"); ctx.reload(); } });
    $("[data-note]", view).addEventListener("submit", async (e) => { e.preventDefault(); const body = $("#cnote", view).value.trim(); if (!body) return;
      try { await q(db.from("internal_notes").insert({ entity_type: "client", entity_id: id, client_id: id, body, author_id: ctx.profile.id })); toast("Note added.", "ok"); ctx.reload(); } catch (err) { toast(adminError(err), "error"); } });
    $("[data-invoice]", view).onclick = () => ctx.newInvoice(id);
    $("[data-link]", view).addEventListener("submit", async (e) => {
      e.preventDefault(); const em = $("#link-email", view).value.trim(); if (!em) return toast("Enter the login's email.", "error");
      try { await q(db.rpc("staff_link_user_by_email", { p_email: em, p_client_id: id })); toast("Login linked.", "ok"); ctx.reload(); } catch (err) { toast(adminError(err), "error"); }
    });
  };
  return { title: c.company_name, html: out, mount };
}
