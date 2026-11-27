import { db, q, html, $, toast, fmtDateTime, timeAgo, confirmDialog } from "../core.js";
import { lookup, clientOptions, listPage, formDialog, bust } from "./kit.js";

const PLAN_LABEL = {
  "hosting-monthly": "Hosting & Care, monthly ($15)", "hosting-yearly": "Hosting & Care, yearly ($120)",
  "email-starter-monthly": "Email Starter, monthly ($5)", "email-starter-yearly": "Email Starter, yearly ($50)",
  "email-business-monthly": "Email Business, monthly ($8)", "email-business-yearly": "Email Business, yearly ($80)",
  "email-professional-monthly": "Email Professional, monthly ($25)", "email-professional-yearly": "Email Professional, yearly ($250)",
};
const plansText = (r) => (r.plans || []).map((p) => PLAN_LABEL[p] || p).join(" + ");
const pillO = (s) => html`<span class="pill ${s === "new" ? "warn" : s === "approved" ? "ok" : ""}">${s === "new" ? "New" : s === "approved" ? "Approved" : "Rejected"}</span>`;

export async function orders(ctx) {
  const [clients, rows] = await Promise.all([lookup("clients"), q(db.from("orders").select("*").order("created_at", { ascending: false }).limit(500))]);
  const page = listPage({
    title: "Orders", sub: "Requests from the website's Get started form. Approving one creates the client, services and invoice.", rows,
    onOpen: (r) => openOrder(ctx, r, clients), emptyIcon: "inbox", emptyText: "No orders yet.",
    statuses: ["new", "approved", "rejected"], statusOf: (r) => r.status,
    searchText: (r) => `${r.contact_name} ${r.company_name || ""} ${r.email} ${r.domain || ""} ${plansText(r)}`,
    cols: [{ label: "Order", cell: (r) => html`<strong>${r.company_name || r.contact_name}</strong><div class="meta">${r.contact_name} · ${r.email}${r.source === "signup" ? " · self-service" : ""}</div>` },
      { label: "Plans", cell: (r) => plansText(r), hideM: true }, { label: "Received", cell: (r) => timeAgo(r.created_at), hideM: true },
      { label: "Status", cell: (r) => pillO(r.status) }],
  });
  return { title: "Orders", ...page };
}

function openOrder(ctx, r, clients) {
  const isNew = r.status === "new";
  const details = html`<dl class="kv">
    <dt>Name</dt><dd>${r.contact_name}</dd>
    <dt>Business</dt><dd>${r.company_name || "—"}</dd>
    <dt>Email</dt><dd>${r.email}</dd>
    <dt>Phone</dt><dd>${r.phone || "—"}</dd>
    <dt>Website</dt><dd>${r.domain || "—"}</dd>
    <dt>Plans</dt><dd>${plansText(r)}</dd>
    <dt>Notes</dt><dd>${r.notes || "—"}</dd>
    <dt>Received</dt><dd>${fmtDateTime(r.created_at)}</dd></dl>`;
  const d = formDialog({
    title: isNew ? "Review order" : "Order", extra: details,
    submitText: isNew ? "Approve & send invoice" : r.client_id ? "Open client" : "Close",
    fields: isNew ? [{ name: "client_id", label: "Client", type: "select", options: clientOptions(clients), hint: "Leave blank to create a new client from this order. Choose an existing client if this person is already one of yours." }] : [],
    onSave: async (v) => {
      if (!isNew) { if (r.client_id) ctx.go("#/clients/" + r.client_id); return; }
      const res = await q(db.rpc("staff_approve_order", { p_order_id: r.id, p_client_id: v.client_id || null }));
      toast("Approved. The invoice has been sent. Next: create this client's login so they can pay.", "ok");
      bust(); ctx.go("#/clients/" + res.client_id);
    },
  });
  if (isNew) {
    const rej = document.createElement("button");
    rej.type = "button"; rej.className = "btn btn-danger grow-left"; rej.textContent = "Reject";
    rej.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Reject this order?", body: "Nothing is created. You can delete it later.", confirmText: "Reject", danger: true }))) return;
      try { await q(db.rpc("staff_reject_order", { p_order_id: r.id })); toast("Order rejected.", "ok"); d.close(); bust(); ctx.reload(); }
      catch (e) { toast(e.message || "Could not reject.", "bad"); }
    });
    $(".actions", d).prepend(rej);
  }
}
