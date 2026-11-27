"""Public order page: account sign-up mode and request mode; preselection, summary, validation, requests sent, outcomes."""
import json, re, sys
from playwright.sync_api import sync_playwright
from e2e_support import serve

fails = 0
def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)))
    if not ok: fails += 1

srv = serve(8097); BASE = "http://127.0.0.1:8097"
cfg = open("../portal/js/config.js").read()
URL = re.search(r'https://[a-z0-9-]+\.supabase\.co', cfg).group(0)
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}

with sync_playwright() as pw:
    b = pw.chromium.launch()
    for label, vp in (("desktop", dict(width=1280, height=900)), ("phone", dict(width=390, height=800))):
        ctx = b.new_context(viewport=vp); page = ctx.new_page()
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        signups = []; rpcs = []; state = {"signup": "ok", "rpc": "ok"}
        def handle(route):
            r = route.request
            if r.method == "OPTIONS": return route.fulfill(status=204, headers=CORS)
            if "/auth/v1/signup" in r.url:
                signups.append((r.url, dict(r.headers), json.loads(r.post_data)))
                if state["signup"] == "ok": return route.fulfill(status=200, content_type="application/json", headers=CORS, body=json.dumps({"id": "u1", "email": "x"}))
                code = {"weak": (422, "weak_password"), "limit": (429, "over_email_send_rate_limit"), "off": (422, "signup_disabled"), "boom": (500, "unexpected_failure")}[state["signup"]]
                return route.fulfill(status=code[0], content_type="application/json", headers=CORS, body=json.dumps({"error_code": code[1], "msg": "secret internal detail"}))
            if "/rpc/submit_order" in r.url:
                rpcs.append((dict(r.headers), json.loads(r.post_data)))
                if state["rpc"] == "ok": return route.fulfill(status=200, content_type="application/json", headers=CORS, body=json.dumps({"ok": True, "reference": "AB12CD34"}))
                if state["rpc"] == "limit": return route.fulfill(status=400, content_type="application/json", headers=CORS, body=json.dumps({"code": "P0001", "message": "Too many requests. Please try again later or message us on WhatsApp."}))
                return route.fulfill(status=500, content_type="application/json", headers=CORS, body=json.dumps({"code": "XX000", "message": "secret internal detail"}))
            return route.fulfill(status=404, headers=CORS, body="{}")
        ctx.route(URL + "/**", handle)
        ctx.route(re.compile(r"https://fonts\..*"), lambda r: r.fulfill(status=200, body=""))

        page.goto(BASE + "/order.html?plan=hosting-monthly&plan=email-starter-monthly"); page.wait_for_selector("#orderForm")
        check(f"[{label}] plans from the services link are preselected", page.input_value("#f-hosting") == "hosting-monthly" and page.input_value("#f-email-plan") == "email-starter-monthly")
        check(f"[{label}] summary totals the first invoice", "$20" in page.inner_text("#summary"), page.inner_text("#summary"))
        page.select_option("#f-email-plan", "email-professional-yearly")
        check(f"[{label}] summary updates when the plan changes", "$265" in page.inner_text("#summary"), page.inner_text("#summary"))
        check(f"[{label}] no sideways scroll", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
        check(f"[{label}] account mode is the default (password fields shown, notes hidden)", page.is_visible("#f-pass") and page.is_visible("#f-pass2") and not page.is_visible("#f-notes"))

        # ---- validation (account mode) ----
        page.select_option("#f-hosting", ""); page.select_option("#f-email-plan", "")
        page.click("#orderBtn"); check(f"[{label}] a plan is required", page.is_visible("#orderError") and "plan" in page.inner_text("#orderError").lower() and not signups)
        page.select_option("#f-hosting", "hosting-yearly"); page.click("#orderBtn")
        check(f"[{label}] name is required", "name" in page.inner_text("#orderError").lower() and not signups)
        page.fill("#f-name", "Tendai Moyo"); page.fill("#f-email", "nope"); page.click("#orderBtn")
        check(f"[{label}] email is validated before sending", "email" in page.inner_text("#orderError").lower() and not signups)
        page.fill("#f-email", "Tendai@Moyo.test"); page.fill("#f-pass", "short"); page.fill("#f-pass2", "short"); page.click("#orderBtn")
        check(f"[{label}] short passwords are refused before sending", "10 characters" in page.inner_text("#orderError") and not signups)
        page.fill("#f-pass", "a-long-password-1"); page.fill("#f-pass2", "a-long-password-2"); page.click("#orderBtn")
        check(f"[{label}] mismatched passwords are refused before sending", "do not match" in page.inner_text("#orderError") and not signups)
        page.fill("#f-pass2", "a-long-password-1")
        page.evaluate("document.querySelector('[name=_honey]').value='bot'"); page.click("#orderBtn"); page.wait_for_timeout(300)
        check(f"[{label}] honeypot submissions are not sent", not signups)
        page.evaluate("document.querySelector('[name=_honey]').value=''")

        # ---- error mapping ----
        for st, needle in (("weak", "too easy to guess"), ("limit", "Too many attempts"), ("off", "not switched on"), ("boom", "WhatsApp")):
            state["signup"] = st; page.click("#orderBtn"); page.wait_for_function("document.querySelector('#orderError').textContent.length > 0 && !document.querySelector('#orderError').hidden")
            page.wait_for_timeout(150); txt = page.inner_text("#orderError")
            check(f"[{label}] sign-up error '{st}' shows a friendly message and no server detail", needle in txt and "secret internal detail" not in txt, txt)

        # ---- success ----
        page.fill("#f-business", "Moyo Traders"); page.fill("#f-domain", "moyo.co.zw"); page.fill("#f-phone", "+263771111111")
        state["signup"] = "ok"; signups.clear(); page.click("#orderBtn"); page.wait_for_selector("#doneAccount:visible")
        url, hdr, body = signups[-1]
        check(f"[{label}] sign-up uses the public key only", "apikey" in hdr and "authorization" not in {k.lower() for k in hdr})
        check(f"[{label}] confirmation link comes back to the login page", "redirect_to=" in url and "login.html%3Fconfirmed%3D1" in url, url)
        check(f"[{label}] email is lowercased and the password is sent", body["email"] == "tendai@moyo.test" and body["password"] == "a-long-password-1")
        d = body["data"]
        check(f"[{label}] metadata carries plans and details only (no role, client or price)",
              d["order_plans"] == ["hosting-yearly"] and d["business"] == "Moyo Traders" and d["domain"] == "moyo.co.zw" and d["full_name"] == "Tendai Moyo"
              and not ({"role", "client_id", "price", "price_cents", "amount"} & set(d)), d)
        check(f"[{label}] success tells them to check their email", "tendai@moyo.test" in page.inner_text("#orderDone") and "Check your email" in page.inner_text("#orderDone"))
        check(f"[{label}] the form is hidden after success", not page.is_visible("#orderForm"))
        check(f"[{label}] no console/page errors (account mode)", not errors, errors)

        # ---- request mode ----
        page.goto(BASE + "/order.html?plan=hosting-monthly"); page.wait_for_selector("#orderForm")
        page.click("#modeBtn")
        check(f"[{label}] request mode hides the password fields and shows notes", not page.is_visible("#f-pass") and page.is_visible("#f-notes"))
        page.fill("#f-name", "Tendai Moyo"); page.fill("#f-email", "tendai@moyo.test")
        state["rpc"] = "limit"; page.click("#orderBtn"); page.wait_for_selector("#orderError:visible")
        check(f"[{label}] request: server validation messages are shown", "Too many requests" in page.inner_text("#orderError"))
        state["rpc"] = "boom"; page.click("#orderBtn"); page.wait_for_timeout(400)
        check(f"[{label}] request: other errors never leak details", "secret internal detail" not in page.inner_text("#orderError") and "WhatsApp" in page.inner_text("#orderError"))
        state["rpc"] = "ok"; rpcs.clear(); signups.clear(); page.fill("#f-notes", "<b>hi</b>"); page.click("#orderBtn"); page.wait_for_selector("#doneRequest:visible")
        hdr, body = rpcs[-1]
        check(f"[{label}] request: plans and details are sent, no price, no sign-up call", body["p_plans"] == ["hosting-monthly"] and not any("price" in k or "amount" in k for k in body) and not signups, body)
        check(f"[{label}] request: success shows the reference and a WhatsApp link", "AB12CD34" in page.inner_text("#orderDone") and "AB12CD34" in page.get_attribute("#orderWa", "href"))
        check(f"[{label}] no console/page errors (request mode)", not errors, errors)
        ctx.close()

    # services page links
    ctx = b.new_context(); page = ctx.new_page(); ctx.route(re.compile(r"https://fonts\..*"), lambda r: r.fulfill(status=200, body=""))
    page.goto(BASE + "/services.html")
    links = page.eval_on_selector_all("a[href^='order.html']", "els => els.map(e => e.getAttribute('href'))")
    check("services page has 7 Get started links", len(links) == 7, links)
    check("combo cards preselect hosting and email", "order.html?plan=hosting-monthly&plan=email-business-monthly" in links)
    check("WhatsApp is still offered as a secondary link", page.locator("a.plan-alt").count() == 7)
    b.close()

print(f"\n{'FAILED' if fails else 'ok'}: {fails} failure(s)")
sys.exit(1 if fails else 0)
