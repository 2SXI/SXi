"""Public order page: preselection, summary, validation, the request that is sent, success and error states."""
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

with sync_playwright() as pw:
    b = pw.chromium.launch()
    for label, vp in (("desktop", dict(width=1280, height=900)), ("phone", dict(width=390, height=800))):
        ctx = b.new_context(viewport=vp); page = ctx.new_page()
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        sent = []; mode = {"v": "ok"}
        def rpc(route, request):
            sent.append((request.headers, json.loads(request.post_data)))
            if mode["v"] == "ok": return route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "reference": "AB12CD34"}), headers={"access-control-allow-origin": "*"})
            if mode["v"] == "limit": return route.fulfill(status=400, content_type="application/json", body=json.dumps({"code": "P0001", "message": "Too many requests. Please try again later or message us on WhatsApp."}), headers={"access-control-allow-origin": "*"})
            return route.fulfill(status=500, content_type="application/json", body=json.dumps({"code": "XX000", "message": "secret internal detail"}), headers={"access-control-allow-origin": "*"})
        ctx.route(URL + "/rest/v1/rpc/submit_order", lambda r, q=None: rpc(r, r.request))
        ctx.route(re.compile(r"https://fonts\..*"), lambda r: r.fulfill(status=200, body=""))
        # CORS preflight
        ctx.route(URL + "/**", lambda r: r.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}) if r.request.method == "OPTIONS" else r.fallback())

        page.goto(BASE + "/order.html?plan=hosting-monthly&plan=email-starter-monthly")
        page.wait_for_selector("#orderForm")
        check(f"[{label}] plans from the services link are preselected", page.input_value("#f-hosting") == "hosting-monthly" and page.input_value("#f-email-plan") == "email-starter-monthly")
        check(f"[{label}] summary totals the first invoice", "$20" in page.inner_text("#summary"), page.inner_text("#summary"))
        page.select_option("#f-email-plan", "email-professional-yearly")
        check(f"[{label}] summary updates when the plan changes", "$265" in page.inner_text("#summary"), page.inner_text("#summary"))
        check(f"[{label}] no sideways scroll", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))

        page.select_option("#f-hosting", ""); page.select_option("#f-email-plan", "")
        page.click("#orderBtn"); check(f"[{label}] a plan is required", page.is_visible("#orderError") and "plan" in page.inner_text("#orderError").lower() and not sent)
        page.select_option("#f-hosting", "hosting-yearly"); page.click("#orderBtn")
        check(f"[{label}] name is required", "name" in page.inner_text("#orderError").lower() and not sent)
        page.fill("#f-name", "Tendai Moyo"); page.fill("#f-email", "nope"); page.click("#orderBtn")
        check(f"[{label}] email is validated before sending", "email" in page.inner_text("#orderError").lower() and not sent)

        # honeypot: silently dropped
        page.fill("#f-email", "tendai@moyo.test"); page.evaluate("document.querySelector('[name=_honey]').value='bot'"); page.click("#orderBtn")
        page.wait_for_timeout(300); check(f"[{label}] honeypot submissions are not sent", not sent)
        page.evaluate("document.querySelector('[name=_honey]').value=''")

        mode["v"] = "limit"; page.click("#orderBtn"); page.wait_for_selector("#orderError:visible")
        check(f"[{label}] validation messages from the server are shown", "Too many requests" in page.inner_text("#orderError"))
        mode["v"] = "boom"; page.click("#orderBtn"); page.wait_for_timeout(500)
        check(f"[{label}] other server errors never leak details", "secret internal detail" not in page.inner_text("#orderError") and "WhatsApp" in page.inner_text("#orderError"))

        page.fill("#f-business", "Moyo Traders"); page.fill("#f-domain", "moyo.co.zw"); page.fill("#f-notes", "<b>hi</b>")
        mode["v"] = "ok"; sent.clear(); page.click("#orderBtn"); page.wait_for_selector("#orderDone:visible")
        hdr, body = sent[-1]
        check(f"[{label}] request uses the public key header only", "apikey" in hdr and "authorization" not in {k.lower() for k in hdr})
        check(f"[{label}] request carries plans and details but no price", body["p_plans"] == ["hosting-yearly"] and body["p_email"] == "tendai@moyo.test" and body["p_domain"] == "moyo.co.zw" and not any("price" in k or "amount" in k for k in body), body)
        check(f"[{label}] success screen shows the reference and a WhatsApp link", "AB12CD34" in page.inner_text("#orderDone") and "AB12CD34" in page.get_attribute("#orderWa", "href"))
        check(f"[{label}] the form is hidden after success", not page.is_visible("#orderForm"))
        check(f"[{label}] no console/page errors", not errors, errors)
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
