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
let holdSearch = "";
let releaseSearch;
const searchRoster = [{id:"12345678",name:"Latest Player"},{id:"22222222",name:"Second Player"}];
const uscfRequests = [];
await page.setRequestInterception(true);
page.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.hostname.endsWith("uschess.org")) uscfRequests.push(request.url());
  if (url.pathname === "/register.js") {
    request.respond({ contentType: "text/javascript", body: offline(await (await fetch(base + "/register.js")).text()) });
  } else if (url.pathname === "/stripe-payment-links.json") {
    request.respond({ contentType: "application/json", body: JSON.stringify(config) });
  } else if (url.host === "registration.test") {
    const fields = Object.fromEntries(new URLSearchParams(request.postData()));
    calls.push(fields);
    if (fields.action === "paymentBalances" && fields.id === holdId) await new Promise((resolve) => { release = resolve; });
    if (fields.action === "paymentPlayers" && fields.q === holdSearch) await new Promise(resolve => { releaseSearch = resolve; });
    const body = fields.action === "paymentPlayers" ? {ok:true,players:searchRoster.filter(p => /^\d+$/.test(fields.q) ? p.id.startsWith(fields.q) : fields.q.toLowerCase().split(/\s+/).every(w => p.name.toLowerCase().includes(w)))} : fields.action === "paymentBalances" ? { ok: true, id: fields.id, name: fields.id === "12345678" ? "Latest Player" : "Second Player", currency: "usd",
      entries: [{ event: "club-night", date: "2026-11", name: "Club Night", balanceCents: 1750, review: false },
        { event: "classic", date: "2025-05-01", name: "Past Classic", balanceCents: 750, review: false },
        { event: "paid", date: "2027-05-01", name: "Paid Event", balanceCents: 0, review: false },
        { event: "unknown", date: "2027-06-01", name: "Unknown Fee", balanceCents: null, review: false },
        { event: "review", date: "2027-07-01", name: "Review Event", balanceCents: 1750, review: true }], totalCents: 4250, unknownCount: 1 }
      : { ok: true, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_fixture", count: JSON.parse(fields.entries).length,
        amount: JSON.parse(fields.entries).reduce((n,e) => n + (e.event === "club-night" ? 1750 : 750),0), currency: "usd", livemode: false };
    if (fields.action === "paymentBalances" && fields.id === "00000000") Object.assign(body,{name:"",entries:[],totalCents:0,unknownCount:0});
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
const query = async (text) => {
  await page.$eval("#pay-id", (el, value) => {el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));}, text);
};
await page.$eval("#pay-remember", el => {el.checked=false;});
await query("latest pl");
await page.waitForSelector("#pay-players [role=option]");
(await page.$eval("#pay-players", el => el.textContent.includes("Latest Player") && el.textContent.includes("12345678")))
  ? pass("Payment name search finds matching club registrations") : fail("Name search did not show club match");
await page.focus("#pay-id");
await page.keyboard.press("ArrowDown");
(await page.$eval("#pay-id",el=>el.getAttribute("aria-activedescendant")))
  ? pass("Player search keyboard highlights a matching option") : fail("No active player option");
await page.keyboard.press("Enter");
await page.waitForFunction(()=>document.querySelector("#pay-id").value==="12345678" && document.querySelector("#pay-players").hidden);
await page.waitForNetworkIdle();
calls.at(-1).action === "paymentBalances" && calls.at(-1).id === "12345678"
  ? pass("Keyboard selection loads the selected player's exact ID balances") : fail("Selection loaded wrong player");
await query("222");
await page.waitForFunction(()=>document.querySelector("#pay-players").textContent.includes("Second Player") && !document.querySelector("#pay-players").hidden);
await page.click("#pay-players [role=option]");
await page.waitForNetworkIdle();
(await page.$eval("#pay-id",el=>el.value)) === "22222222"
  ? pass("ID-prefix search and pointer selection use club records") : fail("ID-prefix selection failed");
await query("Nobody Registered");
await page.waitForFunction(()=>document.querySelector("#pay-status").textContent.includes("No matching players"));
pass("Unmatched names explain the club-only search scope");
const searchesBefore=calls.filter(c=>c.action==="paymentPlayers").length;
await query("x");
await page.waitForNetworkIdle();
calls.filter(c=>c.action==="paymentPlayers").length===searchesBefore && (await page.$eval("#pay-players",el=>el.hidden))
  ? pass("Short queries clear suggestions without a backend search") : fail("Short query searched or kept stale list");
holdSearch="latest";
await query("latest");
await page.waitForFunction(()=>document.querySelector("#pay-status").textContent.includes("Searching club"));
while (!releaseSearch) await new Promise(resolve=>setTimeout(resolve,10));
await query("second");
await page.waitForFunction(()=>!document.querySelector("#pay-players").hidden && document.querySelector("#pay-players").textContent.includes("Second Player"));
releaseSearch();holdSearch="";
await page.waitForNetworkIdle();
(await page.$eval("#pay-players",el=>el.textContent.includes("Second Player") && !el.textContent.includes("Latest Player")))
  ? pass("Late name-search replies cannot replace newer matches") : fail("Stale search response replaced matches");
await page.focus("#pay-id");await page.keyboard.press("Escape");
(await page.$eval("#pay-id",el=>el.getAttribute("aria-expanded")==="false" && !el.hasAttribute("aria-activedescendant")))
  ? pass("Escape closes the player search accessibly") : fail("Escape did not close combobox");
await page.$eval("#pay-id",el=>{el.value="12345678";el.dispatchEvent(new Event("input",{bubbles:true}));});
await press(page,"#pay-form button[type=submit]");await page.waitForNetworkIdle();
calls.at(-1).action === "paymentBalances" && calls.at(-1).id === "12345678" && uscfRequests.length===0 && !calls.some(c=>c.action==="search")
  ? pass("Full IDs still load directly and payment searches never call US Chess") : fail("Direct ID failed or US Chess was searched");
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
(await page.$eval('[data-player="33333333"]',el=>el.textContent.includes("Player from your payment link") && el.getAttribute("aria-label")==="Player from payment link"))
  ? pass("Texted payment links visibly identify the targeted player") : fail("Linked player not identified");
await page.goto(base + "/pay/?uscfid=44444444", {waitUntil:"networkidle0"});
(await page.$eval("#pay-id",el=>el.value))==="44444444" && (await page.$('[data-player="44444444"]'))
  && !(await page.evaluate(()=>JSON.parse(localStorage.getItem("lccc-register-players")))).some(p=>p.id==="44444444")
  ? pass("The uscfid URL alias preloads balances without saving the player") : fail("URL alias failed");
const beforeInvalid=calls.length;
await page.goto(base + "/pay/?id=not-an-id", {waitUntil:"networkidle0"});
!calls.slice(beforeInvalid).some(c=>c.id==="not-an-id") && (await page.$$("#pay-balances section")).length===2
  ? pass("Malformed URL IDs are ignored without a balance request") : fail("Invalid URL ID was used");
await page.goto(base + "/pay/?id=00000000", {waitUntil:"networkidle0"});
(await page.$eval('[data-player="00000000"]',el=>el.textContent.includes("No active registrations found")))
  && (await page.$eval("#pay-id",el=>el.value))==="00000000"
  ? pass("A texted valid ID with no registrations clearly shows no active entries") : fail("No-registration link did not explain empty balance");
await page.removeScriptToEvaluateOnNewDocument(seed.identifier);
await page.close();
await done();
