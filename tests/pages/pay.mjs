import { axeBoth, base, browser, done, fail, fitsPhone, offline, pass, press } from "./common.mjs";

const page = await browser.newPage();
page.on("pageerror", (error) => fail(`Payment page JavaScript: ${error.message}`));
const config = { enabled: true, livemode: false, currency: "usd", dynamicCheckout: { enabled: true },
  entry: { amount: 1750, paymentLinkId: "plink_fixture", url: "https://buy.stripe.com/test_fixture" },
  donation: { paymentLinkId: "plink_donation", url: "https://buy.stripe.com/test_donation" } };
const saved = [{ id: "12345678", name: "Latest Player", last: "Player", email: "kept@example.com", phone: "5551234567" },
  { id: "22222222", name: "Second Player", last: "Second", email: "second@example.com" }];
const seed = await page.evaluateOnNewDocument((saved) => localStorage.setItem("lccc-register-players", JSON.stringify(saved)), saved);
const calls = [];
let holdId = "";
let release;
await page.setRequestInterception(true);
page.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    request.respond({ contentType: "text/javascript", body: offline(await (await fetch(base + "/register.js")).text()) });
  } else if (url.pathname === "/stripe-payment-links.json") {
    request.respond({ contentType: "application/json", body: JSON.stringify(config) });
  } else if (url.host === "registration.test") {
    const fields = Object.fromEntries(new URLSearchParams(request.postData()));
    calls.push(fields);
    if (fields.action === "paymentBalances" && fields.id === holdId) await new Promise((resolve) => { release = resolve; });
    const body = fields.action === "paymentBalances" ? { ok: true, id: fields.id, name: fields.id === "12345678" ? "Latest Player" : "Second Player", currency: "usd",
      entries: [{ event: "club-night", date: "2026-11", name: "Club Night", balanceCents: 1750, review: false },
        { event: "classic", date: "2025-05-01", name: "Past Classic", balanceCents: 750, review: false },
        { event: "paid", date: "2027-05-01", name: "Paid Event", balanceCents: 0, review: false },
        { event: "unknown", date: "2027-06-01", name: "Unknown Fee", balanceCents: null, review: false },
        { event: "review", date: "2027-07-01", name: "Review Event", balanceCents: 1750, review: true }], totalCents: 4250, unknownCount: 1 }
      : { ok: true, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_fixture", count: JSON.parse(fields.entries).length,
        amount: JSON.parse(fields.entries).reduce((n,e) => n + (e.event === "club-night" ? 1750 : 750),0), currency: "usd", livemode: false };
    request.respond({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  } else request.continue();
});
await page.goto(base + "/pay/?returned=1", { waitUntil: "networkidle0" });
await page.waitForFunction(() => document.querySelectorAll("#pay-balances section").length === 2);
const balanceText = await page.$eval("#pay-balances", (el) => el.textContent);
const checkedCount = () => page.$$eval(".pay-entry input:checked", (els) => els.length);
const totalText = () => page.$eval("#pay-selected-total", (el) => el.textContent);
calls.some((call) => call.id === "12345678") && calls.some((call) => call.id === "22222222")
  && balanceText.includes("$85.00") && balanceText.includes("subtotal") && balanceText.includes("2025-05-01")
  && balanceText.includes("Nothing owed") && balanceText.includes("Fee not set") && await checkedCount() === 4
  && (await totalText()).includes("$50.00")
  ? pass("All saved players load automatically with all payable entries selected; unknown, paid, review entries excluded") : fail(JSON.stringify({ calls, balanceText }));
await press(page, "#pay-deselect-all");
await checkedCount() === 0 && (await totalText()).includes("$0.00")
  ? pass("Deselect all clears the combined total") : fail("Deselect all failed");
await press(page, "#pay-select-all");
await checkedCount() === 4 ? pass("Select all restores eligible entries") : fail("Select all failed");
await press(page, "#pay-review");
await page.waitForSelector("#pay-checkout:not([hidden])");
const combined = calls.find(call => call.action === "createPaymentCheckout");
JSON.parse(combined.entries).length === 4 && (await page.$eval("#pay-summary", el => el.textContent)).includes("$50.00")
  ? pass("One exact-total checkout covers both players and every selected event") : fail("Combined checkout incorrect");
await press(page, "#pay-deselect-all");
await press(page, '[data-player="12345678"] .pay-entry input');
await checkedCount() === 1 && (await totalText()).includes("$17.50")
  ? pass("An individual checkbox selects just one entry") : fail("Single selection failed");
await press(page, "#pay-review");
await page.waitForSelector("#pay-checkout:not([hidden])");
const payment = calls.filter((call) => call.action === "createPaymentCheckout").at(-1);
JSON.parse(payment.entries)[0].id === "12345678" && JSON.parse(payment.entries)[0].date === "2026-11" && Object.keys(payment).length === 3
  && (await page.$eval("#pay-test", (el) => !el.hidden))
  ? pass("Single saved-player entry pays exact month without credentials and shows test mode") : fail(JSON.stringify(payment));
await axeBoth(page, "Saved player balances");
await page.setViewport({ width: 390, height: 844 });
await fitsPhone(page, "Saved player balances");
if (process.env.PAY_SCREENSHOT) await page.screenshot({ path: process.env.PAY_SCREENSHOT, fullPage: true });
// Forget a player while their refreshed balances are still loading.
holdId = "22222222";
await page.evaluate(() => [...document.querySelectorAll(".register-pick")].find((el) => el.textContent.includes("22222222")).click());
await page.waitForFunction(() => document.querySelector("#pay-id").value === "22222222");
(await page.$eval("#pay-checkout", (el) => el.hidden && !el.hasAttribute("href")))
  ? pass("Refreshing another player clears a stale checkout") : fail("Stale checkout after switching player");
await page.evaluate(() => [...document.querySelectorAll(".register-forget")].find((el) => el.textContent.includes("22222222")).click());
release();
holdId = "";
await page.waitForNetworkIdle();
(await page.$eval("#pay-balances", (el) => el.textContent.includes("Latest Player") && !el.textContent.includes("Second Player")))
  && await checkedCount() === 1
  ? pass("Forgetting a player invalidates late replies while preserving other selections") : fail("Forgotten player's late response reappeared");
await page.evaluate(() => [...document.querySelectorAll(".register-pick")].find((el) => el.textContent.includes("12345678")).click());
await page.waitForNetworkIdle();
await press(page, "#pay-form button[type=submit]");
await page.waitForNetworkIdle();
const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("lccc-register-players"))[0]);
kept.email === "kept@example.com" && kept.last === "Player" && kept.phone === "5551234567" && await checkedCount() === 1
  ? pass("Refreshing and remembering preserves credentials and individual selections") : fail(JSON.stringify(kept));
config.enabled = false;
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector("#pay-total");
(await page.$$(".pay-entry input")).length === 4 && (await page.$eval("#pay-review", (el) => el.disabled))
  && (await page.$eval("#donation-link", (el) => el.hidden))
  ? pass("All balances and selection remain available when Stripe checkout is disabled") : fail("Disabled Stripe prevented lookup or enabled checkout");
await page.goto(base + "/pay/?id=33333333", { waitUntil: "networkidle0" });
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("lccc-register-players")));
(await page.$eval("#pay-id", (el) => el.value)) === "33333333" && stored.length === 2 && !stored.some((p) => p.id === "33333333")
  && (await page.$$("#pay-balances section")).length === 3
  ? pass("Linked ID is added alongside saved players without being saved automatically") : fail("Linked ID missing or saved without request");
await page.removeScriptToEvaluateOnNewDocument(seed.identifier);
await page.close();
await done();
