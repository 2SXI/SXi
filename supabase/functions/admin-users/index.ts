// Login service for the admin dashboard. Browser code can't create logins (that needs the service-role key),
// so staff ask this function, which checks WHO is asking before doing anything.
//   { action: "create_login", email, full_name?, mode: "invite"|"password", client_id? , role? }
//        client_id given -> a CLIENT login linked to that client (staff or admin may do this)
//        no client_id    -> a TEAM login; role must be "staff" or "admin" (admin only)
//   { action: "reset_link", user_id }   -> one-time password-reset link (staff: client logins only; admin: anyone)
// Deploy with "Verify JWT" ON. The caller's session is also checked in code.
import { cors, json, callerClient, serviceClient, isUuid, siteUrl } from "../_shared/http.ts";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const tempPassword = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";   // no look-alikes (0/O, 1/l/I)
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => chars[x % chars.length]).join("");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const caller = await callerClient(req);
    if (!caller) return json({ error: "Please sign in again." }, 401);

    const { data: me } = await caller.db.from("profiles").select("role,is_active").eq("id", caller.user.id).maybeSingle();
    if (!me?.is_active || !["staff", "admin"].includes(me.role)) return json({ error: "Not allowed." }, 403);
    const isAdmin = me.role === "admin";

    const svc = serviceClient();
    const { data: ok } = await svc.rpc("rate_limit_hit", { p_key: `adminusers:${caller.user.id}`, p_max: 30, p_window_seconds: 600 });
    if (!ok) return json({ error: "Too many attempts. Please wait a few minutes." }, 429);

    const b = await req.json().catch(() => ({}));

    // ---------------------------------------------------------------- create_login
    if (b?.action === "create_login") {
      const email = String(b.email ?? "").trim().toLowerCase();
      const fullName = String(b.full_name ?? "").trim().slice(0, 200);
      if (!EMAIL.test(email)) return json({ error: "Enter a valid email address." }, 400);
      if (!["invite", "password"].includes(b.mode)) return json({ error: "Choose how they get access." }, 400);

      let role: "client" | "staff" | "admin" = "client"; let clientId: string | null = null;
      if (b.client_id) {
        if (!isUuid(b.client_id)) return json({ error: "Invalid client." }, 400);
        const { data: c } = await svc.from("clients").select("id").eq("id", b.client_id).maybeSingle();
        if (!c) return json({ error: "Client not found." }, 404);
        clientId = c.id;
      } else {
        if (!isAdmin) return json({ error: "Only admins can add team members." }, 403);
        if (!["staff", "admin"].includes(b.role)) return json({ error: "Choose a role." }, 400);
        role = b.role;
      }

      let userId: string | undefined, password: string | undefined;
      if (b.mode === "invite") {
        const { data, error } = await svc.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName }, redirectTo: `${siteUrl()}/reset-password.html` });
        if (error) return fail(error.message);
        userId = data.user?.id;
      } else {
        password = tempPassword();
        const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
        if (error) return fail(error.message);
        userId = data.user?.id;
      }
      if (!userId) return json({ error: "Couldn't create the login." }, 500);

      // The signup trigger made a plain client profile; now set the real role / client link.
      const { error: upErr } = await svc.from("profiles").update({ role, client_id: clientId, ...(fullName ? { full_name: fullName } : {}) }).eq("id", userId);
      if (upErr) {
        console.error("admin-users: profile update failed", upErr.message);
        await svc.auth.admin.deleteUser(userId);   // don't leave a half-made login behind
        return json({ error: "Couldn't finish creating the login. Nothing was saved; please try again." }, 500);
      }
      return json(password ? { ok: true, temp_password: password } : { ok: true });
    }

    // ---------------------------------------------------------------- reset_link
    if (b?.action === "reset_link") {
      if (!isUuid(b.user_id)) return json({ error: "Invalid user." }, 400);
      const { data: target } = await svc.from("profiles").select("email,role").eq("id", b.user_id).maybeSingle();
      if (!target?.email) return json({ error: "User not found." }, 404);
      if (!isAdmin && target.role !== "client") return json({ error: "Only admins can reset team logins." }, 403);
      const { data, error } = await svc.auth.admin.generateLink({ type: "recovery", email: target.email, options: { redirectTo: `${siteUrl()}/reset-password.html` } });
      const link = data?.properties?.action_link;
      if (error || !link) { console.error("admin-users: generateLink failed", error?.message); return json({ error: "Couldn't make a reset link." }, 500); }
      return json({ ok: true, email: target.email, link });
    }

    if (b?.action === "new_agent_token") return json({ error: "The server agent isn't part of this version yet." }, 501);
    return json({ error: "Unknown request." }, 400);
  } catch (err) {
    console.error("admin-users", err);
    return json({ error: "Something went wrong." }, 500);
  }
});

function fail(msg: string) {
  console.error("admin-users: auth error", msg);
  if (/already|registered|exists/i.test(msg)) return json({ error: "A login with that email already exists." }, 409);
  if (/rate limit|too many/i.test(msg)) return json({ error: "Email sending limit reached. Wait a little, or use a temporary password instead." }, 429);
  return json({ error: "Couldn't create the login." }, 500);
}
