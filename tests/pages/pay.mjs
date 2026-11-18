import { axeBoth, base, browser, done, fail, fitsPhone, offline, pass, press } from "./common.mjs";

const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  document.addEventListener("click", event => {
    if (event.target.id === "pay-checkout") { event.preventDefault(); window.checkoutNavigationAttempts = (window.checkoutNavigationAttempts || 0) + 1; }
  }, true);
});
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
let holdCheckout = false;
let releaseCheckout;
let checkoutFailure = false;
let balanceVariant = "";
let cardStatus = "succeeded", cardQuoteTampered = false, cardActionError = false;
let holdCardConfirm = false, releaseCardConfirm;
let serverTestPending = false;
const searchRoster = [{id:"12345678",name:"Latest Player"},{id:"22222222",name:"Second Player"}];
const uscfRequests = [];
await page.setRequestInterception(true);
page.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.hostname.endsWith("uschess.org")) uscfRequests.push(request.url());
  if (url.hostname === "js.stripe.com") {
    request.respond({ contentType: "text/javascript", body: `
      window.stripeMock={tokens:0,submits:0,actions:0,changes:null};
      window.Stripe=()=>({elements:options=>{window.stripeMock.options=options;return {
        create:()=>({on:(_name,fn)=>window.stripeMock.changes=fn,mount:selector=>document.querySelector(selector).textContent='Secure test card fields',destroy:()=>{document.querySelector('#pay-card-element').textContent='';}}),
        submit:async()=>{window.stripeMock.submits++;return {};}
      };},createConfirmationToken:async()=>{window.stripeMock.tokens++;return {confirmationToken:{id:'ctoken_fixture'}};},
        handleNextAction:async()=>{window.stripeMock.actions++;return window.stripeMock.actionError?{error:{message:'authentication failed'}}:{paymentIntent:{id:'pi_fixture',amount:window.stripeMock.amount,currency:'usd',status:'succeeded'}};}});
    ` });
  } else if (url.pathname === "/register.js") {
    request.respond({ contentType: "text/javascript", body: offline(await (await fetch(base + "/register.js")).text()) });
  } else if (url.pathname === "/stripe-payment-links.json") {
    request.respond({ contentType: "application/json", body: JSON.stringify(config) });
  } else if (url.host === "registration.test") {
    const fields = Object.fromEntries(new URLSearchParams(request.postData()));
    calls.push(fields);
    if (fields.action === "paymentBalances" && fields.id === holdId) await new Promise((resolve) => { release = resolve; });
    if (fields.action === "paymentPlayers" && fields.q === holdSearch) await new Promise(resolve => { releaseSearch = resolve; });
    if (fields.action === "createPaymentCheckout" && holdCheckout) await new Promise(resolve=>{releaseCheckout=resolve;});
    if (fields.action === "confirmCardPayment" && holdCardConfirm) await new Promise(resolve=>{releaseCardConfirm=resolve;});
    if (fields.action === "quoteCardPayment") {
      const subtotal=JSON.parse(fields.entries).reduce((n,e)=>n+(e.event==='club-night'?1750:750),0);
      const cardFee=fields.coverCosts==='true'?Math.floor(subtotal*.03):Math.floor(subtotal*.025);
      request.respond({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({ok:true,quoteId:fields.requestId,subtotal,cardFee,amount:subtotal+cardFee+(cardQuoteTampered?1:0),currency:'usd',livemode:false,count:JSON.parse(fields.entries).length})});
      return;
    }
    if (fields.action === "confirmCardPayment") {
      serverTestPending = !["requires_payment_method","canceled"].includes(cardStatus);
      const quote=calls.filter(c=>c.action==='quoteCardPayment' && c.requestId===fields.quoteId).at(-1);
      const subtotal=JSON.parse(quote.entries).reduce((n,e)=>n+(e.event==='club-night'?1750:750),0);
      const amount=subtotal+(quote.coverCosts==='true'?Math.floor(subtotal*.03):Math.floor(subtotal*.025));
      await page.evaluate((amount,error)=>{window.stripeMock.amount=amount;window.stripeMock.actionError=error;},amount,cardActionError);
      request.respond({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({ok:true,paymentIntentId:'pi_fixture',clientSecret:cardStatus==='requires_action'?'pi_fixture_secret_private':null,status:cardStatus,amount,currency:'usd',livemode:false})});
      return;
    }
    const body = fields.action === "paymentPlayers" ? {ok:true,players:searchRoster.filter(p => /^\d+$/.test(fields.q) ? p.id.startsWith(fields.q) : fields.q.toLowerCase().split(/\s+/).every(w => p.name.toLowerCase().includes(w)))} : fields.action === "paymentBalances" ? { ok: true, id: fields.id, name: fields.id === "12345678" ? "Latest Player" : "Second Player", currency: "usd",
      entries: [{ event: "club-night", date: "2026-11", name: "Club Night", balanceCents: 1750, review: false },
        { event: "classic", date: "2025-05-01", name: "Past Classic", balanceCents: 750, review: false },
        { event: "paid", date: "2027-05-01", name: "Paid Event", balanceCents: 0, review: false },
        { event: "unknown", date: "2027-06-01", name: "Unknown Fee", balanceCents: null, review: false },
        { event: "review", date: "2027-07-01", name: "Review Event", balanceCents: 1750, review: true }], totalCents: 4250, unknownCount: 1 }
      : { ok: true, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_fixture", count: JSON.parse(fields.entries).length,
        amount: JSON.parse(fields.entries).reduce((n,e) => n + (e.event === "club-night" ? 1750 : 750),0), currency: "usd", livemode: false };
    if (fields.action === "paymentBalances" && fields.id === "00000000") Object.assign(body,{name:"",entries:[],totalCents:0,unknownCount:0});
    if (fields.action === "createPaymentCheckout" && checkoutFailure) Object.assign(body,{ok:false,error:"Test checkout service unavailable."});
    if (fields.action === "paymentBalances" && balanceVariant === "unknown") Object.assign(body,{entries:[{event:"unknown",date:"2027-06-01",name:"Unknown Fee",balanceCents:null,review:false}],totalCents:0,unknownCount:1});
    if (fields.action === "paymentBalances" && serverTestPending) body.entries.forEach(entry => { entry.testPending = entry.balanceCents > 0 && !entry.review; });
    if (fields.action === "paymentBalances" && balanceVariant === "pending") body.entries.forEach(entry => { entry.pending = entry.balanceCents > 0; });
    if (fields.action === "paymentBalances" && balanceVariant === "verified") body.entries = body.entries.filter(entry => entry.balanceCents > 0).map(entry => ({...entry,balanceCents:0,pending:false}));
    request.respond({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  } else request.continue();
});
await page.goto(base + "/pay/?returned=1", { waitUntil: "networkidle0" });
await page.waitForFunction(() => document.querySelectorAll("#pay-balances section").length === 2);
const balanceText = await page.$eval("#pay-balances", (el) => el.textContent);
const checkedCount = () => page.$$eval(".pay-entry input:checked", (els) => els.length);
const totalText = () => page.$eval("#pay-selected-total", (el) => el.textContent);
calls.some((call) => call.id === "12345678") && calls.some((call) => call.id === "22222222")
  && !balanceText.includes("Total owed") && balanceText.includes("2025-05-01")
  && !balanceText.includes("Paid Event") && balanceText.includes("Not set") && await checkedCount() === 4
  && (await totalText()).includes("$50.00")
  ? pass("All saved players load automatically with all payable entries selected; unknown, paid, review entries excluded") : fail(JSON.stringify({ calls, balanceText }));
await press(page, "#pay-deselect-all");
await checkedCount() === 0 && (await totalText()).includes("$0.00")
  ? pass("Deselect all clears the combined total") : fail("Deselect all failed");
await press(page, "#pay-select-all");
await checkedCount() === 4 ? pass("Select all restores eligible entries") : fail("Select all failed");
await press(page, "#pay-review");
await page.waitForSelector("#pay-checkout:not([hidden])");
(await page.evaluate(()=>window.checkoutNavigationAttempts>0)) ? pass("Pay opens the verified Stripe checkout automatically") : fail("Pay did not open Stripe checkout");
const combined = calls.find(call => call.action === "createPaymentCheckout");
JSON.parse(combined.entries).length === 4 && (await page.$eval("#pay-summary", el => el.textContent)).includes("$50.00")
  ? pass("One exact-total checkout covers both players and every selected event") : fail("Combined checkout incorrect");
await press(page, "#pay-deselect-all");
await press(page, '[data-player="12345678"] .pay-entry input');
await checkedCount() === 1 && (await totalText()).includes("$17.50")
  ? pass("An individual checkbox selects just one entry") : fail("Single selection failed");
await press(page, "#pay-review");
await page.waitForSelector("#pay-checkout:not([hidden])");
(await page.evaluate(()=>window.checkoutNavigationAttempts>0)) ? pass("Pay opens the verified Stripe checkout automatically") : fail("Pay did not open Stripe checkout");
const payment = calls.filter((call) => call.action === "createPaymentCheckout").at(-1);
JSON.parse(payment.entries)[0].id === "12345678" && JSON.parse(payment.entries)[0].date === "2026-11" && Object.keys(payment).length === 3
  && (await page.$eval("#pay-test", (el) => !el.hidden))
  ? pass("Single saved-player entry pays exact month without credentials and shows test mode") : fail(JSON.stringify(payment));
(await page.$$eval(".pay-entries", tables=>tables.length===2 && tables.every(table=>[...table.querySelectorAll("thead th")].map(th=>th.textContent).join(",")==="Pay,Event,Date,Amount" && !table.textContent.includes("\u2014"))))
  ? pass("Unpaid line items use accessible event, date and amount tables") : fail("Payment entries are not proper tables");
(await page.$eval("#pay-form", form=>{const input=form.querySelector("#pay-id").getBoundingClientRect(),button=form.querySelector("button[type=submit]").getBoundingClientRect();return button.left>=input.right && button.top<input.bottom;}))
  ? pass("Show balances sits beside the player field") : fail("Show balances is not beside the field");
(!await page.$("#pay-total")) ? pass("Payment page omits the total-owed summary") : fail("Total owed remains");
await axeBoth(page, "Saved player balances");
await page.setViewport({ width: 390, height: 844 });
await fitsPhone(page, "Saved player balances");
if (process.env.PAY_SCREENSHOT) await page.screenshot({ path: process.env.PAY_SCREENSHOT, fullPage: true });
// Forget a player while their refreshed balances are still loading.
holdId = "22222222";
await page.evaluate(() => [...document.querySelectorAll(".register-pick")].find((el) => el.textContent.includes("22222222")).click());
await page.waitForFunction(() => document.querySelector("#pay-id").value === "22222222");
(await page.$eval(".network-activity",el=>el.matches(":modal") && el.querySelector("p").textContent==="Loading entry balances")) ? pass("Balance progress uses a plain statement without question marks") : fail("Incorrect balance request message");
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
holdCheckout=true;checkoutFailure=true;
const checkoutCount=calls.filter(call=>call.action==="createPaymentCheckout").length;
await page.click("#pay-review");
await page.waitForFunction(()=>document.querySelector("#pay-review").getAttribute("aria-busy")==="true");
await page.$eval("#pay-review",el=>el.dispatchEvent(new MouseEvent("click",{bubbles:true})));
calls.filter(call=>call.action==="createPaymentCheckout").length===checkoutCount+1 && (await page.$eval("#pay-review",el=>el.disabled && el.textContent.includes("Opening secure checkout"))) && (await page.$eval(".network-activity",el=>el.matches(":modal") && el.querySelector("p").textContent === "Opening Stripe checkout"))
  ? pass("Payment preparation shows progress and blocks duplicate submissions") : fail("Pending checkout was submitted twice or lacked progress");
const retryRequest=calls.filter(call=>call.action==="createPaymentCheckout").at(-1).requestId;
releaseCheckout();holdCheckout=false;
await page.waitForFunction(()=>document.querySelector("#pay-summary").textContent.includes("Test checkout service unavailable"));
(await page.$eval("#pay-summary",el=>el.textContent.includes("Test checkout service unavailable") && document.activeElement===el && el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= innerHeight)) && (await page.$eval("#pay-review",el=>!el.disabled)) && (await page.$eval("#pay-checkout",el=>el.hidden))
  ? pass("Checkout errors stay beside the payment button with a clear retry path") : fail("Checkout error hid next steps");
checkoutFailure=false;
await page.click("#pay-review");await page.waitForSelector("#pay-checkout:not([hidden])");
calls.filter(call=>call.action==="createPaymentCheckout").at(-1).requestId===retryRequest
  ? pass("Retrying unchanged entries keeps the same checkout request identity") : fail("Retry lost its idempotent request identity");
config.enabled = false;
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector("#pay-balances section");
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
(await page.$eval('[data-player="00000000"]',el=>el.textContent.includes("No unpaid entries")))
  && (await page.$eval("#pay-id",el=>el.value))==="00000000"
  ? pass("A texted valid ID with no registrations clearly shows no active entries") : fail("No-registration link did not explain empty balance");
await page.removeScriptToEvaluateOnNewDocument(seed.identifier);
await page.evaluate(()=>localStorage.removeItem("lccc-register-players"));
config.enabled=true;
await page.goto(base+"/pay/",{waitUntil:"networkidle0"});
(await page.$eval("#pay-review",el=>el.disabled && el.textContent==="Select entries to pay")) && (await page.$eval("#pay-cart-status",el=>el.textContent.includes("Find a player above"))) && (await page.$eval("#main",el=>!el.textContent.includes("Find a player, select unpaid entries, then pay on Stripe.") && !el.textContent.includes("Not registered yet?")))
  && (await page.$eval("#pay-test",el=>!el.hidden))
  ? pass("A first-time payer sees concise payment guidance and the test-mode notice") : fail("Initial page does not explain how to pay");
balanceVariant="unknown";
await query("12345678");await press(page,"#pay-form button[type=submit]");await page.waitForNetworkIdle();
(await page.$eval("#pay-cart-status",el=>el.textContent.includes("Fees are not set yet"))) && (await page.$eval("#pay-review",el=>el.disabled))
  ? pass("Unknown fees explain why online payment is unavailable") : fail("Unknown fee left payer without guidance");
balanceVariant="pending";
await query("12345678");await press(page,"#pay-form button[type=submit]");await page.waitForNetworkIdle();
(await page.$eval('#pay-balances',el=>el.textContent.includes('Payment pending verification'))) && (await page.$$('#pay-balances input[type=checkbox]')).length===0 && (await page.$eval('#pay-review',el=>el.disabled))
  ? pass('Server pending entries remain visible and cannot be selected or paid again') : fail('Server pending entries remained payable');
balanceVariant="verified";
await query("12345678");await press(page,"#pay-form button[type=submit]");await page.waitForNetworkIdle();
(await page.$eval('#pay-balances',el=>el.textContent.includes('No unpaid entries') && !el.textContent.includes('Payment pending verification')))
  ? pass('Verified ledger payment removes settled entries instead of calling pending paid') : fail('Verified entries retained a stale pending state');
balanceVariant="";
config.cardProcessing={enabled:true,publishableKey:'pk_test_fixture',complianceReady:false};
await page.evaluate(saved=>localStorage.setItem('lccc-register-players',JSON.stringify(saved)),saved);
await page.goto(base+'/pay/',{waitUntil:'networkidle0'});
const priorConfirms=()=>calls.filter(c=>c.action==='confirmCardPayment').length;
const initialConfirms=priorConfirms();
await press(page,'#pay-review');
await page.waitForFunction(()=>!document.querySelector('#pay-card').hidden && window.stripeMock);
priorConfirms()===initialConfirms && (await page.$eval('#pay-card-confirm',el=>el.hidden)) && !(await page.$eval('#pay-cover-costs',el=>el.checked))
  && (await page.evaluate(()=>window.stripeMock.tokens===0 && window.stripeMock.options.amount===5000 && window.stripeMock.options.allowedPaymentMethodTypes.join(',')==='card'))
  ? pass('Opening the sandbox card form collects no token or charge and optional coverage starts unchecked') : fail('Card form charged early or had incorrect defaults');
await press(page,'#pay-card-review');
await page.waitForSelector('#pay-card-confirm:not([hidden])');
const firstQuote=calls.filter(c=>c.action==='quoteCardPayment').at(-1);
firstQuote.coverCosts==='false' && priorConfirms()===initialConfirms && (await page.$eval('#pay-card-total',el=>el.textContent))==='$51.25'
  ? pass('Card fee and final total are reviewed before a separate explicit payment') : fail('Card quote total or ordering wrong');
await press(page,'#pay-cover-costs');
(await page.$eval('#pay-card-confirm',el=>el.hidden)) ? pass('Changing optional costs invalidates the prior quote') : fail('Stale quote remained payable');
await press(page,'#pay-card-review');
await page.waitForSelector('#pay-card-confirm:not([hidden])');
const coveredQuote=calls.filter(c=>c.action==='quoteCardPayment').at(-1);
coveredQuote.coverCosts==='true' && coveredQuote.requestId!==firstQuote.requestId && coveredQuote.confirmationToken===firstQuote.confirmationToken
  && (await page.evaluate(()=>window.stripeMock.tokens===1)) && (await page.$eval('#pay-card-total',el=>el.textContent))==='$51.50'
  ? pass('Optional coverage requotes one basket with a fresh nonce and the same unconsumed card token') : fail('Optional coverage did not revalidate total');
holdCardConfirm=true;cardStatus='requires_action';
await press(page,'#pay-card-confirm');
while(!releaseCardConfirm) await new Promise(resolve=>setTimeout(resolve,10));
await page.$eval('#pay-card-confirm',el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));
priorConfirms()===initialConfirms+1 && (await page.$eval('#pay-card-confirm',el=>el.disabled))
  ? pass('Explicit final payment blocks double confirmation while pending') : fail('Card payment submitted twice');
releaseCardConfirm();holdCardConfirm=false;
await page.waitForFunction(()=>document.querySelector('#pay-summary').textContent.includes('Payment submitted'));
(await page.evaluate(()=>window.stripeMock.actions===1)) && priorConfirms()===initialConfirms+1
  ? pass('Card authentication runs once and reports submission without another confirmation') : fail('Card authentication repeated confirmation');
(await page.$eval('#pay-balances',el=>el.textContent.includes('Test payment pending verification'))) && (await page.$$('#pay-balances input[type=checkbox]')).length===0 && (await page.$eval('#pay-review',el=>el.disabled))
  ? pass('Submitted test entries show per-entry pending verification and cannot be selected again') : fail('Submitted entries remained payable');
await page.reload({waitUntil:'networkidle0'});
(await page.$$('#pay-balances input[type=checkbox]')).length===0 && (await page.$eval('#pay-balances',el=>el.textContent.includes('Test payment pending verification'))) && (await page.$eval('#pay-review',el=>el.disabled))
  ? pass('Server test pending survives refresh and still prevents another payment') : fail('Refresh lost the in-progress test payment');
serverTestPending=false;
await page.reload({waitUntil:'networkidle0'});
(await page.$$('#pay-balances input[type=checkbox]')).length===4
  ? pass('Verified isolated test sync clears pending without marking real entries paid') : fail('Verified test sync did not release test pending');
await press(page,'#pay-review');
await press(page,'#pay-card-review');
await page.waitForSelector('#pay-card-confirm:not([hidden])');
await page.evaluate(()=>window.stripeMock.changes());
(await page.$eval('#pay-card-confirm',el=>el.hidden)) ? pass('Editing card details invalidates the quoted fee') : fail('Edited card retained quote');
cardQuoteTampered=true;
await press(page,'#pay-card-review');
await page.waitForFunction(()=>document.querySelector('#pay-summary').textContent.includes('could not be verified'));
(await page.$eval('#pay-card-confirm',el=>el.hidden)) && priorConfirms()===initialConfirms+1
  ? pass('Tampered quote totals never enable final payment') : fail('Tampered card total became payable');
cardQuoteTampered=false;cardStatus='requires_payment_method';
await press(page,'#pay-card-review');
await page.waitForSelector('#pay-card-confirm:not([hidden])');
await press(page,'#pay-card-confirm');
await page.waitForFunction(()=>document.querySelector('#pay-summary').textContent.includes('Enter new card details'));
(await page.$eval('#pay-card-confirm',el=>el.hidden)) ? pass('A failed card requires a new review instead of automatic confirmation') : fail('Failed card stayed payable');
cardStatus='requires_action';cardActionError=true;
await press(page,'#pay-card-review');
await page.waitForSelector('#pay-card-confirm:not([hidden])');
await press(page,'#pay-card-confirm');
await page.waitForFunction(()=>document.querySelector('#pay-summary').textContent.includes('authentication was not completed'));
(await page.$eval('#pay-summary',el=>document.activeElement===el)) ? pass('Authentication failure stays beside the action with receipt guidance') : fail('Authentication error was hidden');
await axeBoth(page,'Sandbox card payment');
await fitsPhone(page,'Sandbox card payment');
await page.close();
await done();
