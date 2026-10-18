// Loads every page in Chrome against a local server and checks what HTML
// validation can't: accessibility (axe, light and dark), the event details
// dialog by keyboard, the filters, each card's Run by line and Details link, and
// the structured data on the events page and each club event's page, its
// Register form and entry list, the home page's register cards, the TD desk, the Pairings
// and Standings pages with sections, and the menu at desktop and phone widths.
//   node tests/check_pages.mjs [base URL, default http://127.0.0.1:8765]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const Pairing = require("../pairing.js");
const base = process.argv[2] || "http://127.0.0.1:8765";
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const events = JSON.parse(readFileSync(new URL("../events.json", import.meta.url), "utf8"));
const CLUB = "Larimer County Chess Club";
const seriesPages = [...new Set(events.map((e) => e.page).filter(Boolean))];
// The results pages outlive the events, so they come from the sitemap, not events.json.
const resultsPages = [...readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8")
  .matchAll(/<loc>https:\/\/larimerchess\.org(\/results\/[^<]*)<\/loc>/g)].map((m) => m[1]);
const pages = ["/", "/events/", "/scholastic/", "/minutes/", "/minutes/2026-09-24.html", "/privacy/", "/td/", "/entries/", "/pairings/", "/standings/",
  ...seriesPages, ...resultsPages];
const failures = [];
const fail = (message) => { failures.push(message); console.log(`FAIL ${message}`); };
const pass = (message) => console.log(`ok   ${message}`);

// Wide enough for the menu to fit on one line, so the sticky menu covers nothing the checks click.
const browser = await puppeteer.launch({ executablePath: chrome, args: ["--no-sandbox"], defaultViewport: { width: 1100, height: 800 } });
// register.js pointed at the stand-ins: the script at registration.test, and no live database or Firebase
// sign-in, which a check that wants one points at its own stand-in.
const offline = (source) => source.replace(/^const ENDPOINT = ".*";$/m, 'const ENDPOINT = "https://registration.test/exec";')
  .replace(/^const LIVE_DB = ".*";$/m, 'const LIVE_DB = "";')
  .replace(/^const FIREBASE = (null|\{[^}]*\});$/m, "const FIREBASE = null;");
const page = await browser.newPage();
// The live registration script, which can take longer than a navigation may, and the live database, whose
// stream never lets a page finish loading; these checks need neither.
const outside = (request) => /(^|\.)(script\.google\.com|firebaseio\.com)$/.test(new URL(request.url()).host);
await page.setRequestInterception(true);
page.on("request", (request) => (outside(request) ? request.abort() : request.continue()));
// Every filter group sits in a menu, which has to be opened first. The list shows a page of
// cards at a time, so the rest are shown before anything is counted. Show more is clicked in
// the page rather than with page.click, whose scrolling to the button would show more on its own.
async function choose(group, value) {
  await page.click(`[popovertarget="filter-${group}"]`);
  await page.click(`[data-filter-group="${group}"] button[data-value="${value}"]`);
  await showAll();
}
async function showAll() {
  while (await page.$(".events-more:not([hidden])")) await page.$eval(".events-more", (b) => b.click());
}
page.on("pageerror", (error) => fail(`JavaScript error on ${page.url()}: ${error.message}`));
// Clicks an element in the middle of the screen, since one at the edge can be under the sticky menu.
async function press(tab, selector) {
  await tab.$eval(selector, (el) => el.scrollIntoView({ block: "center" }));
  await tab.click(selector);
}

for (const path of pages) {
  for (const scheme of ["light", "dark"]) {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await page.goto(base + path, { waitUntil: "networkidle0" });
    await page.evaluate(axeSource);
    const result = await page.evaluate(() =>
      axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"] }));
    if (result.violations.length === 0) pass(`axe ${path} (${scheme})`);
    for (const v of result.violations) fail(`axe ${path} (${scheme}): ${v.id}: ${v.help} at ${v.nodes[0].target}`);
  }
}

await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await page.goto(base + "/events/", { waitUntil: "networkidle0" });
const allUpcoming = events.filter((e) => new Date(e.end) > new Date());
const isYouth = (e) => (e.tags || []).includes("youth");
const upcoming = allUpcoming.filter((e) => !isYouth(e));

const cards = await page.$$eval(".event", (c) => c.length);
cards === upcoming.length ? pass(`events page has all ${cards} upcoming events`)
  : fail(`events page has ${cards} cards for ${upcoming.length} upcoming events`);

// 30 cards at first; Show more adds the next 30 and moves focus to the first of them, and so
// does scrolling to the end of the list, without moving focus.
const PAGE = 30;
const paging = await page.evaluate(() => ({
  shown: document.querySelectorAll(".event:not([hidden])").length,
  more: !document.querySelector(".events-more").hidden,
}));
if (upcoming.length > PAGE) {
  await page.$eval(".events-more", (b) => b.click());
  const after = await page.evaluate(() => ({
    shown: document.querySelectorAll(".event:not([hidden])").length,
    focused: document.activeElement.closest(".event") === document.querySelectorAll(".event:not([hidden])")[30],
    status: document.getElementById("filter-status").textContent,
  }));
  const next = Math.min(2 * PAGE, upcoming.length);
  paging.shown === PAGE && paging.more && after.shown === next && after.focused
    ? pass(`shows ${PAGE} events, then ${next} after Show more, with focus on the first new one ("${after.status}")`)
    : fail(`paging: ${paging.shown} shown at first (button ${paging.more ? "shown" : "hidden"}), ${after.shown} after Show more, focus ${after.focused ? "on" : "not on"} the first new card`);
  await page.reload({ waitUntil: "networkidle0" });
  const kept = await page.$$eval(".event:not([hidden])", (c) => c.length);
  kept === next ? pass(`a reload keeps the ${next} shown`) : fail(`a reload shows ${kept}, not the ${next} shown before`);
  await showAll();
  // A reload keeps the history entry's count and the scroll position, so both are cleared for a
  // fresh list.
  await page.evaluate(() => { history.replaceState(null, ""); scrollTo(0, 0); });
  await page.reload({ waitUntil: "networkidle0" });
  await page.$eval(".events-more", (b) => b.scrollIntoView());
  const grew = await page.waitForFunction((n) => document.querySelectorAll(".event:not([hidden])").length === n,
    { timeout: 2000 }, next).then(() => true, () => false);
  const focusMoved = await page.evaluate(() => Boolean(document.activeElement.closest(".event")));
  grew && !focusMoved ? pass(`scrolling to the end shows ${next}, leaving focus alone`)
    : fail(`scrolling to the end: ${grew ? "" : `didn't show ${next}; `}focus ${focusMoved ? "moved" : "stayed"}`);
  await showAll();
}

const cities = [...new Set(upcoming.map((e) => e.city).filter(Boolean))].sort();
const cityButtons = await page.$$eval('[data-filter-group="city"] button', (b) => b.map((x) => x.textContent));
JSON.stringify(cityButtons) === JSON.stringify(["All cities", ...cities]) ? pass(`city filters: ${cityButtons.join(", ")}`)
  : fail(`city filters ${JSON.stringify(cityButtons)} don't match event cities ${JSON.stringify(cities)}`);

for (const [group, kind] of [["kind", "club"], ["kind", "all"], ["age", "all-ages"], ["age", "senior"], ["age", "all"]]) {
  await choose(group, kind);
  const shown = await page.$$eval(".event:not([hidden])", (c) => c.length);
  const expected = kind === "all" ? upcoming.length : upcoming.filter((e) => (e.tags || []).includes(kind)).length;
  const status = await page.$eval("#filter-status", (s) => s.textContent);
  shown === expected && status.startsWith(`Showing ${expected} `) ? pass(`filter ${kind}: ${status}`)
    : fail(`filter ${kind} shows ${shown}, expected ${expected}; announced "${status}"`);
}

for (const [value, keep] of [["weekly", true], ["not-weekly", false]]) {
  await choose("schedule", value);
  const shown = await page.$$eval(".event:not([hidden])", (c) => c.length);
  const expected = upcoming.filter((e) => (e.tags || []).includes("weekly") === keep).length;
  shown === expected ? pass(`schedule ${value}: ${shown} events`) : fail(`schedule ${value} shows ${shown}, expected ${expected}`);
}
await choose("schedule", "all");

for (const value of ["free", "free-youth", "reduced-youth", "reduced-senior", "cost-unknown"]) {
  await choose("cost", value);
  const shown = await page.$$eval(".event:not([hidden])", (c) => c.length);
  const expected = upcoming.filter((e) => (e.tags || []).includes(value)).length;
  shown === expected ? pass(`cost ${value}: ${shown} events`) : fail(`cost ${value} shows ${shown}, expected ${expected}`);
}
const costMenu = await page.$eval('[popovertarget="filter-cost"]', (b) =>
  ({ text: b.textContent, open: document.getElementById("filter-cost").matches(":popover-open") }));
costMenu.text === "Cost: Cost unknown" && !costMenu.open ? pass(`cost menu closes and reads "${costMenu.text}"`)
  : fail(`cost menu reads "${costMenu.text}" and is ${costMenu.open ? "still open" : "closed"}`);
await choose("cost", "all");

const SPEEDS = ["regular", "quick", "blitz"];
async function checkSpeeds(label, events) {
  const present = SPEEDS.filter((s) => events.some((e) => (e.tags || []).includes(s)));
  const buttons = await page.$$eval('[data-filter-group="speed"] button', (b) => b.map((x) => x.dataset.value));
  const expected = present.length ? ["all", ...present] : [];
  if (JSON.stringify(buttons) !== JSON.stringify(expected)) {
    return fail(`${label} time control buttons ${JSON.stringify(buttons)}, expected ${JSON.stringify(expected)}`);
  }
  for (const value of present) {
    await choose("speed", value);
    const shown = await page.$$eval(".event:not([hidden])", (c) => c.length);
    const want = events.filter((e) => (e.tags || []).includes(value)).length;
    if (shown !== want) return fail(`${label} time control ${value} shows ${shown}, expected ${want}`);
  }
  if (present.length) await choose("speed", "all");
  pass(`${label} time control filters: ${present.length ? present.join(", ") : "none, menu left out"}`);
}
await checkSpeeds("events page", upcoming);

const lines = await page.$$eval(".event", (cards) => cards.map((c) => ({
  title: c.querySelector("h3 button").firstChild.textContent,
  runBy: (c.querySelector(".event-organizer")?.firstChild?.nodeType === 3 && c.querySelector(".event-organizer").firstChild.textContent) || "",
  details: c.querySelector(".event-organizer a")?.getAttribute("href") || "",
})));
const wrongLines = lines.filter((card, i) => {
  const e = upcoming[i];
  const runBy = e.organizer && e.organizer !== "Larimer County Chess Club" ? `Run by ${e.organizer}` : "";
  return card.title !== e.title || card.runBy !== runBy || card.details !== (e.url || e.page || "");
});
wrongLines.length === 0 ? pass("each card's Run by line and Details link match its event")
  : fail(`Run by or Details wrong on: ${[...new Set(wrongLines.map((c) => c.title))].join(", ")}`);

const unratedPaid = upcoming.filter((e) => e.organizer === "Larimer County Chess Club" && !(e.tags || []).includes("rated")
  && !(e.tags || []).includes("free"));
unratedPaid.length === 0 ? pass("every club event is tagged rated, or free")
  : fail(`club events neither rated nor free: ${[...new Set(unratedPaid.map((e) => e.title))].join(", ")}`);

const described = upcoming.findIndex((e) => e.description);
await page.focus(`.event:nth-of-type(1) .event-open`);
const firstTitle = await page.evaluate(() => document.activeElement.firstChild.textContent);
await page.keyboard.press("Enter");
const opened = await page.evaluate(() => {
  const dialog = document.querySelector("dialog.event-dialog");
  return {
    open: dialog?.open,
    modal: dialog?.matches(":modal"),
    label: document.getElementById(dialog?.getAttribute("aria-labelledby"))?.textContent,
    focus: document.activeElement.id,
    // The add-to-calendar links come before the description.
    order: [...dialog.querySelectorAll(".event-add a, .event-description")].map((n) => n.className),
  };
});
opened.open && opened.modal && opened.label === firstTitle && opened.focus === "event-dialog-title"
  && opened.order[0] === "button" && opened.order[1] === "button button-secondary"
  ? pass("Enter opens the details dialog, labelled by the title and focused on it, add buttons first")
  : fail(`Enter on a card: ${JSON.stringify(opened)}`);
await page.keyboard.press("Escape");
// The dialog's close event, which resets the card's button, fires a task later.
await page.waitForFunction(() => !document.querySelector("dialog.event-dialog").open, { timeout: 2000 }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 50));
const closed = await page.evaluate(() => !document.querySelector("dialog.event-dialog").open
  && document.activeElement.classList.contains("event-open")
  && document.activeElement.getAttribute("aria-expanded") === "false");
closed ? pass("Escape closes the details and returns focus to the card") : fail("Escape didn't close the details or return focus");

if (described >= 0) {
  const cardsAll = await page.$$(".event-open");
  await cardsAll[described].click();
  const text = await page.$eval(".event-description", (d) => d.textContent);
  const firstLine = upcoming[described].description.trim().split("\n")[0].replace(/^\s*[•*-]\s+/, "");
  text.includes(firstLine.replace(/https?:\/\/\S+/g, "").trim()) ? pass(`details show the description of ${upcoming[described].title}`)
    : fail(`details of ${upcoming[described].title} lack its description`);
  await page.evaluate(axeSource);
  const inDialog = await page.evaluate(() => axe.run(document.querySelector("dialog"),
    { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"] }));
  inDialog.violations.length === 0 ? pass("axe on the open details dialog")
    : inDialog.violations.forEach((v) => fail(`axe dialog: ${v.id}: ${v.help} at ${v.nodes[0].target}`));
  await page.click(".event-dialog-x");
  await new Promise((r) => setTimeout(r));
  await page.evaluate(() => !document.querySelector("dialog.event-dialog").open)
    ? pass("the corner × closes the details") : fail("the corner × didn't close the details");
}

// The data is in the HTML, so it is read from the page as served, before any script runs.
async function eventData(path) {
  const served = await (await fetch(base + path)).text();
  return [...served.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)]
    .flatMap((m) => [JSON.parse(m[1])].flat()).filter((d) => d["@type"] === "Event");
}
const complete = (d) => d.name && d.startDate && d.location?.address && d.url;
const clubEvents = events.filter((e) => e.organizer === CLUB);
const listed = await eventData("/events/");
listed.length === clubEvents.length && listed.every(complete)
  ? pass(`events page has structured data for all ${clubEvents.length} club events`)
  : fail(`events page structured data: ${listed.length} events for ${clubEvents.length} club events, ${listed.filter((d) => !complete(d)).length} incomplete`);
for (const path of seriesPages) {
  const own = clubEvents.filter((e) => e.page === path);
  const data = await eventData(path);
  data.length === own.length && data.every((d) => complete(d) && d.url === `https://larimerchess.org${path}`)
    ? pass(`${path} has structured data for its ${own.length} date(s)`)
    : fail(`${path} structured data: ${data.length} events for ${own.length} dates, or a wrong url`);
}

// A reload while scrolled down must come back to the same place without the page jumping.
await page.evaluateOnNewDocument(() => {
  window.layoutShift = 0;
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.layoutShift += e.value; })
    .observe({ type: "layout-shift", buffered: true });
});
await page.evaluate(() => scrollTo(0, document.getElementById("subscribe").offsetTop - 200));
const scrolledTo = await page.evaluate(() => scrollY);
await page.reload({ waitUntil: "networkidle0" });
const afterReload = await page.evaluate(() => ({ y: scrollY, shift: window.layoutShift }));
Math.abs(afterReload.y - scrolledTo) <= 1 && afterReload.shift < 0.1
  ? pass(`reload while scrolled keeps the place (layout shift ${afterReload.shift.toFixed(3)})`)
  : fail(`reload at ${scrolledTo} came back at ${afterReload.y} with layout shift ${afterReload.shift.toFixed(3)}`);

await page.goto(base + "/scholastic/", { waitUntil: "networkidle0" });
const youthEvents = allUpcoming.filter(isYouth);
const youthCards = await page.$$eval(".event", (c) => c.length);
youthCards === youthEvents.length ? pass(`scholastic page shows all ${youthCards} youth events`)
  : fail(`scholastic page shows ${youthCards} cards for ${youthEvents.length} youth events`);
const youthCities = [...new Set(youthEvents.map((e) => e.city).filter(Boolean))].sort();
const youthCityButtons = await page.$$eval('[data-filter-group="city"] button', (b) => b.map((x) => x.textContent));
JSON.stringify(youthCityButtons) === JSON.stringify(["All cities", ...youthCities]) ? pass(`scholastic city filters: ${youthCityButtons.join(", ")}`)
  : fail(`scholastic city filters ${JSON.stringify(youthCityButtons)} don't match ${JSON.stringify(youthCities)}`);
await checkSpeeds("scholastic page", youthEvents);
await choose("kind", "tournament");
const youthTournaments = await page.$$eval(".event:not([hidden])", (c) => c.length);
const expectedTournaments = youthEvents.filter((e) => e.tags.includes("tournament")).length;
youthTournaments === expectedTournaments ? pass(`scholastic tournaments: ${youthTournaments}`)
  : fail(`scholastic tournaments show ${youthTournaments}, expected ${expectedTournaments}`);

await page.goto(base + "/", { waitUntil: "networkidle0" });
const homeCards = await page.$$eval(".event", (c) => c.length);
homeCards > 0 && homeCards <= 6 ? pass(`home page shows ${homeCards} events`) : fail(`home page shows ${homeCards} events`);

// Every rated club event's card, and its details at the top and bottom, offer Register; an unrated one, such as a class, doesn't.
await page.goto(base + "/events/", { waitUntil: "networkidle0" });
const invitationalIds = new Set(events.filter((e) => (e.tags || []).includes("invitational")).map((e) => e.title));
const unratedIds = new Set(events.filter((e) => e.organizer === "Larimer County Chess Club" && !(e.tags || []).includes("rated")).map((e) => e.title));
const clubCards = await page.$$(".event-club");
let clubCard = null;
for (const card of clubCards) {
  const title = await card.$eval(".event-open", (b) => b.firstChild.textContent);
  if (!invitationalIds.has(title) && !unratedIds.has(title)) { clubCard = card; break; }
}
for (const card of clubCards) {
  const title = await card.$eval(".event-open", (b) => b.firstChild.textContent);
  if (!unratedIds.has(title)) continue;
  await card.$eval(".event-open", (b) => b.click());
  const offered = await page.$$eval("dialog.event-dialog .event-register", (a) => a.length)
    + await card.$$eval(".event-card-register", (a) => a.length);
  await page.keyboard.press("Escape");
  offered === 0
    ? pass(`the unrated ${title} offers no Register`)
    : fail(`unrated card ${title} offers Register`);
  break;
}
for (const card of clubCards) {
  const title = await card.$eval(".event-open", (b) => b.firstChild.textContent);
  if (!invitationalIds.has(title)) continue;
  const shown = await card.evaluate((c) => ({ register: !!c.querySelector(".event-card-register"), text: c.textContent }));
  !shown.register && shown.text.includes("registration is closed")
    ? pass(`the invitational ${title} says registration is closed instead of offering Register`)
    : fail(`invitational card ${title}: ${JSON.stringify(shown)}`);
  break;
}
if (clubCard) {
  const cardLink = await clubCard.$eval(".event-card-register", (a) => a.getAttribute("href")).catch(() => null);
  await clubCard.$eval(".event-open", (b) => b.click());
  const dialogLinks = await page.$$eval("dialog.event-dialog .event-register", (a) => a.map((x) => x.getAttribute("href")));
  const otherCards = await page.$$eval(".event:not(.event-club) .event-card-register", (a) => a.length);
  const clubTags = await clubCard.evaluate((c) => c.dataset.tags.split(" "));
  (clubTags.includes("tournament") ? /^\/events\/[^/]+\/\?date=\d{4}-\d\d-\d\d#register$/ : /^\/events\/[^/]+\/\?date=\d{4}-\d\d#register$/)
    .test(cardLink || "") && dialogLinks.length === 2
    && dialogLinks.every((h) => h === cardLink) && otherCards === 0
    ? pass(`club cards and their details offer Register (${cardLink})`)
    : fail(`Register links: card ${cardLink}, details ${JSON.stringify(dialogLinks)}, on other cards ${otherCards}`);
  await page.keyboard.press("Escape");
}
const cardDates = await page.$$eval(".event-club .event-card-register", (a) => a.map((x) => ({
  tournament: x.closest(".event").dataset.tags.split(" ").includes("tournament"), date: new URL(x.href).searchParams.get("date") })));
const wrongDates = cardDates.filter((c) => !(c.tournament ? /^\d{4}-\d\d-\d\d$/ : /^\d{4}-\d\d$/).test(c.date));
cardDates.some((c) => !c.tournament) && !wrongDates.length ? pass("club night cards' Register opens on the whole month, and tournaments' on their date")
  : fail(`Register dates on club cards: ${JSON.stringify(wrongDates.length ? wrongDates : cardDates)}`);

// Registration, against a stand-in for the Apps Script: register.js is served with its
// ENDPOINT pointed at it, whatever the real one is.
const registration = await browser.newPage();
registration.on("pageerror", (error) => fail(`JavaScript error on ${registration.url()}: ${error.message}`));
const posted = [];
await registration.setRequestInterception(true);
registration.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
  } else if (url.host === "registration.test") {
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (request.method() === "POST") {
      const sent = Object.fromEntries(new URLSearchParams(request.postData()));
      posted.push(sent);
      // Kid's answer is in the wording of the script deployed before 2026-10-10, which has no " for …".
      const message = sent.last === "Kid" ? `Test ${sent.last} is registered. A confirmation is on its way to ${sent.email}.`
        : `Test ${sent.last} is registered for Saturday, November 7, 2026. Due when you arrive: $15 (adult).`;
      const answer = sent.last === "Twin" ? { error: "Test Twin is already registered for Saturday, November 7, 2026." } : { ok: true, message };
      request.respond({ headers, contentType: "application/json", body: JSON.stringify(answer) });
    } else {
      const entries = [{ name: "Test Player", id: "12345678", rating: "1500" }, { name: "New Player", id: "87654321", rating: "" }];
      request.respond({ headers, contentType: "application/json", body: JSON.stringify({ entries }) });
    }
  } else {
    request.continue();
  }
});
// Free events have no Register form.
const registerPath = seriesPages.find((p) => clubEvents.filter((e) => e.page === p && !e.tags?.includes("free")).length > 1) || seriesPages[0];
if (registerPath) {
  await registration.goto(base + registerPath, { waitUntil: "networkidle0" });
  const rows = await registration.$$eval(".entries tbody tr", (r) => r.map((x) => x.textContent));
  rows.length === 2 && rows[1].includes("Unrated") ? pass(`${registerPath} lists the entries`)
    : fail(`${registerPath} entries: ${JSON.stringify(rows)}`);
  await registration.type("#register-id", "12345678");
  await registration.type("#register-last", "Player");
  await registration.type("#register-email", "test@example.com");
  await registration.type("#register-phone", "970 555 0123");
  await registration.click(".register-form button[type=submit]");
  await registration.waitForFunction(() => document.querySelector(".register-status").textContent.includes("registered"));
  const sent = posted[0] || {};
  sent.event === registerPath.split("/").filter(Boolean).pop() && /^\d{4}-\d\d(-\d\d)?$/.test(sent.date)
    && sent.id === "12345678" && sent.last === "Player" && sent.email === "test@example.com" && sent.phone === "970 555 0123" && !sent.website
    && !("uschess-id" in sent) ? pass(`${registerPath} sends the registration`) : fail(`${registerPath} sent ${JSON.stringify(sent)}`);

  // Remembered players: a second registration goes first in the list, and after a reload
  // each fills the form in one tap and can be forgotten.
  await registration.type("#register-id", "87654321");
  await registration.type("#register-last", "Kid");
  await registration.$eval("#register-phone", (p) => { p.value = ""; });
  await registration.click(".register-form button[type=submit]");
  await registration.waitForFunction(() => document.querySelector(".register-status").textContent.startsWith("Test Kid"));
  await registration.reload({ waitUntil: "networkidle0" });
  const saved = () => registration.$$eval(".register-saved:not([hidden]) .register-pick", (b) => b.map((x) => x.textContent));
  const shown = await saved();
  JSON.stringify(shown) === JSON.stringify(["Test Kid (87654321)", "Test Player (12345678)"])
    ? pass(`${registerPath} offers the players registered here, most recent first`) : fail(`${registerPath} saved players: ${JSON.stringify(shown)}`);
  const onLoad = await registration.evaluate(() => [document.querySelector("#register-id").value, document.querySelector("#register-last").value]);
  JSON.stringify(onLoad) === JSON.stringify(["87654321", "Kid"])
    ? pass(`${registerPath} fills in the most recent saved player when it opens`) : fail(`${registerPath} on load: ${JSON.stringify(onLoad)}`);
  await registration.click(".register-saved li:nth-child(2) .register-pick");
  const filled = await registration.evaluate(() => ({ id: document.querySelector("#register-id").value,
    last: document.querySelector("#register-last").value, email: document.querySelector("#register-email").value,
    phone: document.querySelector("#register-phone").value, website: document.querySelector("#register-website").value, focus: document.activeElement.matches("#register-date, button[type=submit]") }));
  filled.id === "12345678" && filled.last === "Player" && filled.email === "test@example.com" && filled.phone === "970 555 0123"
    && !filled.website && filled.focus
    && posted.length === 2 ? pass(`${registerPath} fills in a saved player without registering`) : fail(`${registerPath} filled ${JSON.stringify(filled)}`);
  const reordered = await saved();
  JSON.stringify(reordered) === JSON.stringify(["Test Player (12345678)", "Test Kid (87654321)"])
    ? pass(`${registerPath} moves the player picked to the front of the saved list`) : fail(`${registerPath} after a pick: ${JSON.stringify(reordered)}`);
  for (const scheme of ["light", "dark"]) {
    await registration.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await registration.evaluate(axeSource);
    const result = await registration.evaluate(() => axe.run({ include: ["#register", "#entries"] }));
    result.violations.length ? fail(`${registerPath} form (${scheme}): ${result.violations.map((v) => v.id).join(", ")}`)
      : pass(`${registerPath} form with saved players has no axe violations (${scheme})`);
  }
  await registration.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await registration.click(".register-saved li:nth-child(2) .register-forget");
  const afterForget = await registration.evaluate(() => ({ stored: localStorage.getItem("lccc-register-players"),
    focus: document.activeElement.textContent, said: document.querySelector(".register-status").textContent }));
  JSON.stringify(await saved()) === JSON.stringify(["Test Player (12345678)"]) && !afterForget.stored.includes("87654321")
    && afterForget.focus === "Test Player (12345678)" && afterForget.said.includes("no longer saved")
    ? pass(`${registerPath} forgets a saved player`) : fail(`${registerPath} after Forget: ${JSON.stringify(afterForget)}`);
  await registration.click(".register-saved li:first-child .register-forget");
  const empty = await registration.evaluate(() => ({ hidden: document.querySelector(".register-saved").hidden,
    stored: localStorage.getItem("lccc-register-players"), focus: document.activeElement.id }));
  empty.hidden && empty.stored === null && empty.focus === "register-id"
    ? pass(`${registerPath} hides the list when the last saved player is forgotten`) : fail(`${registerPath} after the last Forget: ${JSON.stringify(empty)}`);
  // The fields still hold the player filled in above.
  await registration.click("#register-remember");
  await registration.click(".register-form button[type=submit]");
  await registration.waitForFunction(() => document.querySelector(".register-status").textContent.startsWith("Test Player is registered"));
  await registration.reload({ waitUntil: "networkidle0" });
  const unremembered = await registration.evaluate(() => ({ hidden: document.querySelector(".register-saved").hidden,
    stored: localStorage.getItem("lccc-register-players"), checked: document.querySelector("#register-remember").checked }));
  posted.length === 3 && unremembered.hidden && unremembered.stored === null && unremembered.checked
    ? pass(`${registerPath} doesn't save a player when Remember is unchecked`) : fail(`${registerPath} unchecked Remember: ${JSON.stringify(unremembered)}`);
  // A player already registered is saved too: the script has accepted their ID and last name.
  for (const [field, value] of [["#register-id", "11223344"], ["#register-last", "Twin"], ["#register-email", "twin@example.com"]]) {
    await registration.$eval(field, (input) => { input.value = ""; });
    await registration.type(field, value);
  }
  await registration.click(".register-form button[type=submit]");
  await registration.waitForFunction(() => document.querySelector(".register-status").textContent.includes("already registered"));
  const twin = await registration.evaluate(() => JSON.parse(localStorage.getItem("lccc-register-players") || "[]"));
  twin.length === 1 && twin[0].id === "11223344" && twin[0].name === "Test Twin"
    ? pass(`${registerPath} saves a player who is already registered`) : fail(`${registerPath} already registered: ${JSON.stringify(twin)}`);
  await registration.evaluate(() => localStorage.clear());
}

// Byes asked for when registering, each a half-point bye. A Swiss's Register form offers its rounds, with the times
// its description gives, and sends those checked as one value; its entry list shows each player's byes. A club
// night's offers a month's nights only while that month is chosen, and sends their dates.
const fillPlayer = async (tab) => {
  for (const [field, value] of [["#register-id", "12345678"], ["#register-last", "Player"], ["#register-email", "test@example.com"]]) {
    await tab.$eval(field, (input) => { input.value = ""; });
    await tab.type(field, value);
  }
};
const datesByPage = seriesPages.map((p) => clubEvents.filter((e) => e.page === p));
const swissDates = datesByPage.find(([e]) => e?.tags.includes("tournament") && Number(e.rounds) && !["quad", "arena"].includes(e.pairing));
if (swissDates) {
  const [swiss] = swissDates;
  const sentSwiss = [];
  const swissPage = await mocked(`${swiss.page} with byes`, (p) => {
    if (p.entries) return { entries: [{ name: "Ann Example", id: "12345678", rating: "1500", byes: ["2", "4"] }, { name: "Ben Example", id: "22345678", rating: "1200" }] };
    sentSwiss.push(p);
    return { ok: true, name: "Test Player", message: "Test Player is registered for Saturday, November 7, 2026, with a half-point bye." };
  });
  await swissPage.goto(base + swiss.page, { waitUntil: "networkidle0" });
  const times = Object.fromEntries([...swiss.description.matchAll(/^\s*[•*-]\s+Round (\d+): (\d{1,2}:\d\d [AP]M)/gm)].map((m) => [m[1], m[2]]));
  const rounds = [...Array(Number(swiss.rounds))].map((_, i) => `Round ${i + 1}${times[i + 1] ? `, ${times[i + 1]}` : ""}`);
  const offered = await swissPage.$$eval("[name=byes] + label", (labels) => labels.map((l) => l.textContent));
  const listed = await swissPage.$$eval("#entries tr", (rows) => rows.map((r) => r.lastElementChild.textContent));
  const picked = [...new Set(["1", swiss.rounds])];
  await fillPlayer(swissPage);
  for (const round of picked) await press(swissPage, `#register-bye-${round}`);
  await press(swissPage, ".register-form button[type=submit]");
  await swissPage.waitForFunction(() => document.querySelector(".register-status").textContent.includes("registered"));
  const left = await swissPage.$$eval("[name=byes]:checked", (boxes) => boxes.length);
  JSON.stringify(offered) === JSON.stringify(rounds) && JSON.stringify(listed) === JSON.stringify(["Byes", "Rounds 2 and 4", ""])
    && sentSwiss.length === 1 && sentSwiss[0].byes === picked.join(", ") && left === 0
    ? pass(`${swiss.page} offers the rounds to miss (${offered.join("; ")}), sends those checked, and lists each player's byes`)
    : fail(`${swiss.page} byes: ${JSON.stringify({ offered, rounds, listed, sent: sentSwiss, left })}`);
  await swissPage.evaluate(() => localStorage.clear());
  await swissPage.close();
}
const nightDates = datesByPage.find(([e]) => e?.tags.includes("rated") && !e.tags.includes("tournament"));
if (nightDates) {
  const { page: nightPath, start } = nightDates[0];
  const month = start.slice(0, 7);
  const nights = nightDates.filter((e) => e.start.startsWith(month)).map((e) => e.start.slice(0, 10));
  const sentNights = [];
  const nightPage = await mocked(`${nightPath} with byes`, (p) => {
    if (p.entries) return { entries: [] };
    sentNights.push(p);
    return { ok: true, name: "Test Player", message: "Test Player is registered." };
  });
  await nightPage.goto(`${base}${nightPath}?date=${month}`, { waitUntil: "networkidle0" });
  const offeredNights = () => nightPage.$$eval("fieldset[data-month]", (sets) => sets.filter((s) => !s.hidden && !s.disabled)
    .map((s) => [...s.querySelectorAll("[name=byes]")].map((b) => b.value)));
  const checkNights = async () => {
    for (const night of nights) await press(nightPage, `#register-bye-${night}`);
    await fillPlayer(nightPage);
    await nightPage.$eval(".register-status", (s) => { s.textContent = ""; });
  };
  const forMonth = await offeredNights();
  await checkNights();
  // Checked for the month, then a night chosen instead: the night is registered without them.
  await nightPage.select("#register-date", nights[0]);
  const forNight = await offeredNights();
  await press(nightPage, ".register-form button[type=submit]");
  await nightPage.waitForFunction(() => document.querySelector(".register-status").textContent.includes("registered"));
  await nightPage.select("#register-date", month);
  await checkNights();
  await press(nightPage, ".register-form button[type=submit]");
  await nightPage.waitForFunction(() => document.querySelector(".register-status").textContent.includes("registered"));
  JSON.stringify(forMonth) === JSON.stringify([nights]) && JSON.stringify(forNight) === "[]" && sentNights.length === 2
    && sentNights[0].date === nights[0] && !("byes" in sentNights[0]) && sentNights[1].date === month && sentNights[1].byes === nights.join(", ")
    ? pass(`${nightPath} offers the nights to miss only for a whole month, and sends their dates (${sentNights[1].byes})`)
    : fail(`${nightPath} byes: ${JSON.stringify({ forMonth, forNight, nights, sent: sentNights })}`);
  await nightPage.evaluate(() => localStorage.clear());
  await nightPage.close();
}

// The home page's register cards. Through a month's second Monday the club night card asks
// players to register for the month, then to drop in; the clock is set an hour before each case.
const clubNights = clubEvents.filter((e) => !e.tags.includes("tournament") && e.tags.includes("rated"));
const ordinal = (e) => Math.ceil(Number(e.start.slice(8, 10)) / 7);
for (const [night, expected] of [[clubNights.find((e) => ordinal(e) <= 2), /^Register for /],
                                 [clubNights.find((e) => ordinal(e) > 2), /^Drop in /]]) {
  if (!night) continue;
  const home = await browser.newPage();
  const clock = new Date(night.start).getTime() - 3600000;
  await home.evaluateOnNewDocument((fixed) => {
    const RealDate = Date;
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    };
  }, clock);
  await home.goto(base + "/", { waitUntil: "networkidle0" });
  const cards = await home.evaluate(() => [...document.querySelectorAll(".next-card")]
    .map((c) => ({ hidden: c.hidden, title: c.querySelector(".next-title").textContent, href: c.getAttribute("href") })));
  const saturday = clubEvents.find((e) => e.tags.includes("tournament") && new Date(e.start) > clock);
  expected.test(cards[0].title) && cards[0].href.startsWith(night.page)
    && (!saturday || cards[1].href === `${saturday.page}?date=${saturday.start.slice(0, 10)}#register`)
    ? pass(`home page before ${night.start.slice(0, 10)}: "${cards[0].title}", "${cards[1].title}"`)
    : fail(`home page before ${night.start.slice(0, 10)}: ${JSON.stringify(cards)}`);
  await home.close();
}

// The TD desk, against a stand-in for the Apps Script: sign in, find a player by name,
// register them, mark them paid, log an incident, and remove an entry.
const desk = await browser.newPage();
// A stand-in for the browser's password manager, to see what the desk offers it.
await desk.evaluateOnNewDocument(() => {
  window.stored = [];
  window.PasswordCredential = class { constructor(data) { Object.assign(this, data); } };
  Object.defineProperty(navigator, "credentials", { value: { store: async (c) => { window.stored.push(c); } } });
});
desk.on("pageerror", (error) => fail(`JavaScript error on /td/: ${error.message}`));
const deskCalls = [];
const deskHosts = new Set();
await desk.setRequestInterception(true);
desk.on("request", async (request) => {
  const url = new URL(request.url());
  deskHosts.add(url.host);
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
  } else if (url.host === "registration.test") {
    const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
    deskCalls.push(p);
    const body = p.password !== "secret" ? { error: "Wrong password.", login: true }
      : { login: { ok: true },
          choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" }] },
          people: { players: [{ id: "12345678", name: "Test Player", state: "", rating: "1500", expires: "2027-01-31", known: true,
            email: "test@example.com", phone: "970-555-0100" }] },
          contacts: { headings: ["Name", "Email", "Phone", "Status", "Notes", "US Chess ID"],
            contacts: [{ id: "c1", Name: "Cora Contact", Email: "cora@example.com", Phone: "970-555-0103", Status: "Player", Notes: "", "US Chess ID": "" }] },
          contactSave: { ok: true, id: "c1", message: "Cora Contact is saved." },
          contactDelete: { ok: true, message: "Cora Contact is deleted." },
          refresh: { ok: true, message: "Refreshed 3 entry lists and 1 tournament." },
          search: { players: [{ id: "87654321", name: "Zed Newcomer", state: "CO", rating: "1100", expires: "2027-01-31" }] },
          register: { ok: true, message: "Test Player is registered." },
          entries: { entries: [{ name: "Test Player", id: "12345678", rating: "1500", for: "Whole month", category: "Adult", amount: "16.50", due: "16.50", card: "17.42", email: "", expires: "2027-01-31", token: "t1", date: "2026-10" },
            { name: "Night Player", id: "22345678", rating: "1400", for: "Monday, October 12", category: "Senior (65+)", amount: "5.50", due: "5.50", card: "6.14", email: "night@example.com", phone: "970-555-0102", expires: "2027-01-31", token: "t2", date: "2026-10-12" }] },
          remove: { message: "Test Player is withdrawn." },
          paid: { ok: true, message: "Test Player paid $15." },
          ledger: { ledger: { received: { cash: "15", check: "0", card: "0", other: "0" }, entry: "13", rating: "2", card: "0", games: 6, uschess: "3" } },
          incident: { ok: true, message: "Logged: Game loss, Test Player." },
          incidents: { incidents: [] },
          tournament: { tournament: null } }[p.action];
    // Registering answers slowly, like the real script, so a second player can be entered meanwhile.
    if (p.action === "register") await new Promise((resolve) => setTimeout(resolve, 1500));
    request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
  } else {
    request.continue();
  }
});
desk.on("dialog", (d) => d.accept(d.type() === "prompt" ? d.defaultValue() : undefined));
await desk.goto(base + "/td/", { waitUntil: "networkidle0" });
await desk.type("#td-password", "secret");
await desk.click(".td-login button");
await desk.waitForSelector(".td-desk:not([hidden])");
const offered = await desk.evaluate(() => window.stored.map((c) => [c.id, c.password]));
const usernameField = await desk.$eval('.td-login input[autocomplete="username"]', (i) => i.value).catch(() => null);
JSON.stringify(offered) === JSON.stringify([["TD desk", "secret"]]) && usernameField === "TD desk"
  ? pass("TD desk offers the password to the browser's password manager after signing in")
  : fail(`TD desk password saving: ${JSON.stringify({ offered, usernameField })}`);
const accountButtons = await desk.$$(".td-google, #td-login-email");
!deskHosts.has("www.gstatic.com") && !accountButtons.length
  ? pass("TD desk without FIREBASE signs in by password and loads nothing from Google")
  : fail(`TD desk without FIREBASE: ${JSON.stringify({ hosts: [...deskHosts], accountButtons: accountButtons.length })}`);
await desk.waitForFunction(() => document.querySelector(".td-entries-status").textContent.includes("Still owed: $22"));
await desk.type("#td-player", "test pl");
await desk.waitForSelector("#td-players:not([hidden]) [role=option]");
await desk.keyboard.press("ArrowDown");
await desk.keyboard.press("Enter");
await desk.click(".td-register button[type=submit]");
// While the first saves, the form is clear and takes the next player.
const whileSaving = await desk.evaluate(() => ({ field: document.querySelector("#td-player").value,
  pending: document.querySelectorAll(".td-saving .td-save-pending").length }));
await desk.type("#td-player", "test pl");
await desk.waitForSelector("#td-players:not([hidden]) [role=option]");
await desk.keyboard.press("ArrowDown");
await desk.keyboard.press("Enter");
await desk.click(".td-register button[type=submit]");
await desk.waitForFunction(() => document.querySelectorAll(".td-saving .td-save-done").length === 2);
// A name nobody has registered with offers to ask US Chess, and only asks when pressed; a full
// ID nobody has registered with goes to US Chess on its own.
const searchesBefore = deskCalls.filter((c) => c.action === "search").length;
await desk.type("#td-player", "zed");
await desk.waitForSelector(".td-uschess:not([hidden])");
const askedWhileTyping = deskCalls.filter((c) => c.action === "search").length - searchesBefore;
await desk.click(".td-search-uschess");
await desk.waitForFunction(() => [...document.querySelectorAll("#td-players [role=option]")].some((o) => o.textContent.includes("Zed")));
const askedOnPress = deskCalls.filter((c) => c.action === "search").length - searchesBefore;
await desk.$eval("#td-player", (i) => { i.value = ""; });
await desk.type("#td-player", "87654321");
for (let waited = 0; waited < 5000 && deskCalls.filter((c) => c.action === "search").length - searchesBefore < 2; waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const askedForId = deskCalls.filter((c) => c.action === "search").length - searchesBefore;
askedWhileTyping === 0 && askedOnPress === 1 && askedForId === 2
  ? pass("TD desk searches past registrations first, and US Chess only for a new ID or when asked")
  : fail(`TD desk US Chess searches: while typing ${askedWhileTyping}, on press ${askedOnPress}, for an ID ${askedForId}`);
// Typing searches what loaded at sign-in, never the script; a contact who hasn't registered is looked up at US Chess.
await desk.$eval("#td-player", (i) => { i.value = ""; });
await desk.type("#td-player", "cora");
await desk.waitForFunction(() => [...document.querySelectorAll("#td-players [role=option]")].some((o) => o.textContent.includes("Cora Contact")));
const contactOption = await desk.$eval("#td-players [role=option]", (o) => o.textContent);
await desk.keyboard.press("ArrowDown");
await desk.keyboard.press("Enter");
for (let waited = 0; waited < 5000 && !deskCalls.some((c) => c.action === "search" && c.q === "Cora Contact"); waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
!deskCalls.some((c) => c.action === "history") && deskCalls.some((c) => c.action === "people") && contactOption.includes("contact")
  && deskCalls.some((c) => c.action === "search" && c.q === "Cora Contact")
  ? pass("TD desk searches its loaded players and contacts as you type, and looks a contact up at US Chess")
  : fail(`TD desk local search: ${JSON.stringify({ contactOption, calls: deskCalls.map((c) => c.action) })}`);
// The Contacts section: search, edit, add, and delete.
await desk.click(".td-contacts-panel summary");
await desk.type("#td-contacts-search", "cora");
const contactRows = await desk.$$eval(".td-contacts tbody tr", (rows) => rows.map((r) => r.cells[0].textContent));
await desk.click(".td-contacts tbody tr td:last-child button");
await desk.waitForSelector("dialog.td-contact[open]");
const phoneField = await desk.$('dialog.td-contact [name="Phone"]');
await phoneField.click({ clickCount: 3 });
await phoneField.type("970-555-0199");
await desk.click('dialog.td-contact [value="save"]');
await desk.waitForFunction(() => document.querySelector(".td-contacts-status").textContent.includes("saved"));
const saved = deskCalls.filter((c) => c.action === "contactSave").at(-1) || {};
const savedFields = JSON.parse(saved.fields || "{}");
await desk.click(".td-contacts-add");
await desk.waitForSelector("dialog.td-contact[open]");
const addDeleteHidden = await desk.$eval(".td-contact-delete", (b) => b.hidden);
await desk.type('dialog.td-contact [name="Name"]', "New Person");
await desk.click('dialog.td-contact [value="save"]');
for (let waited = 0; waited < 5000 && deskCalls.filter((c) => c.action === "contactSave").length < 2; waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const addedContact = deskCalls.filter((c) => c.action === "contactSave").at(-1) || {};
await desk.waitForFunction(() => !document.querySelector("dialog.td-contact").open);
await desk.click(".td-contacts tbody tr td:last-child button");
await desk.waitForSelector("dialog.td-contact[open]");
await desk.click(".td-contact-delete");
for (let waited = 0; waited < 5000 && !deskCalls.some((c) => c.action === "contactDelete"); waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
JSON.stringify(contactRows) === '["Cora Contact"]' && saved.id === "c1" && savedFields.Phone === "970-555-0199" && savedFields.Name === "Cora Contact"
  && addDeleteHidden && addedContact.id === "" && JSON.parse(addedContact.fields || "{}").Name === "New Person"
  && deskCalls.some((c) => c.action === "contactDelete" && c.id === "c1")
  ? pass("TD desk searches, edits, adds, and deletes contacts")
  : fail(`TD desk contacts: ${JSON.stringify({ contactRows, saved, addedContact, addDeleteHidden })}`);
await desk.waitForFunction(() => !document.querySelector("dialog.td-contact").open);
await desk.click(".td-contacts-panel summary");
await desk.click(".td-refresh");
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.startsWith("Refreshed"));
deskCalls.some((c) => c.action === "refresh") ? pass("TD desk refreshes the public pages' copies") : fail("TD desk didn't ask to refresh");
await desk.$eval("#td-player", (i) => { i.value = ""; i.dispatchEvent(new Event("input")); });
const sentByDesk = deskCalls.find((c) => c.action === "register") || {};
sentByDesk.email === "test@example.com" && sentByDesk.phone === "970-555-0100"
  ? pass("TD desk fills in a known player's email and phone") : fail(`TD desk contact: ${JSON.stringify(sentByDesk)}`);
sentByDesk.event === "club-night" && sentByDesk.date === "2026-10" && sentByDesk.id === "12345678"
  ? pass("TD desk finds a player and registers them") : fail(`TD desk sent ${JSON.stringify(sentByDesk)}`);
whileSaving.field === "" && whileSaving.pending === 1 && deskCalls.filter((c) => c.action === "register").length === 2
  ? pass("TD desk takes the next player while the last one saves") : fail(`TD desk while saving: ${JSON.stringify(whileSaving)}`);
await desk.click(".td-entries tbody tr td:nth-child(9) button");
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.includes("paid $15"));
deskCalls.some((c) => c.action === "paid" && c.token === "t1" && c.amount === "16.50" && c.by === "cash") ? pass("TD desk marks a player paid in cash")
  : fail(`TD desk paid call: ${JSON.stringify(deskCalls.filter((c) => c.action === "paid"))}`);
await desk.waitForSelector(".td-entries tbody tr td:nth-child(9) select:enabled");
await desk.select(".td-entries tbody tr td:nth-child(9) select", "card");
// Paying redraws the entries, and then asks for the Money list; the next click waits for that.
const ledgerCalls = deskCalls.filter((c) => c.action === "ledger").length;
await desk.click(".td-entries tbody tr td:nth-child(9) button");
for (let waited = 0; waited < 5000 && deskCalls.filter((c) => c.action === "ledger").length === ledgerCalls; waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
deskCalls.some((c) => c.action === "paid" && c.token === "t1" && c.amount === "17.42" && c.by === "card")
  ? pass("TD desk takes a card payment, starting from the fee with the card fee")
  : fail(`TD desk card payment: ${JSON.stringify(deskCalls.filter((c) => c.action === "paid"))}`);
const monthButtons = await desk.$$eval(".td-month", (b) => b.map((x) => x.closest("tr").cells[0].textContent));
const registersBefore = deskCalls.filter((c) => c.action === "register").length;
await desk.click(".td-month");
for (let waited = 0; waited < 5000 && deskCalls.filter((c) => c.action === "register").length === registersBefore; waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const toMonth = deskCalls.filter((c) => c.action === "register").at(-1);
JSON.stringify(monthButtons) === '["Night Player"]' && toMonth.date === "2026-10" && toMonth.id === "22345678"
  && toMonth.category === "Senior (65+)" && toMonth.email === "night@example.com" && toMonth.phone === "970-555-0102"
  ? pass("TD desk changes a night's entry to the whole month") : fail(`TD desk to month: ${JSON.stringify({ monthButtons, toMonth })}`);
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.includes("registered"));
await desk.waitForSelector(".td-month:enabled");
const money = await desk.$$eval(".td-ledger li", (items) => items.map((i) => i.textContent));
money.length === 4 && money[0].includes("cash $15") && money[2].includes("$3 for the 6 rated games")
  ? pass("TD desk shows the money received by method and how it splits") : fail(`TD desk Money: ${JSON.stringify(money)}`);
await desk.click(".td-entries tbody tr td:nth-last-child(2) button");
await desk.waitForSelector("dialog.td-incident[open]");
await desk.select("#td-action", "Game loss");
await desk.type("#td-round", "2");
await desk.type("#td-reason", "Test reason");
await desk.type("#td-name", "Test TD");
await desk.click('dialog.td-incident [value="log"]');
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.includes("Logged"));
const logged = deskCalls.find((c) => c.action === "incident") || {};
logged.action_taken === "Game loss" && logged.round === "2" && logged.id === "12345678" && logged.td === "Test TD"
  ? pass("TD desk logs an incident") : fail(`TD desk incident: ${JSON.stringify(logged)}`);
await desk.evaluate(axeSource);
const deskAxe = await desk.evaluate(() => axe.run());
deskAxe.violations.length ? fail(`TD desk signed in: ${deskAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("TD desk signed in has no axe violations");
await desk.click(".td-entries tbody tr td:last-child button");
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.includes("withdrawn"));
deskCalls.some((c) => c.action === "remove" && c.token === "t1") ? pass("TD desk removes an entry")
  : fail("TD desk didn't remove the entry");
await desk.close();

// Changes from another desk or the website, against a stand-in whose change stamps move: the desk
// reloads what changed, but not while the TD is using a menu in the entries or filling in the start.
const live = await browser.newPage();
live.on("pageerror", (error) => fail(`JavaScript error on /td/ following changes: ${error.message}`));
// The desk checks every ten seconds; here, every tenth of a second.
await live.evaluateOnNewDocument(() => {
  const every = window.setInterval;
  window.setInterval = (f, ms, ...rest) => every(f, ms === 10000 ? 100 : ms, ...rest);
});
const liveCalls = [];
const stamps = { entries: "a", tournaments: "a", contacts: "a" };
const liveEntries = [{ name: "First Player", id: "11111111", rating: "1500", for: "Whole month", category: "Adult", amount: "16.50",
  due: "16.50", card: "17.42", email: "", expires: "2027-01-31", token: "t1", date: "2026-10" }];
await live.setRequestInterception(true);
live.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
    return;
  }
  if (url.host !== "registration.test") return request.continue();
  const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
  liveCalls.push(p);
  const body = { login: { ok: true, changes: { ...stamps } }, changes: { changes: { ...stamps } },
    choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" }] },
    people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: liveEntries },
    ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
    incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true };
  request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
});
const callsOf = (action) => liveCalls.filter((c) => c.action === action).length;
const rowNames = () => live.$$eval(".td-entries tbody tr", (rows) => rows.map((r) => r.cells[0].textContent));
await live.goto(base + "/td/", { waitUntil: "networkidle0" });
await live.type("#td-password", "secret");
await live.click(".td-login button");
await live.waitForFunction(() => document.querySelectorAll(".td-entries tbody tr").length === 1);
await live.waitForFunction(() => !document.querySelector(".run-start").hidden);
await new Promise((resolve) => setTimeout(resolve, 500));
const quiet = { entries: callsOf("entries"), tournament: callsOf("tournament"), people: callsOf("people") };
quiet.entries === 1 && quiet.tournament === 1 && quiet.people === 1 && callsOf("changes") > 2
  ? pass("TD desk checks for changes and reloads nothing while nothing changes")
  : fail(`TD desk reloaded with nothing changed: ${JSON.stringify(quiet)}`);

liveEntries.push({ ...liveEntries[0], name: "Web Registrant", id: "22222222", token: "t2" });
stamps.entries = "b";
const shown = await live.waitForFunction(() => [...document.querySelectorAll(".td-entries tbody tr")]
  .some((r) => r.cells[0].textContent === "Web Registrant"), { timeout: 3000 }).then(() => true, () => false);
shown && callsOf("people") === 2 ? pass("TD desk shows a registration made elsewhere without a reload")
  : fail(`TD desk didn't show the new registration: ${JSON.stringify(await rowNames())}`);

await live.focus(".td-entries .td-method");
liveEntries.push({ ...liveEntries[0], name: "Held Back", id: "33333333", token: "t3" });
stamps.entries = "c";
await new Promise((resolve) => setTimeout(resolve, 600));
const whileChoosing = await rowNames();
await live.$eval(".td-entries .td-method", (m) => m.blur());
const afterLeaving = await live.waitForFunction(() => [...document.querySelectorAll(".td-entries tbody tr")]
  .some((r) => r.cells[0].textContent === "Held Back"), { timeout: 3000 }).then(() => true, () => false);
!whileChoosing.includes("Held Back") && afterLeaving
  ? pass("TD desk holds a change back while the TD is choosing how someone paid, and shows it after")
  : fail(`TD desk changed the entries under the TD: ${JSON.stringify({ whileChoosing, afterLeaving })}`);

const runLoads = callsOf("tournament");
stamps.tournaments = "b";
const reloaded = await new Promise((resolve) => {
  const started = Date.now();
  const check = () => (callsOf("tournament") > runLoads ? resolve(true) : Date.now() - started > 3000 ? resolve(false) : setTimeout(check, 50));
  check();
});
await live.type("#run-rounds", "5");
await live.$eval("#run-rounds", (i) => i.blur());
const whileStarting = callsOf("tournament");
stamps.tournaments = "c";
await new Promise((resolve) => setTimeout(resolve, 600));
reloaded && callsOf("tournament") === whileStarting && (await live.$eval("#run-rounds", (i) => i.value)) === "5"
  ? pass("TD desk reloads a tournament changed elsewhere, but not over a start being filled in")
  : fail(`TD desk tournament reloads: ${JSON.stringify({ reloaded, before: whileStarting, after: callsOf("tournament") })}`);
await live.close();

// With LIVE_DB set, the desk follows the change stamps in the database instead of asking the script
// every ten seconds (here a tenth of a second), and asks again only while the stream is down.
const followDesk = async (stream) => {
  const state = { calls: [], stamps: { entries: "a", tournaments: "a", contacts: "a" },
    entries: [{ ...liveEntries[0], name: "First Player" }] };
  const tab = await mocked("/td/ following the live database", (p) => {
    state.calls.push(p);
    return { login: { ok: true, changes: { ...state.stamps } }, changes: { changes: { ...state.stamps } },
      choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" }] },
      people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: state.entries },
      ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
      incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true };
  }, null, (path) => (path === "/changes" ? stream(state) : null));
  await tab.evaluateOnNewDocument(() => {
    const every = window.setInterval;
    window.setInterval = (f, ms, ...rest) => every(f, ms === 10000 ? 100 : ms, ...rest);
  });
  await tab.goto(base + "/td/", { waitUntil: "domcontentloaded" });
  await tab.type("#td-password", "secret");
  await tab.click(".td-login button");
  await tab.waitForFunction(() => document.querySelectorAll(".td-entries tbody tr").length === 1);
  state.tab = tab;
  state.callsOf = (action) => state.calls.filter((c) => c.action === action).length;
  state.registers = async (name) => {
    state.entries = [...state.entries, { ...state.entries[0], name, token: name }];
    state.stamps = { ...state.stamps, entries: name };
    return tab.waitForFunction((n) => [...document.querySelectorAll(".td-entries tbody tr")].some((r) => r.cells[0].textContent === n),
      { timeout: 3000 }, name).then(() => true, () => false);
  };
  return state;
};
const streamed = await followDesk((state) => [["put", { path: "/", data: state.stamps }], ["keep-alive", null]]);
await new Promise((resolve) => setTimeout(resolve, 1000));
const polledWhileStreaming = streamed.callsOf("changes");
const streamedShown = await streamed.registers("Streamed Registrant");
streamedShown && polledWhileStreaming === 0 && streamed.callsOf("changes") === 0 && streamed.callsOf("people") === 2
  ? pass("TD desk follows the live database's change stamps, reloads the entries on a new one, and doesn't ask the script every ten seconds")
  : fail(`TD desk following the database: ${JSON.stringify({ streamedShown, polledWhileStreaming, people: streamed.callsOf("people") })}`);
await streamed.tab.close();
const unstreamed = await followDesk(() => null);
await new Promise((resolve) => setTimeout(resolve, 600));
const polledWhileDown = unstreamed.callsOf("changes");
const polledShown = await unstreamed.registers("Polled Registrant");
polledWhileDown > 2 && polledShown
  ? pass("TD desk asks the script for changes while the live database refuses the stream")
  : fail(`TD desk without the stream: ${JSON.stringify({ polledWhileDown, polledShown })}`);
await unstreamed.tab.close();

// With FIREBASE set, TDs sign in with Firebase Authentication. The SDK's modules are served by
// stand-ins with the same functions: an account signs in by the provider or emailed link that
// fake.accounts names, and stays signed in across reloads, as the SDK keeps it. The script's
// stand-in answers each account's ID token as the real script would: a listed TD, an unlisted
// one, or one whose provider hasn't confirmed the email.
const FAKE_CONFIG = { apiKey: "test-key", authDomain: "lccc-test.firebaseapp.com", projectId: "lccc-test", appId: "1:2:web:3" };
const fakeAuthModule = (fake) => `
const fake = ${JSON.stringify(fake)};
const log = (...call) => sessionStorage.setItem("fakeCalls", JSON.stringify([...JSON.parse(sessionStorage.getItem("fakeCalls") || "[]"), call]));
const listeners = [];
const asUser = (data) => data && { ...data, getIdToken: async () => data.token };
// Each tab's own key, since they share localStorage.
const KEY = "fakeUser " + fake.label;
export const auth = { currentUser: asUser(JSON.parse(localStorage.getItem(KEY))) };
function setUser(data) {
  if (data) localStorage.setItem(KEY, JSON.stringify(data));
  else localStorage.removeItem(KEY);
  auth.currentUser = asUser(data);
  for (const listener of listeners) setTimeout(() => listener(auth.currentUser));
}
export function getAuth(app) { log("getAuth", app.options); return auth; }
export class GoogleAuthProvider { providerId = "google.com"; setCustomParameters(p) { this.parameters = p; } }
export class OAuthProvider { constructor(id) { this.providerId = id; } setCustomParameters(p) { this.parameters = p; } }
export async function signInWithPopup(a, provider) {
  log("signInWithPopup", provider.providerId, provider.parameters);
  if (fake.popupBlocked) throw Object.assign(new Error("blocked"), { code: "auth/popup-blocked" });
  setUser(fake.accounts[provider.providerId]);
}
export async function signInWithRedirect(a, provider) {
  log("signInWithRedirect", provider.providerId);
  sessionStorage.setItem("fakeRedirect", provider.providerId);
  setTimeout(() => location.reload());
  return new Promise(() => {});
}
export async function getRedirectResult() {
  const id = sessionStorage.getItem("fakeRedirect");
  if (!id) return null;
  sessionStorage.removeItem("fakeRedirect");
  setUser(fake.accounts[id]);
  return { user: auth.currentUser };
}
export async function sendSignInLinkToEmail(a, email, settings) { log("sendSignInLinkToEmail", email, settings); }
export function isSignInWithEmailLink(a, href) { return new URL(href).searchParams.get("mode") === "signIn"; }
export async function signInWithEmailLink(a, email, href) {
  log("signInWithEmailLink", email, new URL(href).searchParams.get("oobCode"));
  if (new URL(href).searchParams.get("oobCode") === "spent") throw Object.assign(new Error("spent"), { code: "auth/invalid-action-code" });
  setUser({ ...fake.accounts.email, email });
}
export function onAuthStateChanged(a, listener) {
  listeners.push(listener);
  if (!fake.stalled) setTimeout(() => listener(auth.currentUser));
  return () => listeners.splice(listeners.indexOf(listener), 1);
}
export async function sendEmailVerification(user, settings) { log("sendEmailVerification", user.email, settings); }
export async function signOut() { log("signOut"); setUser(null); }
`;
const deskTDs = {
  "token-ada": { ok: true, td: { email: "ada@example.com", name: "Ada Director", usChessId: "12345678" } },
  "token-link": { ok: true, td: { email: "link@example.com", name: "Lin Kemail", usChessId: "" } },
  "token-unlisted": { login: true, error: "outsider@example.com isn't one of the club's TDs." },
  "token-unverified": { verify: true },
};
async function firebaseDesk(label, fake, viewport) {
  // held: a promise by action that its answer waits for.
  const state = { calls: [], gstatic: [], held: {} };
  const tab = await browser.newPage();
  tab.on("pageerror", (error) => fail(`JavaScript error on ${label}: ${error.message}`));
  if (viewport) await tab.setViewport(viewport);
  // Whether a sign-in button has shown since the page loaded, checked whenever something is shown or hidden.
  await tab.evaluateOnNewDocument(() => {
    window.sawSignIn = false;
    new MutationObserver(() => {
      if (document.querySelector(".td-google")?.checkVisibility()) window.sawSignIn = true;
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
  });
  await tab.setRequestInterception(true);
  tab.on("request", async (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/register.js") {
      const source = offline(await (await fetch(base + "/register.js")).text());
      request.respond({ contentType: "text/javascript", body: source.replace(/^const FIREBASE = null;$/m, `const FIREBASE = ${JSON.stringify(FAKE_CONFIG)};`) });
    } else if (url.host === "www.gstatic.com") {
      state.gstatic.push(url.pathname);
      const name = url.pathname.match(/^\/firebasejs\/[\d.]+\/(firebase-app|firebase-auth)\.js$/)?.[1];
      request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "text/javascript",
        body: name === "firebase-app" ? "export const initializeApp = (options) => ({ options });" : name ? fakeAuthModule({ ...fake, label }) : "" });
    } else if (url.host === "registration.test") {
      const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
      state.calls.push(p);
      await state.held[p.action];
      const who = deskTDs[p.idToken] || { login: true, error: "Sign in first." };
      const body = !who.ok ? who : {
        login: { ...who, changes: null },
        choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" }] },
        people: { players: [] }, contacts: { headings: ["Name"], contacts: [] },
        entries: { entries: [{ name: "Test Player", id: "12345678", rating: "1500", for: "Whole month", category: "Adult", amount: "16.50", due: "16.50", card: "17.42", email: "", expires: "2027-01-31", token: "t1", date: "2026-10" }] },
        ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
        incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true };
      request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
    } else if (url.host === "127.0.0.1" || url.host === new URL(base).host) {
      request.continue();
    } else {
      request.abort();
    }
  });
  state.tab = tab;
  state.fakeCalls = () => tab.evaluate(() => JSON.parse(sessionStorage.getItem("fakeCalls") || "[]"));
  state.status = () => tab.$eval(".td-login-status", (s) => s.textContent);
  state.sawSignIn = () => tab.evaluate(() => window.sawSignIn);
  state.signedIn = () => tab.waitForSelector(".td-desk:not([hidden])", { timeout: 3000 }).then(() => true, () => false);
  state.signedOut = (text) => tab.waitForFunction((t) => !document.querySelector(".td-login").hidden
    && document.querySelector(".td-desk").hidden && document.querySelector(".td-login-status").textContent.includes(t), { timeout: 3000 }, text)
    .then(() => true, () => false);
  return state;
}

const google = await firebaseDesk("/td/ with Firebase", { accounts: { "google.com": { uid: "ada", email: "ada@example.com", token: "token-ada" } } });
await google.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
const accountForm = await google.tab.evaluate(() => ({
  password: Boolean(document.querySelector(".td-login input[type=password]")),
  buttons: [...document.querySelectorAll(".td-login button")].filter((b) => b.checkVisibility()).map((b) => b.textContent),
  email: document.querySelector(".td-login input[type=email]")?.checkVisibility(),
}));
!accountForm.password && accountForm.email
  && JSON.stringify(accountForm.buttons) === JSON.stringify(["Sign in with Google", "Email me a sign-in link"])
  ? pass("TD desk with Firebase offers Google and an emailed link, and no password")
  : fail(`TD desk Firebase sign-in form: ${JSON.stringify(accountForm)}`);
await axeBoth(google.tab, "TD desk Firebase sign-in form");
await google.tab.setViewport({ width: 390, height: 844 });
await fitsPhone(google.tab, "TD desk Firebase sign-in form");
await google.tab.setViewport({ width: 1100, height: 800 });
await google.tab.click(".td-google");
const googleIn = await google.signedIn();
const googleCalls = google.calls.filter((c) => c.action === "login");
const shownAs = await google.tab.$eval(".td-who", (w) => (w.checkVisibility() ? w.textContent : ""));
const popup = (await google.fakeCalls()).find((c) => c[0] === "signInWithPopup");
googleIn && googleCalls.length === 1 && google.calls.every((c) => c.idToken === "token-ada" && !("password" in c) && !("device" in c))
  && shownAs === "Signed in as Ada Director" && popup?.[2]?.prompt === "select_account"
  ? pass("TD desk signs in with Google, sends the ID token and no password, and shows the TD's name")
  : fail(`TD desk Google sign-in: ${JSON.stringify({ googleIn, googleCalls, shownAs, popup })}`);
const initialized = (await google.fakeCalls()).find((c) => c[0] === "getAuth")?.[1];
JSON.stringify(initialized) === JSON.stringify(FAKE_CONFIG) ? pass("TD desk starts Firebase with FIREBASE from register.js")
  : fail(`TD desk Firebase config: ${JSON.stringify(initialized)}`);
await google.tab.click(".td-entries tbody tr td:nth-last-child(2) button");
await google.tab.waitForSelector("dialog.td-incident[open]");
const incidentTd = await google.tab.$eval("#td-name", (i) => i.value);
incidentTd === "Ada Director" ? pass("TD desk fills in the incident's TD from the sign-in")
  : fail(`TD desk incident TD name: "${incidentTd}"`);
await google.tab.click('dialog.td-incident [value="cancel"]');
await google.tab.reload({ waitUntil: "networkidle0" });
const keptIn = await google.signedIn();
const keptQuietly = !(await google.sawSignIn());
keptIn && keptQuietly && google.calls.filter((c) => c.action === "login").length === 2
  ? pass("TD desk stays signed in with Firebase across a reload, without showing the sign-in buttons")
  : fail(`TD desk with Firebase on reload: ${JSON.stringify({ keptIn, keptQuietly })}`);
await google.tab.click(".td-sign-out");
const outAfter = await google.signedOut("Signed out.");
const outFake = (await google.fakeCalls()).some((c) => c[0] === "signOut");
await google.tab.reload({ waitUntil: "networkidle0" });
const stillOut = !(await google.signedIn());
outAfter && outFake && stillOut ? pass("TD desk's Sign out signs out of Firebase too")
  : fail(`TD desk Firebase sign-out: ${JSON.stringify({ outAfter, outFake, stillOut })}`);
await google.tab.click(".td-google");
await google.signedIn();
await google.tab.evaluate(() => import(performance.getEntriesByType("resource").find((r) => r.name.endsWith("/firebase-auth.js")).name)
  .then((sdk) => sdk.signOut()));
(await google.signedOut("Your sign-in has ended.")) ? pass("TD desk signs out when Firebase ends the session, as when another tab signs out")
  : fail(`TD desk kept the desk open after Firebase ended the session: "${await google.status()}"`);
await google.tab.close();

// The desk asks for the event list while the sign-in is being checked, and for the ledger, incidents,
// and tournament while the entries are, since each call to the script takes a second or more.
const eager = await firebaseDesk("/td/ loading at once", { accounts: { "google.com": { uid: "ada", email: "ada@example.com", token: "token-ada" } } });
const hold = (action) => new Promise((resolve) => { eager.held[action] = new Promise((release) => resolve(release)); });
const releaseLogin = await hold("login");
const releaseEntries = await hold("entries");
const askedFor = async (actions) => {
  for (let i = 0; i < 60 && !actions.every((a) => eager.calls.some((c) => c.action === a)); i++) await new Promise((r) => setTimeout(r, 50));
  return actions.every((a) => eager.calls.some((c) => c.action === a));
};
await eager.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
await eager.tab.click(".td-google");
const choicesEarly = await askedFor(["login", "choices"]);
releaseLogin();
const restEarly = await askedFor(["entries", "ledger", "incidents", "tournament"]);
releaseEntries();
const eagerIn = await eager.signedIn();
const eagerRows = await eager.tab.waitForSelector(".td-entries tbody tr", { timeout: 3000 }).then(() => true, () => false);
choicesEarly && restEarly && eagerIn && eagerRows
  ? pass("TD desk asks for the events with the sign-in, and for the ledger, incidents, and tournament with the entries")
  : fail(`TD desk loading at once: ${JSON.stringify({ choicesEarly, restEarly, eagerIn, eagerRows, calls: eager.calls.map((c) => c.action) })}`);
await eager.tab.close();

// On a phone, Firebase can hang looking for a saved sign-in and never report one; the desk says so,
// without the buttons, since the TD may well be signed in.
const stalled = await firebaseDesk("/td/ with Firebase stalled", { stalled: true, accounts: {} }, { width: 390, height: 844 });
await stalled.tab.goto(base + "/td/", { waitUntil: "load" });
const stalledForm = await stalled.tab.waitForFunction(() => !document.querySelector(".td-login").hidden
  && !document.querySelector(".td-google").checkVisibility()
  && document.querySelector(".td-login-status").textContent.includes("taking too long"), { timeout: 9000 }).then(() => true, () => false);
stalledForm ? pass("TD desk says so, without sign-in buttons, when Firebase never reports a saved sign-in")
  : fail(`TD desk while Firebase stalled: "${await stalled.status()}"`);
await stalled.tab.close();

// A popup the browser blocks falls back to a redirect.
const blocked = await firebaseDesk("/td/ with a blocked popup", { popupBlocked: true,
  accounts: { "google.com": { uid: "ada", email: "ada@example.com", token: "token-ada" } } });
await blocked.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
await blocked.tab.click(".td-google");
const redirected = await blocked.signedIn();
const redirectQuiet = !(await blocked.sawSignIn());
const redirectCalls = (await blocked.fakeCalls()).map((c) => c.slice(0, 2).join(" "));
redirected && redirectQuiet && redirectCalls.includes("signInWithRedirect google.com")
  ? pass("TD desk signs in with Google by redirect when the popup is blocked")
  : fail(`TD desk redirect: ${JSON.stringify({ redirected, redirectQuiet, redirectCalls })}`);
await blocked.tab.close();

const unlisted = await firebaseDesk("/td/ with an unlisted TD", { accounts: {
  "google.com": { uid: "x", email: "outsider@example.com", token: "token-unlisted" } } });
await unlisted.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
await unlisted.tab.click(".td-google");
const refusedOut = await unlisted.signedOut("isn't one of the club's TDs");
const refusedFake = (await unlisted.fakeCalls()).filter((c) => c[0] === "signOut").length;
refusedOut && refusedFake === 1
  ? pass("TD desk signs an unlisted account out of Firebase with the script's message")
  : fail(`TD desk unlisted: ${JSON.stringify({ refusedOut, refusedFake, status: await unlisted.status() })}`);
await unlisted.tab.close();
const unconfirmed = await firebaseDesk("/td/ with an unconfirmed address", { accounts: {
  "google.com": { uid: "u", email: "unverified@example.com", token: "token-unverified" } } });
await unconfirmed.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
await unconfirmed.tab.click(".td-google");
const verifyOut = await unconfirmed.signedOut("Check your email for a link to confirm your address, then sign in again.");
const verifySent = (await unconfirmed.fakeCalls()).find((c) => c[0] === "sendEmailVerification");
verifyOut && verifySent?.[1] === "unverified@example.com" && verifySent[2]?.url === base + "/td/"
  ? pass("TD desk asks the provider to confirm an unconfirmed email and says so")
  : fail(`TD desk verify: ${JSON.stringify({ verifyOut, verifySent, status: await unconfirmed.status() })}`);
await unconfirmed.tab.close();

// The emailed link: asked for here, and opened on this device, and on another, which asks for the address.
const emailed = await firebaseDesk("/td/ by an emailed link", { accounts: { email: { uid: "lin", token: "token-link" } } });
await emailed.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
await emailed.tab.type("#td-login-email", "link@example.com");
await emailed.tab.click(".td-email-link");
await emailed.tab.waitForFunction(() => document.querySelector(".td-login-status").textContent.includes("link@example.com"));
const linkSent = (await emailed.fakeCalls()).find((c) => c[0] === "sendSignInLinkToEmail");
const linkKept = await emailed.tab.evaluate(() => localStorage.getItem("lccc-td-email"));
await emailed.tab.goto(base + "/td/?apiKey=test-key&mode=signIn&oobCode=abc", { waitUntil: "networkidle0" });
const linkedIn = await emailed.signedIn();
const linkQuiet = !(await emailed.sawSignIn());
const completed = (await emailed.fakeCalls()).find((c) => c[0] === "signInWithEmailLink");
const cleaned = await emailed.tab.evaluate(() => ({ search: location.search, kept: localStorage.getItem("lccc-td-email") }));
linkSent?.[1] === "link@example.com" && linkSent[2]?.url === base + "/td/" && linkSent[2]?.handleCodeInApp === true && linkKept === "link@example.com"
  && linkedIn && linkQuiet && JSON.stringify(completed) === JSON.stringify(["signInWithEmailLink", "link@example.com", "abc"])
  && cleaned.search === "" && cleaned.kept === null
  && (await emailed.tab.$eval(".td-who", (w) => w.textContent)) === "Signed in as Lin Kemail"
  ? pass("TD desk sends a sign-in link and signs in when it's opened")
  : fail(`TD desk email link: ${JSON.stringify({ linkSent, linkKept, linkedIn, linkQuiet, completed, cleaned })}`);
await emailed.tab.click(".td-sign-out");
await emailed.signedOut("Signed out.");
await emailed.tab.goto(base + "/td/?apiKey=test-key&mode=signIn&oobCode=def", { waitUntil: "networkidle0" });
const asked = await emailed.status();
const finishLabel = await emailed.tab.$eval(".td-email-link", (b) => b.textContent);
await emailed.tab.type("#td-login-email", "link@example.com");
await emailed.tab.click(".td-email-link");
const otherDevice = await emailed.signedIn();
const completedHere = (await emailed.fakeCalls()).filter((c) => c[0] === "signInWithEmailLink").at(-1);
asked.includes("Enter the email address") && finishLabel === "Finish signing in" && otherDevice && completedHere?.[2] === "def"
  ? pass("TD desk asks for the address when a sign-in link is opened on another device")
  : fail(`TD desk email link elsewhere: ${JSON.stringify({ asked, finishLabel, otherDevice, completedHere })}`);
await emailed.tab.click(".td-sign-out");
await emailed.signedOut("Signed out.");
await emailed.tab.evaluate(() => localStorage.setItem("lccc-td-email", "link@example.com"));
await emailed.tab.goto(base + "/td/?apiKey=test-key&mode=signIn&oobCode=spent", { waitUntil: "networkidle0" });
const spent = await emailed.status();
const spentLeft = await emailed.tab.evaluate(() => location.search);
spent.includes("expired or was already used") && spentLeft === "" && !(await emailed.signedIn())
  ? pass("TD desk says when a sign-in link was already used, and offers a new one")
  : fail(`TD desk spent link: ${JSON.stringify({ spent, spentLeft })}`);
await emailed.tab.close();

// The Entries page, against a stand-in for the Apps Script's ?entries=all.
const entriesPage = await browser.newPage();
entriesPage.on("pageerror", (error) => fail(`JavaScript error on /entries/: ${error.message}`));
await entriesPage.setRequestInterception(true);
entriesPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
  } else if (url.host === "registration.test") {
    const events = [
      { key: "club-night/2026-10-12", name: "Club Night", label: "Monday, October 12, 2026", page: "/events/club-night/",
        start: "2026-10-12T18:30:00-06:00", entries: [{ name: "Test Player", id: "12345678", rating: "1500", for: "Whole month" }] },
      { key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", page: "/events/classic/",
        start: "2026-11-07T10:00:00-07:00", entries: [] },
    ];
    request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ events }) });
  } else {
    request.continue();
  }
});
await entriesPage.goto(base + "/entries/", { waitUntil: "networkidle0" });
const entriesShown = () => entriesPage.evaluate(() => ({
  choices: [...document.querySelectorAll("#entries-event option")].map((o) => o.textContent),
  groups: [...document.querySelectorAll("#entries-event optgroup")].map((g) => g.label),
  title: document.querySelector(".entries-all h2")?.textContent, rows: document.querySelectorAll(".entries-all tbody tr").length,
  register: document.querySelector(".entries-all a.button")?.getAttribute("href"), address: location.search }));
const entriesOpened = await entriesShown();
JSON.stringify(entriesOpened.groups) === JSON.stringify(["October 2026", "November 2026"]) && entriesOpened.choices.length === 2
  && entriesOpened.title === "Club Night" && entriesOpened.rows === 1 && entriesOpened.register === "/events/club-night/?date=2026-10-12#register"
  ? pass("Entries page opens on the soonest event, with its players and a Register link")
  : fail(`Entries page on open: ${JSON.stringify(entriesOpened)}`);
await entriesPage.select("#entries-event", "classic/2026-11-07");
const entriesChosen = await entriesShown();
entriesChosen.title === "Classic" && entriesChosen.rows === 0 && entriesChosen.address === "?event=classic%2F2026-11-07"
  ? pass("Entries page shows the event the reader picks, and keeps it in the address") : fail(`Entries page after choosing: ${JSON.stringify(entriesChosen)}`);
await entriesPage.goto(base + "/entries/?event=classic%2F2026-11-07", { waitUntil: "networkidle0" });
(await entriesShown()).title === "Classic" ? pass("Entries page opens on the event in its address") : fail("Entries page ignored ?event=");
await entriesPage.evaluate(axeSource);
const entriesAxe = await entriesPage.evaluate(() => axe.run());
entriesAxe.violations.length ? fail(`Entries page filled: ${entriesAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("Entries page filled has no axe violations");
await entriesPage.close();

// With LIVE_DB set, the Entries page shows the database's copy of the lists, less the days gone since it
// was built, while the script is still answering, and then the script's lists.
const quickPage = await browser.newPage();
quickPage.on("pageerror", (error) => fail(`JavaScript error on /entries/ from the copy: ${error.message}`));
let releaseScript;
const scriptHeld = new Promise((resolve) => { releaseScript = resolve; });
const copyEvent = (name, entrant) => ({ key: `${name.toLowerCase()}/2099-11-07`, name, label: "Saturday, November 7, 2099",
  page: `/events/${name.toLowerCase()}/`, start: "2099-11-07T10:00:00-07:00", entries: [{ name: entrant, id: "12345678", rating: "1500" }] });
const gone = { ...copyEvent("Gone", "Past Player"), key: "gone/2020-01-04", start: "2020-01-04T10:00:00-07:00" };
await quickPage.setRequestInterception(true);
quickPage.on("request", async (request) => {
  const url = new URL(request.url());
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (url.pathname === "/register.js") {
    const source = offline(await (await fetch(base + "/register.js")).text());
    request.respond({ contentType: "text/javascript", body: source.replace(/^const LIVE_DB = ".*";$/m, 'const LIVE_DB = "https://live.test";') });
  } else if (url.host === "live.test" && url.pathname === "/public/entries.json") {
    request.respond({ headers: cors, contentType: "application/json", body: JSON.stringify(JSON.stringify([gone, copyEvent("Classic", "Copy Player")])) });
  } else if (url.host === "registration.test") {
    await scriptHeld;
    request.respond({ headers: cors, contentType: "application/json", body: JSON.stringify({ events: [copyEvent("Classic", "Fresh Player")] }) });
  } else {
    request.continue();
  }
});
await quickPage.goto(base + "/entries/");
const fromCopy = await quickPage.waitForSelector(".entries-all tbody tr", { timeout: 3000 }).then(() => quickPage.evaluate(() => ({
  choices: [...document.querySelectorAll("#entries-event option")].map((o) => o.value),
  rows: [...document.querySelectorAll(".entries-all tbody tr")].map((r) => r.cells[0].textContent) })), () => null);
releaseScript();
const fromScript = await quickPage.waitForFunction(() => document.querySelector(".entries-all tbody tr")?.cells[0].textContent === "Fresh Player",
  { timeout: 3000 }).then(() => true, () => false);
JSON.stringify(fromCopy) === JSON.stringify({ choices: ["classic/2099-11-07"], rows: ["Copy Player"] }) && fromScript
  ? pass("Entries page shows the database's copy, less past days, before the script answers, then the script's lists")
  : fail(`Entries page from the copy: ${JSON.stringify({ fromCopy, fromScript })}`);
await quickPage.close();

// A player saved on this device, registered for one club night, switches to its whole month.
const switchPage = await browser.newPage();
switchPage.on("pageerror", (error) => fail(`JavaScript error on /entries/ switching: ${error.message}`));
const switchSaved = await switchPage.evaluateOnNewDocument(() => localStorage.setItem("lccc-register-players",
  JSON.stringify([{ id: "22345678", last: "Player", email: "night@example.com", name: "Night Player" }])));
switchPage.on("dialog", (d) => d.accept());
const switchCalls = [];
await switchPage.setRequestInterception(true);
switchPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
  } else if (url.pathname === "/events.json") {
    request.respond({ contentType: "application/json", body: JSON.stringify([
      { page: "/events/club-night/", start: "2026-10-12T18:30:00-06:00", tags: ["casual"] },
      { page: "/events/classic/", start: "2026-11-07T10:00:00-07:00", tags: ["tournament"] }]) });
  } else if (url.host === "registration.test") {
    if (request.method() === "POST") switchCalls.push(Object.fromEntries(new URLSearchParams(request.postData())));
    const moved = switchCalls.length === 1;
    const body = request.method() === "POST" ? { ok: true, message: switchCalls.length === 1
      ? "Night Player is registered for all Mondays in October 2026. Due when you arrive: $9.50."
      : "Night Player is registered for Monday, October 12, 2026 only. Due when you arrive: $7.50." }
      : { events: [
        { key: "club-night/2026-10-12", name: "Club Night", label: "Monday, October 12, 2026", page: "/events/club-night/", start: "2026-10-12T18:30:00-06:00",
          entries: [{ name: "Test Player", id: "12345678", rating: "1500", for: "Monday, October 12" },
            { name: "Night Player", id: "22345678", rating: "1400", for: moved ? "Whole month" : "Monday, October 12" }] },
        { key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", page: "/events/classic/", start: "2026-11-07T10:00:00-07:00",
          entries: [{ name: "Night Player", id: "22345678", rating: "1400", for: "Saturday, November 7" }] }] };
    request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
  } else {
    request.continue();
  }
});
await switchPage.goto(base + "/entries/", { waitUntil: "networkidle0" });
const switchers = await switchPage.$$eval(".entries-switch", (b) => b.map((x) => x.closest("tr").cells[0].textContent));
(await switchPage.$$(".entries-all a.button")).length === 0 ? pass("Entries page hides Register when the latest player saved here is registered")
  : fail("Entries page shows Register to a player saved here who is registered");
await switchPage.evaluate(axeSource);
const switchAxe = await switchPage.evaluate(() => axe.run());
switchAxe.violations.length ? fail(`Entries page with a switch: ${switchAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("Entries page with a switch has no axe violations");
await switchPage.click(".entries-switch");
await switchPage.waitForFunction(() => document.querySelector(".entries-all-status").textContent.includes("all Mondays"));
const afterSwitch = await switchPage.evaluate(() => ({ buttons: [...document.querySelectorAll(".entries-switch")].map((b) => b.firstChild.textContent),
  for: [...document.querySelectorAll(".entries-all tbody tr")].map((r) => r.cells[3].firstChild.textContent) }));
JSON.stringify(switchers) === '["Night Player"]' && JSON.stringify(switchCalls) === JSON.stringify([{ event: "club-night", date: "2026-10", id: "22345678",
  last: "Player", email: "night@example.com" }]) && JSON.stringify(afterSwitch.buttons) === '["Just this night"]' && afterSwitch.for.includes("Whole month")
  ? pass("Entries page lets a saved player switch a club night to its whole month")
  : fail(`Entries page switch: ${JSON.stringify({ switchers, switchCalls, afterSwitch })}`);
await switchPage.click(".entries-switch");
await switchPage.waitForFunction(() => document.querySelector(".entries-all-status").textContent.includes("only"));
const backToNight = await switchPage.evaluate(() => ({ buttons: [...document.querySelectorAll(".entries-switch")].map((b) => b.firstChild.textContent),
  for: [...document.querySelectorAll(".entries-all tbody tr")].map((r) => r.cells[3].firstChild.textContent) }));
JSON.stringify(switchCalls[1]) === JSON.stringify({ action: "toNight", event: "club-night", date: "2026-10-12", id: "22345678", last: "Player",
  email: "night@example.com" }) && JSON.stringify(backToNight) === JSON.stringify({ buttons: ["Switch to month"], for: ["This night", "This night"] })
  ? pass("Entries page lets a saved player switch a whole month back to just this night")
  : fail(`Entries page switch to a night: ${JSON.stringify({ call: switchCalls[1], backToNight })}`);
await switchPage.select("#entries-event", "classic/2026-11-07");
(await switchPage.$$(".entries-switch")).length === 0 ? pass("Entries page offers no switch for a tournament")
  : fail("Entries page offers a switch for a tournament");
const siblingSaved = await switchPage.evaluateOnNewDocument(() => localStorage.setItem("lccc-register-players", JSON.stringify([
  { id: "32345678", last: "Sibling", email: "sibling@example.com", name: "Sibling Player" },
  ...JSON.parse(localStorage.getItem("lccc-register-players"))])));
await switchPage.goto(base + "/entries/?event=club-night/2026-10-12", { waitUntil: "networkidle0" });
const nightRegister = await switchPage.evaluate(() => {
  const register = document.querySelector(".entries-all a.button");
  return { href: register?.getAttribute("href"),
    above: Boolean(register?.compareDocumentPosition(document.querySelector(".entries-all table")) & Node.DOCUMENT_POSITION_FOLLOWING) };
});
nightRegister.href === "/events/club-night/?date=2026-10#register" && nightRegister.above
  ? pass("Entries page shows Register above the list when the latest player saved here isn't registered, opening a club night on its whole month")
  : fail(`Entries page Register for a club night: ${JSON.stringify(nightRegister)}`);
await press(switchPage, ".entries-all .register-saved li:nth-child(2) .register-pick");
const pickedNight = await switchPage.evaluate(() => ({ register: Boolean(document.querySelector(".entries-all a.button")),
  first: document.querySelector(".entries-all .register-pick").textContent }));
for (const { identifier } of [switchSaved, siblingSaved]) await switchPage.removeScriptToEvaluateOnNewDocument(identifier);
await switchPage.reload({ waitUntil: "networkidle0" });
const pickedKept = await switchPage.evaluate(() => Boolean(document.querySelector(".entries-all a.button")));
JSON.stringify(pickedNight) === JSON.stringify({ register: false, first: "Night Player (22345678)" }) && !pickedKept
  ? pass("Entries page takes the player picked as the reader, hiding Register for their event, and keeps the choice")
  : fail(`Entries page after a pick: ${JSON.stringify({ pickedNight, pickedKept })}`);
await switchPage.close();

// Byes on the Entries page, against a stand-in that keeps Ann's: a Byes column, and Change byes for a player saved
// on this device, on a whole month, which offers the nights still to come and keeps a bye on one already played, and
// on a Swiss, which offers its rounds, but never on a quad; and a form that saves a player registered on another device.
const byesPage = await browser.newPage();
byesPage.on("pageerror", (error) => fail(`JavaScript error on /entries/ with byes: ${error.message}`));
await byesPage.evaluateOnNewDocument(() => {
  if (!sessionStorage.getItem("seeded")) {
    localStorage.setItem("lccc-register-players", JSON.stringify([{ id: "12345678", last: "Example", email: "ann@example.com", name: "Ann Example" }]));
    sessionStorage.setItem("seeded", "1");
  }
});
const byesCalls = [];
// Ann's byes by event; events.json no longer lists October 5, which has been played.
const annByes = { "club-night": ["2099-10-05", "2099-10-19"], classic: ["3"] };
await byesPage.setRequestInterception(true);
byesPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    request.respond({ contentType: "text/javascript", body: offline(await (await fetch(base + "/register.js")).text()) });
  } else if (url.pathname === "/events.json") {
    request.respond({ contentType: "application/json", body: JSON.stringify([
      ...["12", "19", "26"].map((day) => ({ page: "/events/club-night/", start: `2099-10-${day}T18:30:00-06:00`, tags: ["casual"], pairing: "swiss", rounds: "" })),
      { page: "/events/classic/", start: "2099-11-07T10:00:00-07:00", tags: ["tournament"], pairing: "swiss", rounds: "4" },
      { page: "/events/quads/", start: "2099-11-14T10:00:00-07:00", tags: ["tournament"], pairing: "quad", rounds: "3" }]) });
  } else if (url.host === "registration.test") {
    let body;
    if (request.method() === "POST") {
      const p = Object.fromEntries(new URLSearchParams(request.postData()));
      byesCalls.push(p);
      const byes = p.byes ? p.byes.split(", ") : [];
      if (p.event === "classic" && byes.length > 1) {
        body = { error: "Online, a player can ask for one bye in a one-day tournament." };
      } else {
        annByes[p.event] = byes;
        body = { ok: true, message: "Ann Example's byes are saved." };
      }
    } else {
      const ann = (event, rest) => ({ name: "Ann Example", id: "12345678", rating: "1500", ...rest, ...(annByes[event]?.length ? { byes: annByes[event] } : {}) });
      body = { events: [
        { key: "club-night/2099-10-12", name: "Club Night", label: "Monday, October 12, 2099", page: "/events/club-night/", start: "2099-10-12T18:30:00-06:00",
          entries: [ann("club-night", { for: "Whole month" }), { name: "Ben Example", id: "22345678", rating: "1200", for: "Monday, October 12" }] },
        { key: "classic/2099-11-07", name: "Classic", label: "Saturday, November 7, 2099", page: "/events/classic/", start: "2099-11-07T10:00:00-07:00",
          entries: [ann("classic", { for: "Saturday, November 7" }), { name: "Cal Example", id: "32345678", rating: "1400", for: "Saturday, November 7" }] },
        { key: "quads/2099-11-14", name: "Quads", label: "Saturday, November 14, 2099", page: "/events/quads/", start: "2099-11-14T10:00:00-07:00",
          entries: [ann("quads", { for: "Saturday, November 14" })] }] };
    }
    request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
  } else {
    request.continue();
  }
});
// The Byes column's text, without its button, and whose rows have Change byes.
const byesShown = () => byesPage.evaluate(() => {
  const head = [...document.querySelectorAll(".entries-all thead th")].map((c) => c.textContent);
  return { head, byes: [...document.querySelectorAll(".entries-all tbody tr")].map((r) => [...(r.cells[head.indexOf("Byes")]?.childNodes || [])]
    .filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("").trim()),
  changers: [...document.querySelectorAll(".entries-all .entries-change-byes")].map((b) => b.closest("tr").cells[0].textContent),
  status: document.querySelector(".entries-all-status").textContent, focused: document.activeElement?.textContent };
});
const byesEditor = () => byesPage.evaluate(() => {
  const group = document.querySelector(".entries-all [role=group]");
  return group && { label: group.getAttribute("aria-label"), focused: document.activeElement?.id || document.activeElement?.textContent,
    boxes: [...group.querySelectorAll("input")].map((b) => `${b.labels[0].textContent}${b.checked ? " (checked)" : ""}`) };
});
const saveByes = async (said) => {
  await press(byesPage, ".entries-all [role=group] + p button");
  await byesPage.waitForFunction((s) => document.querySelector(".entries-all-status").textContent.startsWith(s), {}, said);
};
await byesPage.goto(base + "/entries/", { waitUntil: "networkidle0" });
const monthByes = await byesShown();
await press(byesPage, ".entries-change-byes");
const monthEditor = await byesEditor();
await axeBoth(byesPage, "Entries page changing byes");
await byesPage.setViewport({ width: 390, height: 844 });
await fitsPhone(byesPage, "Entries page changing byes");
await byesPage.setViewport({ width: 1100, height: 800 });
await press(byesPage, "#entries-bye-12345678-2099-10-19");
await press(byesPage, "#entries-bye-12345678-2099-10-26");
await saveByes("Ann Example's byes");
const monthSaved = await byesShown();
JSON.stringify(monthByes.head) === JSON.stringify(["Name", "US Chess ID", "Rating", "For", "Byes"])
  && JSON.stringify(monthByes.byes) === JSON.stringify(["October 5 and 19", ""]) && JSON.stringify(monthByes.changers) === '["Ann Example"]'
  && JSON.stringify(monthEditor) === JSON.stringify({ label: "Nights Ann Example will miss", focused: "entries-bye-12345678-2099-10-12",
    boxes: ["October 12", "October 19 (checked)", "October 26"] })
  && JSON.stringify(byesCalls[0]) === JSON.stringify({ action: "byes", event: "club-night", date: "2099-10", id: "12345678", last: "Example",
    email: "ann@example.com", byes: "2099-10-05, 2099-10-26" })
  && monthSaved.byes[0] === "October 5 and 26" && monthSaved.status === "Ann Example's byes are saved." && monthSaved.focused === "Change byes for Ann Example"
  ? pass("Entries page shows byes, and a saved player changes a whole month's, keeping the nights already played")
  : fail(`Entries page month's byes: ${JSON.stringify({ monthByes, monthEditor, call: byesCalls[0], monthSaved })}`);
await press(byesPage, ".entries-change-byes");
await press(byesPage, ".entries-all [role=group] + p button:last-child");
const cancelled = await byesShown();
cancelled.byes[0] === "October 5 and 26" && cancelled.focused === "Change byes for Ann Example" && byesCalls.length === 1
  ? pass("Entries page's Cancel puts the byes back as they were") : fail(`Entries page Cancel: ${JSON.stringify({ cancelled, byesCalls })}`);
await byesPage.select("#entries-event", "classic/2099-11-07");
const swissByes = await byesShown();
await press(byesPage, ".entries-change-byes");
const swissEditor = await byesEditor();
await press(byesPage, "#entries-bye-12345678-4");
await saveByes("Online");
const byesRefused = await byesEditor();
await press(byesPage, "#entries-bye-12345678-3");
await saveByes("Ann Example's byes");
const swissSaved = await byesShown();
await byesPage.select("#entries-event", "quads/2099-11-14");
const quadByes = await byesShown();
JSON.stringify(swissByes.byes) === JSON.stringify(["Round 3", ""]) && JSON.stringify(swissByes.changers) === '["Ann Example"]'
  && JSON.stringify(swissEditor.boxes) === JSON.stringify(["Round 1", "Round 2", "Round 3 (checked)", "Round 4"])
  && swissEditor.label === "Rounds Ann Example will miss"
  && JSON.stringify(byesRefused) === JSON.stringify({ ...swissEditor, focused: "Save", boxes: ["Round 1", "Round 2", "Round 3 (checked)", "Round 4 (checked)"] })
  && JSON.stringify(byesCalls.slice(1).map((c) => [c.event, c.date, c.byes])) === JSON.stringify([["classic", "2099-11-07", "3, 4"], ["classic", "2099-11-07", "4"]])
  && swissSaved.byes[0] === "Round 4" && !quadByes.head.includes("Byes") && !quadByes.changers.length
  ? pass("Entries page changes a Swiss's byes by round, keeps them open after a refusal, and offers none for a quad")
  : fail(`Entries page Swiss's byes: ${JSON.stringify({ swissByes, swissEditor, byesRefused, calls: byesCalls.slice(1), swissSaved, quadByes })}`);
// Saved on another device: the form saves the player here, and their row gets its buttons.
await byesPage.evaluate(() => localStorage.clear());
await byesPage.goto(base + "/entries/?event=club-night%2F2099-10-12", { waitUntil: "networkidle0" });
const byesUnsaved = await byesShown();
await press(byesPage, "#entries-find");
await axeBoth(byesPage, "Entries page with the form for another device");
const findPlayer = async (id) => {
  for (const [field, value] of [["#entries-find-id", id], ["#entries-find-last", "Example"], ["#entries-find-email", "ann@example.com"]]) {
    await byesPage.$eval(field, (input) => { input.value = ""; });
    await byesPage.type(field, value);
  }
  await press(byesPage, ".entries-all form button[type=submit]");
};
await findPlayer("99999999");
const byesNobody = (await byesShown()).status;
await findPlayer("12345678");
const foundHere = await byesShown();
const savedHere = await byesPage.evaluate(() => ({ saved: JSON.parse(localStorage.getItem("lccc-register-players")),
  open: document.querySelector(".entries-all details").open }));
!byesUnsaved.changers.length && JSON.stringify(byesUnsaved.byes) === JSON.stringify(["October 5 and 26", ""])
  && byesNobody === "Nobody with that US Chess ID is registered for an upcoming event."
  && JSON.stringify(savedHere) === JSON.stringify({ saved: [{ id: "12345678", last: "Example", email: "ann@example.com", name: "Ann Example" }], open: false })
  && JSON.stringify(foundHere.changers) === '["Ann Example"]' && foundHere.focused === "Just this night for Ann Example"
  && foundHere.status === "Ann Example is saved on this device. Change the entry with the buttons on its row."
  ? pass("Entries page saves a player registered on another device, whose row then has its buttons")
  : fail(`Entries page another device: ${JSON.stringify({ byesUnsaved, byesNobody, foundHere, savedHere })}`);
// The players saved on this device are listed as on the Register form and the Pairings page. Ann was saved by the
// Pairings page, with her ID alone, and Cal by the Register form: picking Cal opens his list, and Ann's row has its
// buttons, which ask for her last name and email once, then work.
await byesPage.evaluate(() => localStorage.setItem("lccc-register-players", JSON.stringify([
  { id: "12345678", last: "", email: "", name: "Ann Example" }, { id: "32345678", last: "Example", email: "cal@example.com", name: "Cal Example" }])));
await byesPage.goto(base + "/entries/?event=club-night%2F2099-10-12", { waitUntil: "networkidle0" });
const savedListed = await byesPage.$$eval(".entries-all .register-saved:not([hidden]) .register-pick", (b) => b.map((x) => x.textContent));
const idOnly = await byesShown();
await press(byesPage, ".entries-all .register-saved li:nth-child(2) .register-pick");
const pickedCal = { ...await byesShown(), event: await byesPage.$eval("#entries-event", (s) => s.value) };
await axeBoth(byesPage, "Entries page with players saved on this device");
await byesPage.select("#entries-event", "club-night/2099-10-12");
const callsBefore = byesCalls.length;
await press(byesPage, `tr[data-id="12345678"] .entries-change-byes`);
const askedOnce = await byesPage.evaluate(() => ({ open: document.querySelector(".entries-all details").open, id: document.querySelector("#entries-find-id").value,
  focused: document.activeElement.id, status: document.querySelector(".entries-all-status").textContent,
  editor: Boolean(document.querySelector(".entries-all [role=group]")) }));
for (const [field, value] of [["#entries-find-last", "Example"], ["#entries-find-email", "ann@example.com"]]) await byesPage.type(field, value);
await press(byesPage, ".entries-all form button[type=submit]");
const annCompleted = { ...await byesShown(), saved: await byesPage.evaluate(() => JSON.parse(localStorage.getItem("lccc-register-players"))[0]) };
await press(byesPage, `tr[data-id="12345678"] .entries-change-byes`);
const editorAfter = await byesEditor();
JSON.stringify(savedListed) === JSON.stringify(["Ann Example (12345678)", "Cal Example (32345678)"])
  && JSON.stringify(idOnly.changers) === '["Ann Example"]'
  && pickedCal.event === "classic/2099-11-07" && pickedCal.focused === "Change byes for Cal Example"
  && pickedCal.status === "Cal Example (32345678): change the entry with the buttons on its row."
  && JSON.stringify(askedOnce) === JSON.stringify({ open: true, id: "12345678", focused: "entries-find-last",
    status: "To change Ann Example's entry, enter the last name and email used to register.", editor: false })
  && byesCalls.length === callsBefore
  && JSON.stringify(annCompleted.saved) === JSON.stringify({ id: "12345678", last: "Example", email: "ann@example.com", name: "Ann Example" })
  && annCompleted.focused === "Change byes for Ann Example" && editorAfter?.label === "Nights Ann Example will miss"
  ? pass("Entries page lists the players saved on this device, and one saved with only an ID gives the last name and email once")
  : fail(`Entries page saved players: ${JSON.stringify({ savedListed, idOnly, pickedCal, askedOnce, annCompleted, editorAfter })}`);
await press(byesPage, ".entries-all [role=group] + p button:last-child");
await press(byesPage, ".entries-all .register-saved li:first-child .register-forget");
const forgotHere = { ...await byesShown(), listed: await byesPage.$$eval(".entries-all .register-pick", (b) => b.map((x) => x.textContent)) };
JSON.stringify(forgotHere.listed) === '["Cal Example (32345678)"]' && !forgotHere.changers.length
  && forgotHere.status === "Ann Example (12345678) is no longer saved on this device." && forgotHere.focused === "Cal Example (32345678)"
  ? pass("Forget on the Entries page removes the saved player and their row's buttons") : fail(`Entries page forget: ${JSON.stringify(forgotHere)}`);
await byesPage.evaluate(() => localStorage.clear());
await byesPage.close();

// Running a tournament on the TD desk, against a stand-in for the Apps Script that keeps the
// tournament in memory: start it, check in, pair round one, post it, and enter a result.
const runPage = await browser.newPage();
runPage.on("pageerror", (error) => fail(`JavaScript error on /td/ running a tournament: ${error.message}`));
const runCalls = [];
let held = null;
await runPage.setRequestInterception(true);
runPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
    return;
  }
  if (url.host !== "registration.test") return request.continue();
  const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
  runCalls.push(p);
  const players = [["11111111", "Ann", 1900], ["22222222", "Ben", 1700], ["33333333", "Cal", 1500], ["44444444", "Dee", 1300]]
    .map(([id, name, rating], i) => ({ id, number: i + 1, name, rating, out: null }));
  let body = { ok: true };
  if (p.action === "login") body = { ok: true };
  else if (p.action === "choices") body = { choices: [{ key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry", first: "2026-11-07" }] };
  else if (p.action === "entries") body = { entries: [] };
  else if (p.action === "incidents") body = { incidents: [] };
  else if (p.action === "tournament") body = { tournament: held };
  else if (p.action === "start") {
    held = { key: "classic/2026-11-07", name: "Classic", format: "swiss", plannedRounds: 3, status: "running", coin: p.coin, players, rounds: [] };
    body = { ok: true, message: "Added 4 player(s)." };
  } else if (p.action === "round") {
    held.rounds = [{ games: JSON.parse(p.games).map((g) => ({ ...g, result: "" })), byes: JSON.parse(p.byes), out: [], posted: p.post === "yes" }];
    body = { ok: true, message: "Round 1 is posted." };
  } else if (p.action === "result") {
    held.rounds[0].games.find((g) => g.board === Number(p.board)).result = p.result;
  }
  request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
});
await runPage.goto(base + "/td/", { waitUntil: "networkidle0" });
await runPage.type("#td-password", "secret");
await runPage.click(".td-login button");
await runPage.waitForSelector(".run-start:not([hidden])");
// Explanations sit behind ? buttons: a tap shows one, Escape hides it. The format menu is on the status line.
const hintShown = () => runPage.$eval("#run-sections-hint", (h) => getComputedStyle(h).display !== "none");
const hiddenAtFirst = !(await hintShown());
await runPage.click('.run-sections .hint-button');
const shownOnTap = await hintShown();
await runPage.keyboard.press("Escape");
await runPage.mouse.move(0, 0);
const hiddenOnEscape = !(await hintShown());
const sameLine = await runPage.evaluate(() => {
  const middle = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return r.top + r.height / 2; };
  return [middle(".run-status") - middle("#run-format"), middle('[for="run-td"]') - middle("#run-td")];
});
hiddenAtFirst && shownOnTap && hiddenOnEscape && sameLine.every((d) => Math.abs(d) < 8) ? pass("TD desk start form puts menus beside their labels and explanations behind ? buttons")
  : fail(`TD desk start form: ${JSON.stringify({ hiddenAtFirst, shownOnTap, hiddenOnEscape, sameLine })}`);
await runPage.type("#run-rounds", "3");
await press(runPage, ".run-start button[type=submit]");
await runPage.waitForSelector(".run-round:not([hidden]) .run-pair");
await runPage.waitForFunction(() => document.querySelectorAll(".run-attendance tbody tr").length === 4);
const startsPresent = await runPage.$$eval(".run-this-round", (s) => s.every((x) => x.value === "play"));
startsPresent ? pass("TD desk check-in starts with everyone present") : fail("TD desk check-in doesn't start everyone as present");
await press(runPage, ".run-pair");
await runPage.waitForSelector(".run-pairings:not([hidden])");
await press(runPage, ".run-post");
await runPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const postedRound = runCalls.find((c) => c.action === "round") || {};
const postedGames = JSON.parse(postedRound.games || "[]");
postedGames.length === 2 && postedRound.post === "yes"
  && JSON.stringify(postedGames.map((g) => [g.white, g.black])) === JSON.stringify([["11111111", "33333333"], ["44444444", "22222222"]])
  ? pass("TD desk starts a tournament and posts round one by rule 28J") : fail(`TD desk round one: ${JSON.stringify(postedRound)}`);
await runPage.select(".run-games tbody tr:first-child select", "1-0");
await runPage.waitForFunction(() => document.querySelector(".run-standings tbody tr td:nth-child(2)")?.textContent === "Ann");
pass("TD desk enters a result and updates the standings");
await runPage.evaluate(axeSource);
const runAxe = await runPage.evaluate(() => axe.run());
runAxe.violations.length ? fail(`TD desk running a tournament: ${runAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("TD desk running a tournament has no axe violations");
await runPage.close();

// Running an arena on the TD desk, against a stand-in for the Apps Script that keeps it in
// memory, with the clock at 11:00 AM on the day: start it, queue four players, pair them,
// record a win with a Blood Pact, and check that the two who just played aren't paired again.
const arenaPage = await browser.newPage();
arenaPage.on("pageerror", (error) => fail(`JavaScript error on /td/ running an arena: ${error.message}`));
const arenaCalls = [];
let arena = null;
await arenaPage.evaluateOnNewDocument((fixed) => {
  const RealDate = Date;
  window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
}, new Date("2026-10-31T11:00:00-06:00").getTime());
await arenaPage.setRequestInterception(true);
arenaPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
    return;
  }
  if (url.host !== "registration.test") return request.continue();
  const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
  arenaCalls.push(p);
  const since = () => `2026-10-31 11:00:${String(arenaCalls.length).padStart(2, "0")}`;
  let body = { ok: true };
  if (p.action === "choices") {
    body = { choices: [{ key: "knightmare-arena-classical/2026-10-31", name: "Knightmare Arena Classical",
      label: "Saturday, October 31, 2026", kind: "entry", first: "2026-10-31" }] };
  } else if (p.action === "entries") body = { entries: [] };
  else if (p.action === "incidents") body = { incidents: [] };
  else if (p.action === "tournament") body = { tournament: arena };
  else if (p.action === "start") {
    const players = [["11111111", "Ann", 1900], ["22222222", "Ben", 1700], ["33333333", "Cal", 1500], ["44444444", "Dee", null]]
      .map(([id, name, rating], i) => ({ id, number: i + 1, name, rating, out: null }));
    arena = { key: "knightmare-arena-classical/2026-10-31", name: "Knightmare Arena Classical, Saturday, October 31, 2026",
      format: p.format, cutoff: p.cutoff, status: "running", players, rounds: [], games: [], queue: [] };
    body = { ok: true, message: "Added 4 player(s)." };
  } else if (p.action === "arenaJoin") {
    arena.queue.push({ id: p.id, since: since() });
    body = { ok: true, message: "Waiting." };
  } else if (p.action === "arenaPair") {
    for (const g of JSON.parse(p.games)) {
      arena.games.push({ game: arena.games.length + 1, ...g, whitePact: false, blackPact: false, result: "" });
      arena.queue = arena.queue.filter((q) => q.id !== g.white && q.id !== g.black);
    }
    body = { ok: true, message: "Started." };
  } else if (p.action === "arenaPact") {
    arena.games[p.game - 1][`${p.side}Pact`] = p.on === "yes";
  } else if (p.action === "arenaResult") {
    const g = arena.games[p.game - 1];
    g.result = p.result;
    arena.queue.push({ id: g.white, since: since() }, { id: g.black, since: since() });
    body = { ok: true, message: "Recorded." };
  }
  request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
});
await arenaPage.goto(base + "/td/", { waitUntil: "networkidle0" });
await arenaPage.type("#td-password", "secret");
await arenaPage.click(".td-login button");
await arenaPage.waitForSelector(".run-start:not([hidden])");
await arenaPage.select("#run-format", "arena");
const startFields = await arenaPage.evaluate(() => ({ cutoff: document.querySelector("#run-cutoff").checkVisibility(),
  rounds: document.querySelector("#run-rounds").checkVisibility(), value: document.querySelector("#run-cutoff").value }));
startFields.cutoff && !startFields.rounds && startFields.value === "17:30"
  ? pass("TD desk asks an arena for its cutoff, 17:30 unless changed") : fail(`TD desk arena start form: ${JSON.stringify(startFields)}`);
await press(arenaPage, ".run-start button[type=submit]");
await arenaPage.waitForSelector(".run-arena:not([hidden])");
for (let n = 1; n <= 4; n++) {
  await press(arenaPage, ".run-away tbody tr:first-child button");
  await arenaPage.waitForFunction((n) => document.querySelectorAll(".run-queue tbody tr").length === n, {}, n);
}
await press(arenaPage, ".run-arena-pair");
await arenaPage.waitForFunction(() => document.querySelectorAll(".run-arena-games tbody tr").length === 2);
const paired = JSON.parse(arenaCalls.find((c) => c.action === "arenaPair")?.games || "[]");
JSON.stringify(paired) === JSON.stringify([{ white: "11111111", black: "22222222" }, { white: "33333333", black: "44444444" }])
  ? pass("TD desk starts an arena, queues players, and pairs them in queue order") : fail(`TD desk arena pairing: ${JSON.stringify(paired)}`);
await press(arenaPage, ".run-arena-games tbody tr:first-child td:nth-child(2) input[type=checkbox]");
await arenaPage.waitForFunction(() => document.querySelector(".run-arena-games tbody tr:first-child td:nth-child(2) input:checked:not(:disabled)"));
await press(arenaPage, ".run-arena-games tbody tr:first-child .td-buttons button:first-child");
await arenaPage.waitForFunction(() => document.querySelectorAll(".run-arena-games tbody tr").length === 1);
const board = await arenaPage.$$eval(".run-leaderboard tbody tr", (rows) => rows.map((r) => [...r.cells].map((c) => c.textContent)));
const pact = arenaCalls.find((c) => c.action === "arenaPact") || {};
pact.game === "1" && pact.side === "white" && pact.on === "yes"
  && JSON.stringify(board[0]) === JSON.stringify(["1", "Ann", "1900", "3", "1", "1"])
  && board.slice(1).every((r) => r[0] === "2 (tied)" && r[3] === "0")
  ? pass("TD desk records a Blood Pact win and the leaderboard shows it, with ties shared")
  : fail(`TD desk arena leaderboard: ${JSON.stringify({ pact, board })}`);
const queued = await arenaPage.$$eval(".run-queue tbody tr td:first-child", (cells) => cells.map((c) => c.textContent));
await press(arenaPage, ".run-arena-pair");
await arenaPage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("just played each other"));
JSON.stringify(queued) === JSON.stringify(["Ann", "Ben"]) && arenaCalls.filter((c) => c.action === "arenaPair").length === 1
  ? pass("TD desk puts both players back in the queue and doesn't pair them again at once")
  : fail(`TD desk arena rematch: ${JSON.stringify(queued)}`);
for (const scheme of ["light", "dark"]) {
  await arenaPage.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await arenaPage.evaluate(axeSource);
  const result = await arenaPage.evaluate(() => axe.run());
  result.violations.length ? fail(`TD desk running an arena (${scheme}): ${result.violations.map((v) => `${v.id} at ${v.nodes[0].target}`).join(", ")}`)
    : pass(`TD desk running an arena has no axe violations (${scheme})`);
}
await arenaPage.close();

// A page whose register.js points at a stand-in for the Apps Script; answer(fields) gives each call's JSON,
// or a promise of it. With stream, LIVE_DB points at a stand-in for the database too: stream(path) gives
// the events each connection to a path gets before it closes, as [event, data] pairs, or null to refuse it.
async function mocked(label, answer, viewport, stream) {
  const tab = await browser.newPage();
  tab.on("pageerror", (error) => fail(`JavaScript error on ${label}: ${error.message}`));
  if (viewport) await tab.setViewport(viewport);
  await tab.setRequestInterception(true);
  tab.on("request", async (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/register.js") {
      const source = offline(await (await fetch(base + "/register.js")).text());
      request.respond({ contentType: "text/javascript",
        body: stream ? source.replace(/^const LIVE_DB = ".*";$/m, 'const LIVE_DB = "https://live.test";') : source });
    } else if (url.host === "registration.test") {
      const fields = Object.fromEntries(new URLSearchParams(request.postData() || url.search));
      request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(await answer(fields)) });
    } else if (url.host === "live.test") {
      const events = stream(url.pathname.replace(/\.json$/, ""));
      // A short retry has EventSource reconnect at once for the next state, as it would after a dropped connection.
      if (!events) request.respond({ status: 503, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "text/plain", body: "" });
      else request.respond({ headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" }, contentType: "text/event-stream",
        body: `retry: 100\n\n${events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")}` });
    } else {
      request.continue();
    }
  });
  return tab;
}

async function axeBoth(tab, label) {
  for (const scheme of ["light", "dark"]) {
    await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await tab.evaluate(axeSource);
    const result = await tab.evaluate(() => axe.run());
    result.violations.length ? fail(`${label} (${scheme}): ${result.violations.map((v) => `${v.id} at ${v.nodes[0].target}`).join(", ")}`)
      : pass(`${label} has no axe violations (${scheme})`);
  }
  await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
}

async function fitsPhone(tab, label) {
  const { page: wide, view } = await tab.evaluate(() => ({ page: document.documentElement.scrollWidth, view: innerWidth }));
  wide <= view ? pass(`${label} fits a ${view}px screen without scrolling sideways`) : fail(`${label} is ${wide}px wide on a ${view}px screen`);
}

const PHONE = { width: 390, height: 844 };

// A tournament in two sections for the Pairings and Standings pages: round 1 done, round 2 under way.
const twoSections = () => {
  const players = [["a", "Ann", 2000, "Open"], ["b", "Ben", 1800, "Open"], ["c", "Cal", 1600, "Open"], ["d", "Dee", 1500, "Open"],
    ["e", "Eve", 1300, "Under 1400"], ["f", "Fay", 1200, "Under 1400"], ["g", "Gus", null, "Under 1400"]]
    .map(([id, name, rating, section], i) => ({ id, number: i + 1, name, rating, section, out: null }));
  const rounds = [
    { games: [{ board: 1, white: "a", black: "c", result: "1-0", section: "Open" }, { board: 2, white: "d", black: "b", result: "0-1", section: "Open" },
      { board: 1, white: "e", black: "f", result: "1/2-1/2", section: "Under 1400" }],
      byes: [{ id: "g", points: 1, section: "Under 1400" }], out: [], posted: true },
    { games: [{ board: 1, white: "b", black: "a", result: "1/2-1/2", section: "Open" }, { board: 2, white: "c", black: "d", result: "", section: "Open" },
      { board: 1, white: "g", black: "e", result: "", section: "Under 1400" }],
      byes: [{ id: "f", points: 1, section: "Under 1400" }], out: [], posted: true },
  ];
  return [{ key: "classic/2026-11-07", name: "Classic, Saturday, November 7, 2026", format: "swiss", plannedRounds: 3, status: "running",
    sections: [{ name: "Open" }, { name: "Under 1400", under: 1400 }], players, rounds }];
};

// The Pairings page: each section in its own table, with a round menu that starts at the latest round.
// On a night's list, the desk switches a paid whole month to just the night, refunds what's left over, and
// gives a discount, each with the entry's token.
const moneyCalls = [];
const monthEntry = { name: "Month Player", id: "22345678", rating: "1400", for: "Whole month", category: "Adult", amount: "17", paid: "17",
  paidBy: "cash", due: "0", card: "", email: "", expires: "2027-01-31", token: "month1", date: "2026-10", refundable: "17", over: "",
  refunded: "", discount: "", credit: "" };
let moneyEntry = monthEntry;
const moneyDesk = await mocked("/td/ switching, refunding, and discounting", (p) => {
  if (!["login", "choices", "people", "contacts", "entries", "ledger", "incidents", "tournament", "changes"].includes(p.action)) moneyCalls.push(p);
  if (p.action === "toNight") {
    moneyEntry = { ...moneyEntry, for: "Monday, October 12", amount: "7.50", paid: "", paidBy: "", token: "night1", date: "2026-10-12",
      credit: "17", over: "9.50" };
  }
  return { login: { ok: true, changes: null },
    choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" },
      { key: "club-night/2026-10-12", name: "Club Night", label: "Monday, October 12, 2026", kind: "night", first: "2026-10-12" },
      { key: "club-night/2026-10-19", name: "Club Night", label: "Monday, October 19, 2026", kind: "night", first: "2026-10-19" }] },
    people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: [moneyEntry] },
    ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
    incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true, message: `${p.action} done` };
});
moneyDesk.on("dialog", (d) => d.accept(d.type() !== "prompt" ? undefined : /Reason/.test(d.message()) ? "Hardship" : /Discount/.test(d.message()) ? "5" : d.defaultValue()));
await moneyDesk.goto(base + "/td/", { waitUntil: "domcontentloaded" });
await moneyDesk.type("#td-password", "secret");
await moneyDesk.click(".td-login button");
await moneyDesk.waitForSelector(".td-entries tbody tr");
const moneyButtons = () => moneyDesk.$$eval(".td-entries tbody tr button", (b) => b.map((x) => x.firstChild.textContent));
const moneyMonthButtons = await moneyButtons();
const moneyNights = await moneyDesk.$$eval(".td-entries tbody tr select[aria-label^=Night] option", (o) => o.map((x) => x.textContent));
await moneyDesk.select(".td-entries select[aria-label^=Night]", "2026-10-19");
await moneyDesk.$$eval(".td-entries tbody tr button", (b) => b.find((x) => x.firstChild.textContent === "One night only").click());
await moneyDesk.waitForFunction(() => document.querySelector(".td-register-status").textContent.endsWith("done"));
await moneyDesk.$eval(".td-register-status", (s) => { s.textContent = ""; });
moneyEntry = monthEntry;
await moneyDesk.select("#td-event", "club-night/2026-10-12");
await moneyDesk.waitForFunction(() => [...document.querySelectorAll(".td-entries button")].some((b) => b.textContent.startsWith("This night only")));
const moneyClick = async (text) => {
  await moneyDesk.$$eval(".td-entries tbody tr button", (b, t) => b.find((x) => x.firstChild.textContent === t).click(), text);
  await moneyDesk.waitForFunction((n) => document.querySelector(".td-register-status").textContent.endsWith("done"), {}, text);
  await moneyDesk.$eval(".td-register-status", (s) => { s.textContent = ""; });
};
await moneyClick("This night only");
await moneyDesk.waitForFunction(() => [...document.querySelectorAll(".td-entries button")].some((b) => b.textContent.startsWith("Refund $9.50")));
const moneyNightDue = await moneyDesk.$eval(".td-entries tbody tr", (r) => r.cells[6].firstChild.textContent);
await moneyClick("Refund $9.50");
await moneyClick("Discount");
const moneyAsked = moneyCalls.map(({ action, token, event, date, amount, by, note }) => ({ action, token, event, date, amount, by, note }));
JSON.stringify(moneyMonthButtons) === JSON.stringify(["One night only", "Discount", "$17 cash ✓", "Refund", "Incident", "Remove"])
  && JSON.stringify(moneyNights) === JSON.stringify(["October 12", "October 19"]) && moneyNightDue === "$0 after $17 credit" && JSON.stringify(moneyAsked) === JSON.stringify([
    { action: "toNight", token: "month1", event: "club-night", date: "2026-10-19" },
    { action: "toNight", token: "month1", event: "club-night", date: "2026-10-12" },
    { action: "refund", token: "night1", amount: "9.50", by: "cash" },
    { action: "discount", token: "night1", amount: "5", note: "Hardship" }])
  ? pass("TD desk switches a whole month to a night picked on the month's list or to the night shown, refunds what's over, and gives a discount with its reason")
  : fail(`TD desk money: ${JSON.stringify({ moneyMonthButtons, moneyNights, moneyNightDue, moneyAsked })}`);
await moneyDesk.evaluate(axeSource);
const moneyAxe = await moneyDesk.evaluate(() => axe.run({ include: [".td-entries"] }));
moneyAxe.violations.length ? fail(`TD desk money buttons: ${moneyAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("TD desk money buttons have no axe violations");
await moneyDesk.close();

// Paying over the fee: the desk asks whether the rest is a donation, then shows it on the row and in the money.
let giftEntry = { name: "Gift Player", id: "32345678", rating: "1500", for: "Monday, October 12", category: "Adult", amount: "17", paid: "",
  paidBy: "", due: "17", card: "17.80", email: "", expires: "2027-01-31", token: "gift1", date: "2026-10-12", refundable: "", over: "",
  refunded: "", discount: "", credit: "", donation: "" };
let giftLedger = { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", donation: "0", games: null, uschess: "0" };
const giftCalls = [];
const giftAsked = [];
const giftDesk = await mocked("/td/ donation", (p) => {
  if (p.action === "paid") {
    giftCalls.push({ amount: p.amount, by: p.by, donate: p.donate });
    giftEntry = { ...giftEntry, paid: "22", paidBy: "cash", donation: "5", refundable: "17" };
    giftLedger = { ...giftLedger, received: { ...giftLedger.received, cash: "22" }, entry: "15", rating: "2", donation: "5" };
  }
  return { login: { ok: true, changes: null },
    choices: { choices: [{ key: "club-night/2026-10-12", name: "Club Night", label: "Monday, October 12, 2026", kind: "night", first: "2026-10-12" }] },
    people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: [giftEntry] }, ledger: { ledger: giftLedger },
    incidents: { incidents: [] }, tournament: { tournament: null }, paid: { ok: true, message: "paid done" } }[p.action] || { ok: true };
});
giftDesk.on("dialog", (d) => { giftAsked.push(d.message()); d.accept(d.type() === "prompt" ? "22" : undefined); });
await giftDesk.goto(base + "/td/", { waitUntil: "domcontentloaded" });
await giftDesk.type("#td-password", "secret");
await giftDesk.click(".td-login button");
await giftDesk.waitForSelector(".td-entries tbody tr");
await giftDesk.$$eval(".td-entries tbody tr button", (b) => b.find((x) => x.firstChild.textContent === "Mark paid").click());
await giftDesk.waitForFunction(() => document.querySelector(".td-entries tbody tr td:nth-child(9)").textContent.includes("donation"));
await giftDesk.waitForFunction(() => document.querySelector(".td-ledger").textContent.includes("Donations"));
const giftPaid = await giftDesk.$eval(".td-entries tbody tr td:nth-child(9)", (c) => c.textContent);
const giftMoney = await giftDesk.$eval(".td-ledger", (l) => l.lastElementChild.textContent);
JSON.stringify(giftCalls) === JSON.stringify([{ amount: "22", by: "cash", donate: "1" }]) && /\$5 more than the \$17 due/.test(giftAsked[1])
  && giftPaid.includes("mark unpaid + $5 donation") && giftMoney === "Donations to the club: $5."
  ? pass("TD desk records what's paid over the fee as the player's donation and shows it on the row and in the money")
  : fail(`TD desk donation: ${JSON.stringify({ giftCalls, giftAsked, giftPaid, giftMoney })}`);
await giftDesk.close();

// Paying part of the fee: the row shows what's still due and takes another payment, which can be by another method.
let partEntry = { name: "Part Player", id: "42345678", rating: "1500", for: "Monday, October 12", category: "Adult", amount: "17", paid: "",
  paidBy: "", due: "17", balance: "17", card: "17.93", email: "", expires: "2027-01-31", token: "part1", date: "2026-10-12", refundable: "",
  over: "", refunded: "", discount: "", credit: "", donation: "" };
const partCalls = [];
const partAsked = [];
const partDesk = await mocked("/td/ part payments", (p) => {
  if (p.action === "paid") {
    partCalls.push({ amount: p.amount, by: p.by, donate: p.donate });
    partEntry = partCalls.length === 1 ? { ...partEntry, paid: "10", paidBy: "cash", balance: "7", card: "7.68", refundable: "10" }
      : { ...partEntry, paid: "17.68", paidBy: "cash, card", balance: "0", card: "", refundable: "17" };
  }
  return { login: { ok: true, changes: null },
    choices: { choices: [{ key: "club-night/2026-10-12", name: "Club Night", label: "Monday, October 12, 2026", kind: "night", first: "2026-10-12" }] },
    people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: [partEntry] },
    ledger: { ledger: giftLedger }, incidents: { incidents: [] }, tournament: { tournament: null }, paid: { ok: true, message: "paid done" } }[p.action]
    || { ok: true };
});
partDesk.on("dialog", (d) => { partAsked.push(d.message()); d.accept(partCalls.length ? d.defaultValue() : "10"); });
await partDesk.goto(base + "/td/", { waitUntil: "domcontentloaded" });
await partDesk.type("#td-password", "secret");
await partDesk.click(".td-login button");
await partDesk.waitForSelector(".td-entries tbody tr");
const partClick = (label) => partDesk.$$eval(".td-entries tbody tr button", (b, label) => b.find((x) => x.firstChild.textContent === label).click(), label);
await partClick("Mark paid");
await partDesk.waitForFunction(() => [...document.querySelectorAll(".td-entries button")].some((b) => b.firstChild.textContent === "Add payment"));
const partShort = await partDesk.$eval(".td-entries tbody tr td:nth-child(9)", (c) => c.textContent);
const partOwed = await partDesk.$eval(".td-entries-status", (s) => s.textContent);
await partDesk.select(".td-entries .td-method", "card");
await partClick("Add payment");
await partDesk.waitForFunction(() => document.querySelector(".td-entries tbody tr td:nth-child(9)").textContent.includes("cash, card"));
const partDone = await partDesk.$$eval(".td-entries tbody tr td:nth-child(9) :is(button, select)", (b) => b.map((x) => x.firstChild?.textContent ?? ""));
JSON.stringify(partCalls) === JSON.stringify([{ amount: "10", by: "cash", donate: "" }, { amount: "7.68", by: "card", donate: "" }])
  && partShort.startsWith("$10 cash ✓ paid by Part Player; mark unpaid $7 due") && partOwed.includes("Still owed: $7.")
  && partAsked[1] === "Amount Part Player paid by card" && partDone.length === 2 && partDone[0] === "$17.68 cash, card ✓"
  ? pass("TD desk takes part of the fee, shows what's still due, and collects the rest with another payment")
  : fail(`TD desk part payment: ${JSON.stringify({ partCalls, partShort, partOwed, partAsked, partDone })}`);
await partDesk.close();

// Byes asked for in advance: the register form and each entry have a box for every round of a one-day
// Swiss, or every night of a month to come. An entry's box saves as soon as it changes, with the entry's
// token, and goes back if the script refuses.
const deskByeCalls = [];
let deskByeAnswer = { ok: true, message: "Ann Example's byes are saved." };
const deskByeEntries = {
  "classic/2026-11-07": [{ name: "Ann Example", id: "12345678", rating: "1500", for: "Saturday, November 7", category: "Adult", amount: "15",
    due: "15", card: "15.75", email: "", expires: "2027-01-31", token: "ann1", date: "2026-11-07", byes: ["3"] }],
  "club-night/2026-10": [{ name: "Month Player", id: "22345678", rating: "1400", for: "Whole month", category: "Adult", amount: "17",
    due: "17", card: "17.80", email: "", expires: "2027-01-31", token: "month1", date: "2026-10", byes: ["2026-10-19"] }],
};
const deskByePage = await mocked("/td/ with byes asked for", (p) => {
  if (p.action === "register" || p.action === "byes") deskByeCalls.push(p);
  return { login: { ok: true, changes: null },
    choices: { choices: [
      { key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry", first: "2026-11-07", format: "swiss", rounds: "4" },
      { key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12", format: "", rounds: "" },
      { key: "club-night/2026-10-19", name: "Club Night", label: "Monday, October 19, 2026", kind: "night", first: "2026-10-19", format: "", rounds: "" },
      { key: "club-night/2026-10-26", name: "Club Night", label: "Monday, October 26, 2026", kind: "night", first: "2026-10-26", format: "", rounds: "" }] },
    people: { players: [{ id: "12345678", name: "Ann Example", state: "", rating: "1500", expires: "2027-01-31", known: true }] },
    contacts: { headings: ["Name"], contacts: [] }, entries: { entries: deskByeEntries[`${p.event}/${p.date}`] || [] },
    ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
    incidents: { incidents: [] }, tournament: { tournament: null }, byes: deskByeAnswer,
    register: { ok: true, message: "Ann Example is registered." } }[p.action] || { ok: true };
});
await signIn(deskByePage);
await deskByePage.waitForSelector('.td-entries input[aria-label="Round 3 bye for Ann Example"]');
const deskByeBoxes = () => deskByePage.evaluate(() => ({ head: document.querySelector(".td-entries th:nth-child(5)").textContent,
  boxes: [...document.querySelectorAll(".td-entries tbody td:nth-child(5) input")].map((b) => `${b.getAttribute("aria-label")}${b.checked ? " (checked)" : ""}`),
  offered: [...document.querySelectorAll(".td-byes:not([hidden]) label")].map((l) => l.textContent.trim()) }));
const deskByesShown = await deskByeBoxes();
const deskByeSaved = (text) => deskByePage.waitForFunction((t) => document.querySelector(".td-register-status").textContent.startsWith(t)
  && !document.querySelector(".td-entries input:disabled"), {}, text);
await deskByePage.click('.td-entries input[aria-label="Round 4 bye for Ann Example"]');
await deskByeSaved("Ann Example's byes are saved.");
deskByeAnswer = { error: "Round 1 is paired already." };
await deskByePage.click('.td-entries input[aria-label="Round 1 bye for Ann Example"]');
await deskByeSaved("Round 1 is paired already.");
const deskByesRefused = await deskByeBoxes();
const deskByeSaves = deskByeCalls.filter((c) => c.action === "byes").map(({ token, byes }) => ({ token, byes }));
deskByesShown.head === "Byes" && JSON.stringify(deskByesShown.boxes) === JSON.stringify(["Round 1 bye for Ann Example", "Round 2 bye for Ann Example",
  "Round 3 bye for Ann Example (checked)", "Round 4 bye for Ann Example"])
  && JSON.stringify(deskByeSaves) === JSON.stringify([{ token: "ann1", byes: "3, 4" }, { token: "ann1", byes: "1, 3, 4" }])
  && JSON.stringify(deskByesRefused.boxes.filter((b) => b.endsWith("(checked)"))) === JSON.stringify(["Round 3 bye for Ann Example (checked)",
    "Round 4 bye for Ann Example (checked)"])
  ? pass("TD desk shows an entry's byes, saves a change at once with the entry's token, and puts the box back when the script refuses")
  : fail(`TD desk entry byes: ${JSON.stringify({ deskByesShown, deskByeSaves, deskByesRefused })}`);
await deskByePage.type("#td-player", "ann");
await deskByePage.waitForSelector("#td-players:not([hidden]) [role=option]");
await deskByePage.keyboard.press("ArrowDown");
await deskByePage.keyboard.press("Enter");
await deskByePage.click('.td-byes input[value="2"]');
await deskByePage.click('.td-byes input[value="4"]');
await deskByePage.click(".td-register button[type=submit]");
await deskByePage.waitForSelector(".td-saving .td-save-done");
const deskByesCleared = await deskByePage.$$eval(".td-byes input:checked", (b) => b.length);
const deskByeRegistered = deskByeCalls.find((c) => c.action === "register") || {};
JSON.stringify(deskByesShown.offered) === JSON.stringify(["Round 1", "Round 2", "Round 3", "Round 4"])
  && deskByeRegistered.id === "12345678" && deskByeRegistered.byes === "2, 4" && deskByesCleared === 0
  ? pass("TD desk's register form offers each round of a one-day Swiss, sends the byes checked, and clears them for the next player")
  : fail(`TD desk register byes: ${JSON.stringify({ offered: deskByesShown.offered, deskByeRegistered, deskByesCleared })}`);
await deskByePage.select("#td-event", "club-night/2026-10");
await deskByePage.waitForSelector('.td-entries input[aria-label="October 19 bye for Month Player"]');
const deskByesMonth = await deskByeBoxes();
JSON.stringify(deskByesMonth.offered) === JSON.stringify(["October 19", "October 26"])
  && JSON.stringify(deskByesMonth.boxes) === JSON.stringify(["October 19 bye for Month Player (checked)", "October 26 bye for Month Player"])
  ? pass("TD desk offers a month's nights to come by date, on the register form and on a whole-month entry")
  : fail(`TD desk month byes: ${JSON.stringify(deskByesMonth)}`);
await axeBoth(deskByePage, "TD desk with byes asked for");
await deskByePage.setViewport(PHONE);
await fitsPhone(deskByePage, "TD desk with byes asked for");
await deskByePage.close();

// A donation apart from any entry: from a contact, on their row, or anonymous, by the Contacts tools.
let giveBook = { headings: ["Name", "US Chess ID"], contacts: [{ id: "c1", Name: "Cora Contact", "US Chess ID": "12345678", donated: "5" }], anonymous: "" };
const giveCalls = [];
const giveDesk = await mocked("/td/ donations from contacts", (p) => {
  if (p.action === "donation") {
    giveCalls.push({ contact: p.contact, amount: p.amount, by: p.by, note: p.note });
    giveBook = p.contact ? { ...giveBook, contacts: [{ ...giveBook.contacts[0], donated: "25" }] } : { ...giveBook, anonymous: "40" };
    return { ok: true, message: "donation done" };
  }
  return { login: { ok: true, changes: null }, choices: { choices: [] }, people: { players: [] }, contacts: giveBook,
    entries: { entries: [] }, incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true };
});
const giveAnswers = [];
giveDesk.on("dialog", (d) => d.accept(giveAnswers.shift()));
await giveDesk.goto(base + "/td/", { waitUntil: "domcontentloaded" });
await giveDesk.type("#td-password", "secret");
await giveDesk.click(".td-login button");
await giveDesk.waitForSelector(".td-contacts tbody tr");
await giveDesk.click(".td-contacts-panel summary");
const giveBefore = await giveDesk.$eval(".td-contacts tbody tr", (r) => r.cells[6].textContent);
giveAnswers.push("20", "Check", "Check 101");
await giveDesk.$$eval(".td-contacts tbody tr button", (b) => b.find((x) => x.firstChild.textContent === "Donation").click());
await giveDesk.waitForFunction(() => document.querySelector(".td-contacts tbody tr").cells[6].textContent === "$25");
giveAnswers.push("40", "cash", "");
await giveDesk.click(".td-contacts-give");
await giveDesk.waitForFunction(() => document.querySelector(".td-contacts-anonymous").textContent === "Anonymous donations so far: $40.");
JSON.stringify(giveCalls) === JSON.stringify([{ contact: "c1", amount: "20", by: "check", note: "Check 101" }, { contact: "", amount: "40", by: "cash", note: "" }])
  && giveBefore === "$5"
  ? pass("TD desk records a donation from a contact or an anonymous one, and shows each contact's total and the anonymous one")
  : fail(`TD desk contact donations: ${JSON.stringify({ giveCalls, giveBefore })}`);
await giveDesk.close();

const pairingsPage = await mocked("/pairings/", () => ({ tournaments: twoSections() }));
await pairingsPage.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const sectionTables = () => pairingsPage.evaluate(() => [...document.querySelectorAll(".pairings-all h3")].map((h) => {
  const menu = h.nextElementSibling;
  const shown = menu.nextElementSibling;
  return { name: h.textContent, round: menu.querySelector("select").value, label: menu.querySelector("label").textContent,
    rows: [...shown.querySelectorAll("tbody tr")].map((r) => [...r.cells].map((c) => c.textContent)),
    byes: shown.querySelector("p")?.textContent || "" };
}));
const latest = await sectionTables();
JSON.stringify(latest.map((s) => [s.name, s.round, s.rows.length])) === JSON.stringify([["Open", "2", 2], ["Under 1400", "2", 1]])
  && latest[0].rows[0].join("|") === "1|Ben (1800)|Ann (2000)|½–½" && latest[1].byes === "Without a game: Fay (1200), full-point bye."
  && latest[0].label === "Round, Open"
  ? pass("Pairings page shows each section's latest round in its own table") : fail(`Pairings page sections: ${JSON.stringify(latest)}`);
await pairingsPage.select(".pairings-all select", "1");
const earlier = await sectionTables();
earlier[0].round === "1" && earlier[0].rows[0].join("|") === "1|Ann (2000)|Cal (1600)|1–0" && earlier[1].round === "2"
  ? pass("Pairings page's round menu shows an earlier round of one section") : fail(`Pairings page round menu: ${JSON.stringify(earlier)}`);
await axeBoth(pairingsPage, "Pairings page with two sections");
await pairingsPage.setViewport(PHONE);
await fitsPhone(pairingsPage, "Pairings page with two sections");
await pairingsPage.close();

// The Standings page: each section's standings, after the latest round with results unless another is chosen.
const standingsPage = await mocked("/standings/", () => ({ tournaments: twoSections() }));
await standingsPage.goto(base + "/standings/", { waitUntil: "networkidle0" });
const standingsTables = () => standingsPage.evaluate(() => [...document.querySelectorAll(".standings-all h3")].map((h) => {
  const menu = h.nextElementSibling;
  return { name: h.textContent, after: menu.querySelector("select").value,
    options: [...menu.querySelectorAll("option")].map((o) => o.textContent),
    head: [...menu.nextElementSibling.querySelectorAll("th")].map((c) => c.textContent),
    note: menu.nextElementSibling.querySelector(".td-table + .table-note")?.textContent.slice(0, 22) || "",
    rows: [...menu.nextElementSibling.querySelectorAll("tbody tr")].map((r) => [...r.cells].map((c) => c.textContent)) };
}));
const now = await standingsTables();
JSON.stringify(now.map((s) => [s.name, s.after, s.options, s.rows.length])) === JSON.stringify([
  ["Open", "2", ["1", "2 (in progress)"], 4], ["Under 1400", "1", ["1"], 3]])
  && now[0].head.join("|") === "Place|Name|Rating|Score|Round 1|Round 2|Median|Solkoff|Cumulative|Opp. cumulative|Performance|Est. rating ?"
  && now[0].rows.slice(0, 2).every((r) => r[3] === "1.5")
  // Ann and Ben, Cal and Dee, and Eve and Fay tie on every 34E tiebreak, so each pair shares a place.
  && now.map((s) => s.rows.map((r) => r[0]).join()).join("|") === "1,1,3,3|1,2,2"
  && now.every((s) => s.note === "")
  // Each round: the result, the opponent's row, and the color; Cal and Dee's game has no result yet.
  && now[0].rows.map((r) => `${r[1]} ${r[4]}, ${r[5]}`).join("|") === "Ann W3 w, D2 b|Ben W4 b, D1 w|Cal L1 b, 4 w|Dee L2 w, 3 b"
  && now[1].rows.map((r) => `${r[1]} ${r[4]}`).join("|") === "Gus B|Eve D3 w|Fay D2 b"
  && now.flatMap((s) => s.rows.map((r) => `${r[1]} ${r[s.head.indexOf("Performance")]} ${r[s.head.indexOf("Est. rating ?")]}`)).join("|")
    === "Ann 1891 1996|Ben 1941 1813|Cal 1200 1596|Dee 1000 1494|Gus  |Eve 1200 1293|Fay 1300 1207"
  ? pass("Standings page shows each section after its latest round with results: rounds, the 34E tiebreaks, performance, and estimated ratings")
  : fail(`Standings page: ${JSON.stringify(now)}`);
// Est. rating's ? shows its explanation over the table on hover, keeps it while the pointer moves onto it, and Escape hides it.
const tipShown = () => standingsPage.evaluate(() => {
  const tip = document.getElementById("estimate-tip");
  const at = tip.getBoundingClientRect();
  return { open: tip.matches(":popover-open"), text: tip.textContent.slice(0, 21), inside: at.left >= 0 && at.right <= innerWidth,
    expanded: document.querySelector(".standings-all th .hint-button").getAttribute("aria-expanded") };
});
await standingsPage.hover(".standings-all th .hint-button");
const tipHover = await tipShown();
await standingsPage.hover("#estimate-tip");
await new Promise((resolve) => setTimeout(resolve, 400));
const tipKept = await tipShown();
await standingsPage.keyboard.press("Escape");
const tipGone = await tipShown();
tipHover.open && tipHover.inside && tipHover.text === "Est. rating estimates" && tipHover.expanded === "true" && tipKept.open
  && !tipGone.open && tipGone.expanded === "false"
  ? pass("Standings page's Est. rating ? shows its explanation over the table, keeps it under the pointer, and hides it on Escape")
  : fail(`Standings page Est. rating hint: ${JSON.stringify({ tipHover, tipKept, tipGone })}`);
await standingsPage.mouse.move(0, 0);
await standingsPage.select(".standings-all select", "1");
const afterOne = await standingsTables();
afterOne[0].after === "1" && afterOne[0].rows[0][1] === "Ann" && afterOne[0].rows[0][3] === "1"
  ? pass("Standings page's menu shows the standings after an earlier round") : fail(`Standings page after round 1: ${JSON.stringify(afterOne)}`);
await axeBoth(standingsPage, "Standings page with two sections");
await standingsPage.setViewport(PHONE);
await fitsPhone(standingsPage, "Standings page with two sections");
await standingsPage.close();

// Byes asked for in rounds not yet posted are posted with each section (22C4), above the round menu on Pairings and
// below the table on Standings: by round, or in a month by night. A round already posted has them under Without a game.
const withByesAsked = (extra) => twoSections().map((t) => ({ ...t, plannedRounds: 4, ...extra,
  players: t.players.map((p) => ({ ...p, ...{ a: { byes: [3, 4] }, f: { byes: [2, 3] } }[p.id] })) }));
let askedTournaments = withByesAsked({});
const askedLines = (tab) => tab.$$eval("main p", (ps) => ps.filter((p) => p.textContent.startsWith("Byes asked for")).map((p) => ({
  text: p.textContent, before: p.previousElementSibling.className || p.previousElementSibling.tagName, after: p.nextElementSibling?.className || "" })));
const askedPairings = await mocked("/pairings/ with byes asked for", () => ({ tournaments: askedTournaments }));
await askedPairings.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const byRound = await askedLines(askedPairings);
askedTournaments = withByesAsked({ roundDates: ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"] });
await askedPairings.reload({ waitUntil: "networkidle0" });
const byNight = await askedLines(askedPairings);
await askedPairings.close();
const askedStandings = await mocked("/standings/ with byes asked for", () => ({ tournaments: askedTournaments }));
await askedStandings.goto(base + "/standings/", { waitUntil: "networkidle0" });
const belowTable = await askedLines(askedStandings);
askedTournaments = withByesAsked({ status: "rated" });
await askedStandings.reload({ waitUntil: "networkidle0" });
const onceRated = await askedLines(askedStandings);
await askedStandings.close();
JSON.stringify(byRound) === JSON.stringify([{ text: "Byes asked for: Ann (2000), rounds 3 and 4.", before: "H3", after: "round-menu" },
  { text: "Byes asked for: Fay (1200), round 3.", before: "H3", after: "round-menu" }])
  && JSON.stringify(byNight.map((l) => l.text)) === JSON.stringify(["Byes asked for: Ann (2000), October 19 and 26.", "Byes asked for: Fay (1200), October 19."])
  && JSON.stringify(belowTable.map((l) => [l.text, l.before])) === JSON.stringify([["Byes asked for: Ann (2000), October 19 and 26.", "round-shown"],
    ["Byes asked for: Fay (1200), October 19.", "round-shown"]]) && !onceRated.length
  ? pass("Pairings and Standings pages post the byes asked for in rounds not yet posted, by round or by night, until the tournament is rated")
  : fail(`Byes asked for: ${JSON.stringify({ byRound, byNight, belowTable, onceRated })}`);

// A quad on the Standings page: Sonneborn-Berger and head-to-head.
const quadStandingsPage = await mocked("/standings/ with quads", () => {
  const players = [["a", "Ann", 1900], ["b", "Ben", 1800], ["c", "Cal", 1700], ["d", "Dee", 1600]]
    .map(([id, name, rating], i) => ({ id, number: i + 1, name, rating, section: "Quad 1", out: null }));
  const rounds = [{ games: [{ board: 1, white: "a", black: "d", result: "1-0", section: "Quad 1" }, { board: 2, white: "b", black: "c", result: "1-0", section: "Quad 1" }], byes: [], out: [], posted: true }];
  return { tournaments: [{ name: "Alley Cat Quad, Saturday, October 10, 2026", format: "quad", plannedRounds: 3, status: "running",
    sections: [{ name: "Quad 1" }], players, rounds }] };
});
await quadStandingsPage.goto(base + "/standings/", { waitUntil: "networkidle0" });
const quadHead = await quadStandingsPage.$$eval(".standings-all th", (cells) => cells.map((c) => c.textContent));
quadHead.join("|") === "Place|Name|Rating|Score|Round 1|Sonneborn-Berger|Head-to-head|Performance|Est. rating ?"
  ? pass("Standings page ranks a quad by score, Sonneborn-Berger, and head-to-head (34F)") : fail(`Standings page quad: ${JSON.stringify(quadHead)}`);
await quadStandingsPage.close();

// Starting a Swiss in two sections on the TD desk, on a phone: the TD adds a section, moves a
// player up, pairs round one in each section, posts it, and enters a result.
let sectioned = null;
const sectionCalls = [];
const sectionDesk = await mocked("/td/ running a Swiss in two sections", (p) => {
  sectionCalls.push(p);
  if (p.action === "choices") return { choices: [{ key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry", first: "2026-11-07" }] };
  if (p.action === "entries") return { entries: [] };
  if (p.action === "incidents") return { incidents: [] };
  if (p.action === "tournament") return { tournament: sectioned };
  if (p.action === "start") {
    const sections = JSON.parse(p.sections);
    const players = [["11111111", "Ann", 1900], ["22222222", "Ben", 1700], ["33333333", "Cal", 1500], ["44444444", "Dee", 1450],
      ["55555555", "Eve", 1300], ["66666666", "Fay", 1200], ["77777777", "Gus", null]]
      .map(([id, name, rating], i) => ({ id, number: i + 1, name, rating, out: null,
        section: rating != null && rating >= 1400 ? "Open" : "Under 1400" }));
    sectioned = { key: "classic/2026-11-07", name: "Classic", format: "swiss", plannedRounds: Number(p.rounds), status: "running",
      coin: p.coin, sections, players, rounds: [], halfByes: { limit: 1, everyRound: true } };
    return { ok: true, message: "Added 7 player(s)." };
  }
  if (p.action === "section") {
    sectioned.players.find((x) => x.id === p.id).section = p.section;
    for (const b of sectioned.rounds.flatMap((r) => r.byes).filter((b) => b.id === p.id)) b.section = p.section;
    return { ok: true, message: "Moved." };
  }
  if (p.action === "sectionNames") {
    const list = JSON.parse(p.sections);
    const renamed = Object.fromEntries(list.map((x) => [x.from, x.name]));
    sectioned.sections = list.map((x) => ({ ...sectioned.sections.find((d) => d.name === x.from), name: x.name }));
    for (const x of [...sectioned.players, ...sectioned.rounds.flatMap((r) => [...r.games, ...r.byes])]) x.section = renamed[x.section] ?? x.section;
    return { ok: true, message: `Sections: ${list.map((x) => x.name).join(", ")}.` };
  }
  if (p.action === "sync") {
    sectioned.players.push({ id: "88888888", number: 8, name: "Hal", rating: 1100, out: null, section: "Under 1400" });
    sectioned.rounds[0].byes.push({ id: "88888888", points: 0.5, kind: "half", section: "Under 1400" });
    return { ok: true, message: "Added 1 player(s)." };
  }
  if (p.action === "round") {
    sectioned.rounds = [{ games: JSON.parse(p.games).map((g) => ({ ...g, result: "" })), byes: JSON.parse(p.byes), out: [], posted: p.post === "yes" }];
    return { ok: true, message: "Round 1 is posted." };
  }
  if (p.action === "result") {
    sectioned.rounds[0].games.find((g) => g.board === Number(p.board) && g.section === p.section).result = p.result;
  }
  return { ok: true };
}, PHONE);
await sectionDesk.goto(base + "/td/", { waitUntil: "networkidle0" });
await sectionDesk.type("#td-password", "secret");
await sectionDesk.click(".td-login button");
await sectionDesk.waitForSelector(".run-start:not([hidden])");
await sectionDesk.type("#run-rounds", "3");
await press(sectionDesk, ".run-start .run-section-add");
await sectionDesk.type(".run-start .run-section-row:last-child .run-section-name", "Under 1400");
await sectionDesk.type(".run-start .run-section-row:last-child .run-section-under", "1400");
await fitsPhone(sectionDesk, "TD desk's start form with two sections");
await press(sectionDesk, ".run-start button[type=submit]");
await sectionDesk.waitForFunction(() => document.querySelectorAll(".run-attendance").length === 2);
const started = sectionCalls.find((c) => c.action === "start") || {};
const checkin = await sectionDesk.evaluate(() => ({
  headings: [...document.querySelectorAll(".run-attendance-all h4")].map((h) => h.textContent),
  // Dee, 1450, can't play down; Fay, 1200, can play up.
  dee: [...document.querySelector('select[aria-label="Dee\'s section"]').options].map((o) => o.value),
  fay: [...document.querySelector('select[aria-label="Fay\'s section"]').options].map((o) => o.value) }));
started.td === "31847334" && started.sections === JSON.stringify([{ name: "Open" }, { name: "Under 1400", under: 1400 }])
  && JSON.stringify(checkin) === JSON.stringify({ headings: ["Open (4)", "Under 1400 (3)"], dee: ["Open"], fay: ["Open", "Under 1400"] })
  ? pass("TD desk starts a Swiss in two sections and checks in each section, offering only sections a player may enter")
  : fail(`TD desk sections at start: ${JSON.stringify({ started, checkin })}`);
await sectionDesk.select('select[aria-label="Fay\'s section"]', "Open");
await sectionDesk.waitForFunction(() => document.querySelector(".run-attendance-all h4")?.textContent === "Open (5)");
const moved = sectionCalls.find((c) => c.action === "section") || {};
moved.id === "66666666" && moved.section === "Open" ? pass("TD desk moves a player up a section before round 1")
  : fail(`TD desk section move: ${JSON.stringify(moved)}`);
await axeBoth(sectionDesk, "TD desk checking in two sections");
await fitsPhone(sectionDesk, "TD desk checking in two sections");
await press(sectionDesk, ".run-pair");
await sectionDesk.waitForSelector(".run-pairings:not([hidden])");
const review = await sectionDesk.$$eval(".run-games-all h4", (h) => h.map((x) => x.textContent));
await press(sectionDesk, ".run-post");
await sectionDesk.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const firstRound = sectionCalls.find((c) => c.action === "round") || {};
const sectionGames = JSON.parse(firstRound.games || "[]").map((g) => [g.section, g.board, g.white, g.black]);
const sectionByes = JSON.parse(firstRound.byes || "[]");
// Open: Ann, Ben, Cal, Dee, and Fay playing up, the lowest rated, with the bye (28L2); Under 1400: Eve and Gus.
JSON.stringify(review) === JSON.stringify(["Open", "Under 1400"])
  && JSON.stringify(sectionGames) === JSON.stringify([["Open", 1, "11111111", "33333333"], ["Open", 2, "44444444", "22222222"],
    ["Under 1400", 1, "55555555", "77777777"]])
  && JSON.stringify(sectionByes) === JSON.stringify([{ id: "66666666", points: 1, kind: "bye", section: "Open" }])
  ? pass("TD desk pairs round one in each section on its own, boards numbered within each")
  : fail(`TD desk two-section round one: ${JSON.stringify({ review, sectionGames, sectionByes })}`);
await sectionDesk.select('select[aria-label="Under 1400 board 1 result"]', "1-0");
await sectionDesk.waitForFunction(() => document.querySelectorAll(".run-standings").length === 2);
const resulted = sectionCalls.find((c) => c.action === "result") || {};
resulted.section === "Under 1400" && resulted.board === "1" && resulted.result === "1-0"
  ? pass("TD desk enters a result by section and board, with each section's standings") : fail(`TD desk result: ${JSON.stringify(resulted)}`);
const deskPerformance = await sectionDesk.$$eval(".run-standings", (tables) => tables.map((t) => {
  const at = [...t.tHead.rows[0].cells].findIndex((c) => c.textContent === "Performance");
  return [t.tHead.rows[0].cells[at]?.textContent, ...[...t.tBodies[0].rows].map((r) => `${r.cells[1].textContent} ${r.cells[at].textContent}`)];
}));
// Eve beat an unrated player, so she has no rated games; Gus lost to a 1300.
JSON.stringify(deskPerformance[1]) === JSON.stringify(["Performance", "Eve ", "Gus 500"])
  ? pass("TD desk shows performance ratings in the standings") : fail(`TD desk performance: ${JSON.stringify(deskPerformance)}`);
// The round without a game can be reclassified afterward; the change saves at once.
await sectionDesk.select('.run-byes-all select[aria-label$="round 1"]', "half");
await sectionDesk.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Half-point bye"));
const reclassified = sectionCalls.find((c) => c.action === "byeKind") || {};
reclassified.id === "66666666" && reclassified.number === "1" && reclassified.kind === "half"
  ? pass("TD desk reclassifies a full-point bye as a half-point bye afterward") : fail(`TD desk reclassify: ${JSON.stringify(reclassified)}`);
await axeBoth(sectionDesk, "TD desk entering results in two sections");
await fitsPhone(sectionDesk, "TD desk entering results in two sections");
// A late entrant, added after round 1 with its half-point bye (28K), can still be moved up until their
// first game; everyone who has played, or had the full-point bye, stays in their section.
await sectionDesk.select('select[aria-label="Open board 1 result"]', "1-0");
await sectionDesk.select('select[aria-label="Open board 2 result"]', "0-1");
await sectionDesk.waitForSelector(".run-checkin:not([hidden])");
await press(sectionDesk, ".run-sync");
await sectionDesk.waitForFunction(() => document.querySelector('select[aria-label="Hal\'s section"]'));
const late = await sectionDesk.evaluate(() => ({
  menus: [...document.querySelectorAll('.run-attendance select[aria-label$="\'s section"]')].map((m) => [m.getAttribute("aria-label"), [...m.options].map((o) => o.value)]),
  bye: document.querySelector('.run-byes-all select[aria-label="Hal (1100), round 1"]')?.value }));
JSON.stringify(late) === JSON.stringify({ menus: [["Hal's section", ["Open", "Under 1400"]]], bye: "half" })
  ? pass("TD desk offers a section only to a late entrant who hasn't played, whose missed round is a half-point bye")
  : fail(`TD desk late entrant: ${JSON.stringify(late)}`);
await sectionDesk.select('select[aria-label="Hal\'s section"]', "Open");
await sectionDesk.waitForFunction(() => document.querySelector(".run-attendance-all h4")?.textContent === "Open (6)");
const lateMove = sectionCalls.filter((c) => c.action === "section").at(-1) || {};
lateMove.id === "88888888" && lateMove.section === "Open" ? pass("TD desk moves a late entrant up a section after round 1")
  : fail(`TD desk late section move: ${JSON.stringify(lateMove)}`);
await axeBoth(sectionDesk, "TD desk checking in a late entrant");
await fitsPhone(sectionDesk, "TD desk checking in a late entrant");
// The TD renames Under 1400 and moves it first; check-in follows the new names and order.
await sectionDesk.click(".run-names-wrap summary");
await press(sectionDesk, '.run-names-list button[data-focus="Under 1400-Up"]');
const focusKept = await sectionDesk.evaluate(() => document.activeElement?.dataset.focus);
const reserve = await sectionDesk.$('input[aria-label="New name for Under 1400"]');
await reserve.click({ clickCount: 3 });
await reserve.type("Reserve");
await fitsPhone(sectionDesk, "TD desk renaming and ordering sections");
await axeBoth(sectionDesk, "TD desk renaming and ordering sections");
if (process.env.SHOTS) {
  for (const width of [390, 1600]) {
    await sectionDesk.setViewport({ width, height: 900 });
    await sectionDesk.screenshot({ path: `${process.env.SHOTS}/late-entrant-and-section-names-${width}.png`, fullPage: true });
  }
  await sectionDesk.setViewport(PHONE);
}
await press(sectionDesk, ".run-names button[type=submit]");
await sectionDesk.waitForFunction(() => document.querySelector(".run-attendance-all h4")?.textContent.startsWith("Reserve"));
const named = sectionCalls.find((c) => c.action === "sectionNames") || {};
const namedHeadings = await sectionDesk.$$eval(".run-attendance-all h4", (h) => h.map((x) => x.textContent));
named.sections === JSON.stringify([{ from: "Under 1400", name: "Reserve" }, { from: "Open", name: "Open" }])
  && focusKept === "Under 1400-Up" && JSON.stringify(namedHeadings) === JSON.stringify(["Reserve (2)", "Open (6)"])
  ? pass("TD desk renames and reorders the sections, and checks in under the new names in the new order")
  : fail(`TD desk section names: ${JSON.stringify({ named, focusKept, namedHeadings })}`);
await sectionDesk.close();

// Players reporting results on the Pairings page: Ben is saved on this device by the Register
// form, so his board gets buttons; board 1 already has White's report, which shows as awaiting the TD.
const fourPlayers = () => [["11111111", "Ann", 1900], ["22222222", "Ben", 1700], ["33333333", "Cal", 1500], ["44444444", "Dee", 1300]]
  .map(([id, name, rating], i) => ({ id, number: i + 1, name, rating, section: "", out: null }));
const reportable = () => [{ key: "classic/2026-11-07", name: "Classic, Saturday, November 7, 2026", format: "swiss", plannedRounds: 3,
  status: "running", sections: [], players: fourPlayers(), rounds: [{ games: [
    { board: 1, white: "11111111", black: "33333333", result: "", section: "", reports: { white: "1-0", black: "" } },
    { board: 2, white: "44444444", black: "22222222", result: "", section: "" }], byes: [], out: [], posted: true }] }];
const reports = [];
const reportAnswer = (p) => {
  if (p.action !== "report") return { tournaments: reportable() };
  reports.push(p);
  return { ok: true, message: `Board ${p.board}: 0–1 is reported. The TD will confirm it.` };
};
const reportPage = await mocked("/pairings/ reporting a result", reportAnswer, PHONE);
await reportPage.evaluateOnNewDocument(() => {
  if (!sessionStorage.getItem("seeded")) {
    localStorage.setItem("lccc-register-players", JSON.stringify([{ id: "22222222", last: "Ben", email: "ben@example.com", name: "Ben" }]));
    sessionStorage.setItem("seeded", "1");
  }
});
await reportPage.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const reportShown = () => reportPage.evaluate(() => ({
  results: [...document.querySelectorAll(".pairings-all tbody tr")].map((r) => r.cells[3].textContent),
  boxes: [...document.querySelectorAll(".report")].map((b) => b.querySelector("p").textContent),
  buttons: [...document.querySelectorAll(".report button")].map((b) => `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? " (pressed)" : ""}`),
  status: document.querySelector(".report [role=status]")?.textContent, focused: document.activeElement?.textContent }));
const beforeReport = await reportShown();
const prefilled = await reportPage.evaluate(() => ({ id: document.querySelector("#report-id").value,
  saved: [...document.querySelectorAll(".report-find .register-pick")].map((b) => b.textContent) }));
prefilled.id === "22222222" && JSON.stringify(prefilled.saved) === JSON.stringify(["Ben (22222222)"])
  ? pass("Pairings page fills in the ID the Register form saved, and lists the players saved on this device")
  : fail(`Pairings page saved players: ${JSON.stringify(prefilled)}`);
JSON.stringify(beforeReport.results) === JSON.stringify(["1–0, reported, awaiting the TD", ""])
  && beforeReport.boxes.length === 1 && beforeReport.boxes[0].startsWith("Board 2: Dee (1300) with white, Ben (1700) with black")
  && JSON.stringify(beforeReport.buttons) === JSON.stringify(["1–0, Dee won", "0–1, Ben won", "½–½, a draw"])
  ? pass("Pairings page shows a report awaiting the TD, and report buttons only for the board of a player saved here")
  : fail(`Pairings page reports: ${JSON.stringify(beforeReport)}`);
await axeBoth(reportPage, "Pairings page with a result to report");
await fitsPhone(reportPage, "Pairings page with a result to report");
await press(reportPage, ".report button:nth-child(2)");
await reportPage.waitForFunction(() => document.querySelector(".report [role=status]")?.textContent.includes("reported"));
const afterReport = await reportShown();
const sentReport = reports[0] || {};
JSON.stringify(sentReport) === JSON.stringify({ action: "report", event: "classic", date: "2026-11-07", number: "1", board: "2", section: "",
  id: "22222222", result: "0-1" }) && afterReport.results[1] === "0–1, reported, awaiting the TD"
  && afterReport.buttons[1] === "0–1, Ben won (pressed)" && afterReport.focused === "0–1, Ben won"
  ? pass("a saved player reports their result, which shows as awaiting the TD") : fail(`Pairings page report: ${JSON.stringify({ sentReport, afterReport })}`);
// A player who hasn't saved anyone finds their board by US Chess ID, which saves them the same way.
await reportPage.evaluate(() => localStorage.clear());
await reportPage.reload({ waitUntil: "networkidle0" });
const unsaved = await reportShown();
await reportPage.type("#report-id", "99999999");
await press(reportPage, ".report-find button[type=submit]");
const nobody = await reportPage.$eval(".report-find [role=status]", (p) => p.textContent);
await reportPage.$eval("#report-id", (i) => { i.value = ""; });
await reportPage.type("#report-id", "33333333");
await press(reportPage, ".report-find button[type=submit]");
await reportPage.waitForSelector(".report");
const foundBoard = await reportShown();
const savedNow = await reportPage.evaluate(() => JSON.parse(localStorage.getItem("lccc-register-players")));
unsaved.boxes.length === 0 && nobody.startsWith("Nobody with that US Chess ID") && foundBoard.boxes[0]?.startsWith("Board 1: Ann (1900)")
  && JSON.stringify(savedNow) === JSON.stringify([{ id: "33333333", last: "", email: "", name: "Cal" }]) && foundBoard.focused === "1–0, Ann won"
  ? pass("a player finds their board by US Chess ID on the Pairings page, and is saved on this device")
  : fail(`Pairings page find by ID: ${JSON.stringify({ unsaved, nobody, foundBoard, savedNow })}`);
await axeBoth(reportPage, "Pairings page after finding a board by US Chess ID");
await press(reportPage, ".report-find .register-forget");
const forgotten = await reportPage.evaluate(() => ({ saved: localStorage.getItem("lccc-register-players"), boxes: document.querySelectorAll(".report").length,
  listed: !document.querySelector(".report-find .register-saved").hidden }));
forgotten.saved === null && forgotten.boxes === 0 && !forgotten.listed
  ? pass("Forget on the Pairings page removes the saved player and their report buttons") : fail(`Pairings page forget: ${JSON.stringify(forgotten)}`);
await reportPage.close();

// A desk that keeps a Swiss of four in memory, for the checks below. rounds, if given, starts it with them.
function deskState(rounds) {
  const state = { calls: [], held: rounds ? { key: "classic/2026-11-07", name: "Classic", format: "swiss", plannedRounds: 3, status: "running",
    coin: "white", players: fourPlayers(), rounds, timeControl: "G/70;d10", halfByes: { limit: 1, everyRound: true } } : null };
  state.answer = (p) => {
    state.calls.push(p);
    const held = state.held;
    if (p.action === "choices") return { choices: [{ key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry", first: "2026-11-07" }] };
    if (p.action === "entries") return { entries: [] };
    if (p.action === "incidents") return { incidents: [] };
    if (p.action === "tournament") return { tournament: held && JSON.parse(JSON.stringify(held)) };
    if (p.action === "start") {
      state.held = { key: "classic/2026-11-07", name: "Classic", format: "swiss", plannedRounds: 3, status: "running", coin: p.coin, players: fourPlayers(), rounds: [],
        halfByes: { limit: 1, everyRound: true } };
      return { ok: true, message: "Added 4 player(s)." };
    }
    if (p.action === "round") {
      held.rounds[Number(p.number) - 1] = { games: JSON.parse(p.games).map((g) => ({ ...g, result: "" })), byes: JSON.parse(p.byes), out: [], posted: p.post === "yes" };
      return { ok: true, message: `Round ${p.number} is posted.` };
    }
    const board = (n) => held.rounds[Number(p.number) - 1].games.find((g) => g.board === Number(n));
    if (p.action === "result") board(p.board).result = p.result;
    if (p.action === "results") for (const r of JSON.parse(p.results)) board(r.board).result = r.result;
    return { ok: true };
  };
  return state;
}

async function signIn(tab) {
  await tab.goto(base + "/td/", { waitUntil: "networkidle0" });
  await tab.type("#td-password", "secret");
  await tab.click(".td-login button");
}

const draftShown = (tab) => tab.evaluate(() => ({
  games: [...document.querySelectorAll(".run-games tbody tr")].map((r) => [r.cells[0].textContent, ...[...r.querySelectorAll("select")].map((s) => s.value)]),
  off: [...document.querySelectorAll(".run-off tbody tr")].map((r) => [r.cells[0].textContent, r.querySelector("select").value]),
  problems: document.querySelector(".run-problems").hidden ? [] : [...document.querySelectorAll(".run-problems li")].map((li) => li.textContent),
  status: document.querySelector(".run-status").textContent, title: document.querySelector(".run-round-title").textContent,
  cancel: !document.querySelector(".run-cancel").hidden }));

// The desk's results view with players' reports: Confirm one, then Confirm agreed results; a conflict is flagged.
const reportDesk = deskState([{ games: [
  { board: 1, white: "11111111", black: "33333333", result: "", section: "", reports: { white: "1-0", black: "1-0" } },
  { board: 2, white: "44444444", black: "22222222", result: "", section: "", reports: { white: "", black: "0-1" } }], byes: [], out: [], posted: true }]);
const sixPlayers = [...fourPlayers(), { id: "55555555", number: 5, name: "Eve", rating: 1200, section: "", out: null },
  { id: "66666666", number: 6, name: "Fay", rating: 1100, section: "", out: null }];
reportDesk.held.players = sixPlayers;
reportDesk.held.rounds[0].games.push({ board: 3, white: "55555555", black: "66666666", result: "", section: "", reports: { white: "1-0", black: "0-1" } });
const confirmPage = await mocked("/td/ confirming reported results", reportDesk.answer);
await signIn(confirmPage);
await confirmPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const reportedCells = () => confirmPage.evaluate(() => [...document.querySelectorAll(".run-games tbody tr")].map((r) => ({
  text: r.cells[3].childNodes[0]?.textContent || "", confirm: Boolean(r.cells[3].querySelector("button")), conflict: r.cells[3].className === "run-conflict",
  result: r.querySelector("select").value })));
const onArrival = await reportedCells();
const agreedButton = () => confirmPage.$eval(".run-confirm-agreed", (b) => (b.hidden ? "" : b.textContent));
JSON.stringify(onArrival) === JSON.stringify([
  { text: "1–0, both reported", confirm: true, conflict: false, result: "" }, { text: "0–1, Black reported", confirm: true, conflict: false, result: "" },
  { text: "Conflict: White reported 1–0, Black 0–1", confirm: false, conflict: true, result: "" }]) && await agreedButton() === "Confirm agreed results (1)"
  ? pass("TD desk shows each board's reports, flags a conflict, and offers to confirm the agreed ones")
  : fail(`TD desk reports: ${JSON.stringify(onArrival)}, ${await agreedButton()}`);
await axeBoth(confirmPage, "TD desk with reported results");
await press(confirmPage, ".run-games tbody tr:nth-child(2) td:nth-child(4) button");
await confirmPage.waitForFunction(() => document.querySelector(".run-games tbody tr:nth-child(2) select").value === "0-1");
await press(confirmPage, ".run-confirm-agreed");
await confirmPage.waitForFunction(() => document.querySelector(".run-games tbody tr:nth-child(1) select").value === "1-0");
const confirmed = await reportedCells();
const one = reportDesk.calls.find((c) => c.action === "result") || {};
const together = reportDesk.calls.find((c) => c.action === "results") || {};
one.board === "2" && one.result === "0-1" && one.section === "" && together.number === "1"
  && together.results === JSON.stringify([{ board: 1, section: "", result: "1-0" }])
  && !confirmed[0].confirm && !confirmed[1].confirm && confirmed[2].result === "" && await agreedButton() === ""
  && await confirmPage.$eval(".run-edit", (b) => b.hidden)
  ? pass("TD desk confirms one report, then the agreed results together; the conflict waits for the TD")
  : fail(`TD desk confirming: ${JSON.stringify({ one, together, confirmed })}`);
await confirmPage.close();

// Editing a draft on a phone: swap colors, remove a board, refuse to save with players not yet
// paired, add a board, take a player out of a game for a bye, and seat a player from a bye.
const editDesk = deskState();
const editPage = await mocked("/td/ editing a draft", editDesk.answer, PHONE);
await signIn(editPage);
await editPage.waitForSelector(".run-start:not([hidden])");
await editPage.type("#run-rounds", "3");
await press(editPage, ".run-start button[type=submit]");
await editPage.waitForFunction(() => document.querySelectorAll(".run-attendance tbody tr").length === 4);
await press(editPage, ".run-pair");
await editPage.waitForSelector(".run-pairings:not([hidden])");
await press(editPage, ".run-games tbody tr:nth-child(1) .td-buttons button:nth-child(1)");
const swapped = await draftShown(editPage);
await press(editPage, ".run-games tbody tr:nth-child(2) .td-buttons button:nth-child(2)");
const removed = await draftShown(editPage);
await press(editPage, ".run-post");
const refused = await draftShown(editPage);
JSON.stringify(swapped.games) === JSON.stringify([["1", "33333333", "11111111", ""], ["2", "44444444", "22222222", ""]])
  && JSON.stringify(removed.games) === JSON.stringify([["1", "33333333", "11111111", ""]])
  && JSON.stringify(removed.off) === JSON.stringify([["Ben (1700)", "waiting"], ["Dee (1300)", "waiting"]])
  && removed.problems.length === 2 && removed.problems[0].startsWith("Ben (1700) isn't paired yet")
  && refused.status.startsWith("Not saved yet. Ben (1700) isn't paired yet") && !editDesk.calls.some((c) => c.action === "round")
  ? pass("TD desk swaps a board's colors, removes a board, and won't save with players not yet paired")
  : fail(`TD desk draft edits: ${JSON.stringify({ swapped, removed, refused })}`);
await editPage.select("#run-add-white-0", "44444444");
await editPage.select("#run-add-black-0", "22222222");
await press(editPage, ".run-tools p:nth-child(1) button");
const added = await draftShown(editPage);
await editPage.select("#run-move-0", "44444444");
await editPage.select("#run-move-kind-0", "bye");
await press(editPage, ".run-tools p:last-child button");
await editPage.select('select[aria-label="Ben (1700) this round"]', "half");
await editPage.select('select[aria-label="Board 1 white"]', "22222222");
const edited = await draftShown(editPage);
JSON.stringify(added.games) === JSON.stringify([["1", "33333333", "11111111", ""], ["2", "44444444", "22222222", ""]]) && added.problems.length === 0
  && JSON.stringify(edited.games) === JSON.stringify([["1", "22222222", "11111111", ""]])
  && JSON.stringify(edited.off) === JSON.stringify([["Cal (1500)", "half"], ["Dee (1300)", "bye"]]) && edited.problems.length === 0
  ? pass("TD desk adds a board, moves a player out of a game to a bye, and seats a player from a bye in another's place")
  : fail(`TD desk draft edits: ${JSON.stringify({ added, edited })}`);
await axeBoth(editPage, "TD desk editing a draft");
await fitsPhone(editPage, "TD desk editing a draft");
await press(editPage, ".run-post");
await editPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const editedRound = editDesk.calls.find((c) => c.action === "round") || {};
editedRound.games === JSON.stringify([{ board: 1, white: "22222222", black: "11111111", section: "", result: "" }])
  && editedRound.byes === JSON.stringify([{ id: "44444444", points: 1, kind: "bye", section: "" }, { id: "33333333", points: 0.5, kind: "half", section: "" }])
  ? pass("TD desk posts the edited pairings") : fail(`TD desk edited round: ${JSON.stringify(editedRound)}`);
await editPage.close();

// Pairing by hand, then changing the posted round once a player has reported.
const handDesk = deskState();
const handPage = await mocked("/td/ pairing by hand", handDesk.answer);
handPage.on("dialog", (d) => d.accept());
await signIn(handPage);
await handPage.waitForSelector(".run-start:not([hidden])");
await handPage.type("#run-rounds", "3");
await press(handPage, ".run-start button[type=submit]");
await handPage.waitForFunction(() => document.querySelectorAll(".run-attendance tbody tr").length === 4);
await press(handPage, ".run-by-hand");
await handPage.waitForSelector(".run-pairings:not([hidden])");
const empty = await draftShown(handPage);
await press(handPage, ".run-tools p:nth-child(1) button");
await press(handPage, ".run-tools p:nth-child(1) button");
const byHand = await draftShown(handPage);
empty.games.length === 0 && empty.off.every(([, kind]) => kind === "waiting") && empty.off.length === 4 && empty.problems.length === 4
  && JSON.stringify(byHand.games) === JSON.stringify([["1", "11111111", "22222222", ""], ["2", "33333333", "44444444", ""]])
  && byHand.off.length === 0 && byHand.problems.length === 0
  ? pass("TD desk pairs a round by hand, starting with everyone not yet paired")
  : fail(`TD desk pairing by hand: ${JSON.stringify({ empty, byHand })}`);
await press(handPage, ".run-post");
await handPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
handDesk.held.rounds[0].games[0].reports = { white: "1-0", black: "" };
await press(handPage, ".run-refresh");
await handPage.waitForFunction(() => document.querySelector(".run-games tbody tr td:nth-child(4)").textContent.startsWith("1–0, White reported"));
await press(handPage, ".run-edit");
await handPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("change the posted"));
const reopened = await draftShown(handPage);
await press(handPage, ".run-games tbody tr:nth-child(2) .td-buttons button:nth-child(1)");
await axeBoth(handPage, "TD desk changing a posted round");
await press(handPage, ".run-post");
await handPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const reposted = handDesk.calls.filter((c) => c.action === "round");
reopened.cancel && JSON.stringify(reopened.games) === JSON.stringify(byHand.games) && reposted.length === 2
  && reposted[1].number === "1" && reposted[1].post === "yes"
  && JSON.parse(reposted[1].games).map((g) => [g.board, g.white, g.black]).join("|") === "1,11111111,22222222|2,44444444,33333333"
  && !(await handPage.$eval(".run-games tbody tr td:nth-child(4)", (c) => c.textContent))
  ? pass("TD desk changes a posted round without results and posts it again, which clears its reports")
  : fail(`TD desk editing a posted round: ${JSON.stringify({ reopened, reposted })}`);
await handPage.close();

// Byes asked for in advance at check-in: Ben and Cal asked for round 2, so both start round 2
// as half-point byes, which the pairing takes, without counting as unsaved work that holds back the desk's
// reloads. The rounds not yet paired are listed under Byes and unplayed rounds, and the register form offers only those.
const checkinByeDesk = deskState([{ games: [{ board: 1, white: "11111111", black: "33333333", result: "1-0", section: "" },
  { board: 2, white: "44444444", black: "22222222", result: "0-1", section: "" }], byes: [], out: [], posted: true }]);
checkinByeDesk.held.players[1].byes = [2];
checkinByeDesk.held.players[2].byes = [2];
const checkinByePage = await mocked("/td/ checking in byes asked for", checkinByeDesk.answer);
await signIn(checkinByePage);
await checkinByePage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 2: check in");
const checkinByes = await checkinByePage.evaluate(() => {
  document.activeElement?.blur();
  return { head: [...document.querySelectorAll(".run-attendance th")].map((th) => th.textContent),
    rows: [...document.querySelectorAll(".run-attendance tbody tr")].map((r) => [r.cells[1].textContent, r.cells[4].textContent, r.querySelector("select").value]),
    hint: document.querySelector(".run-checkin-hint").textContent, busy: runBusy(),
    asked: document.querySelector(".run-byes-all p:last-child").textContent,
    offered: [...document.querySelectorAll(".td-byes:not([hidden]) label")].map((l) => l.textContent.trim()) };
});
await checkinByePage.select('select[aria-label="Ann this round"]', "absent");
const checkinByesBusy = await checkinByePage.evaluate(() => { document.activeElement?.blur(); return runBusy(); });
await checkinByePage.select('select[aria-label="Ann this round"]', "play");
JSON.stringify(checkinByes.head) === JSON.stringify(["No.", "Name", "Rating", "Score", "Byes asked for", "This round"])
  && JSON.stringify(checkinByes.rows) === JSON.stringify([["Ann", "", "play"], ["Ben", "2", "half"], ["Cal", "2", "half"], ["Dee", "", "play"]])
  && checkinByes.hint.startsWith("Everyone starts as Present, or as a half-point bye if they asked for one this round;")
  && !checkinByes.busy && checkinByesBusy
  ? pass("TD desk starts a player who asked for a bye this round as a half-point bye, shows the byes asked for, and counts only a changed choice as unsaved")
  : fail(`TD desk check-in with byes: ${JSON.stringify({ checkinByes, checkinByesBusy })}`);
checkinByes.asked === "Asked for: Ben (1700), round 2; Cal (1500), round 2. Change them in the entries list."
  && JSON.stringify(checkinByes.offered) === JSON.stringify(["Round 2", "Round 3"])
  ? pass("TD desk lists the byes asked for rounds not yet paired, and the register form offers only those rounds")
  : fail(`TD desk byes asked for: ${JSON.stringify({ asked: checkinByes.asked, offered: checkinByes.offered })}`);
await axeBoth(checkinByePage, "TD desk checking in byes asked for");
await checkinByePage.setViewport(PHONE);
await fitsPhone(checkinByePage, "TD desk checking in byes asked for");
await press(checkinByePage, ".run-pair");
await checkinByePage.waitForSelector(".run-pairings:not([hidden])");
const checkinByeDraft = await draftShown(checkinByePage);
checkinByeDraft.games.length === 1 && checkinByeDraft.games[0].slice(1, 3).sort().join() === "11111111,44444444"
  && JSON.stringify(checkinByeDraft.off) === JSON.stringify([["Ben (1700)", "half"], ["Cal (1500)", "half"]])
  ? pass("TD desk pairs the round with the half-point byes asked for") : fail(`TD desk pairing byes asked for: ${JSON.stringify(checkinByeDraft)}`);
await checkinByePage.close();

// A started month's tournament that comes back after the entries gives them its nights, past ones too; and a bye
// saved from the entries list reaches check-in through the tournament's copy.
const monthByeEntries = [{ name: "Ann", id: "11111111", rating: "1900", for: "Whole month", category: "Adult", amount: "17", due: "17",
  card: "17.80", email: "", expires: "2027-01-31", token: "ann1", date: "2026-10", byes: [] }];
const monthByeHeld = { key: "club-night/2026-10", name: "Club Night", format: "swiss", plannedRounds: 3, status: "running", coin: "white",
  roundDates: ["2026-10-12", "2026-10-19", "2026-10-26"], players: fourPlayers(),
  halfByes: { limit: 1, everyRound: true },
  rounds: [{ games: [{ board: 1, white: "22222222", black: "33333333", result: "1-0", section: "" },
    { board: 2, white: "11111111", black: "44444444", result: "1-0", section: "" }], byes: [], out: [], posted: true }] };
let releaseMonthBye;
const monthByeLoad = new Promise((resolve) => { releaseMonthBye = resolve; });
const monthByePage = await mocked("/td/ with a month's byes", async (p) => {
  if (p.action === "tournament") await monthByeLoad;
  if (p.action === "byes") {
    monthByeEntries[0].byes = p.byes.split(", ");
    monthByeHeld.players[0].byes = monthByeEntries[0].byes.map((date) => monthByeHeld.roundDates.indexOf(date) + 1);
    return { ok: true, message: "Ann's byes are saved." };
  }
  return { login: { ok: true, changes: null },
    choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" },
      { key: "club-night/2026-10-19", name: "Club Night", label: "Monday, October 19, 2026", kind: "night", first: "2026-10-19" },
      { key: "club-night/2026-10-26", name: "Club Night", label: "Monday, October 26, 2026", kind: "night", first: "2026-10-26" }] },
    people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: JSON.parse(JSON.stringify(monthByeEntries)) },
    ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
    incidents: { incidents: [] }, tournament: { tournament: JSON.parse(JSON.stringify(monthByeHeld)) } }[p.action] || { ok: true };
});
await signIn(monthByePage);
const monthByeCell = () => monthByePage.$eval(".td-entries tbody td:nth-child(5)", (c) => [...c.childNodes]
  .map((n) => (n.querySelector ? `${n.querySelector("input").value}${n.querySelector("input").checked ? " (checked)" : ""}` : n.textContent.trim())).filter(Boolean));
await monthByePage.waitForSelector(".td-entries tbody td:nth-child(5) input");
const monthByesEarly = await monthByeCell();
releaseMonthBye();
const monthByesRedrawn = await monthByePage.waitForFunction(() => document.querySelectorAll(".td-entries tbody td:nth-child(5) input").length === 3,
  { timeout: 5000 }).then(() => true, () => false);
const monthByesLoaded = await monthByeCell();
await monthByePage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 2: check in");
await monthByePage.click('.td-entries input[value="2026-10-19"]');
const monthByeCheckin = await monthByePage.waitForFunction(() => [...document.querySelectorAll(".run-attendance tbody tr")]
  .find((r) => r.cells[1].textContent === "Ann" && r.querySelector("select").value === "half")?.cells[4].textContent, { timeout: 5000 })
  .then((cell) => cell.jsonValue(), () => null);
JSON.stringify(monthByesEarly) === JSON.stringify(["2026-10-19", "2026-10-26"]) && monthByesRedrawn
  && JSON.stringify(monthByesLoaded) === JSON.stringify(["2026-10-12", "2026-10-19", "2026-10-26"])
  && monthByeCheckin?.replaceAll(" ", " ") === "2 (October 19)"
  ? pass("TD desk shows a started month's nights, past ones too, once its tournament loads, and check-in follows a bye saved from the entries")
  : fail(`TD desk month byes: ${JSON.stringify({ monthByesEarly, monthByesRedrawn, monthByesLoaded, monthByeCheckin })}`);
await monthByePage.close();

// The menu: on one line at 1100px; on a phone it wraps, without covering the page or scrolling sideways.
const layout = await browser.newPage();
// The live registration script can take longer than a page load allows; the layout doesn't need it.
await layout.setRequestInterception(true);
layout.on("request", (request) => (outside(request) ? request.abort() : request.continue()));
const failedBefore = failures.length;
for (const path of pages) {
  await layout.setViewport({ width: 1100, height: 800 });
  await layout.goto(base + path, { waitUntil: "networkidle0" });
  const wide = await layout.evaluate(() => {
    const tops = [...document.querySelectorAll(".site-nav li")].map((li) => Math.round(li.getBoundingClientRect().top));
    const brand = document.querySelector(".site-nav .brand").getBoundingClientRect();
    const list = document.querySelector(".site-nav ul").getBoundingClientRect();
    return { lines: new Set(tops).size, besideBrand: list.top < brand.bottom, footer: Boolean(document.querySelector('footer a[href="/minutes/"]')),
      menu: [...document.querySelectorAll(".site-nav li")].map((li) => li.textContent).join(", ") };
  });
  if (wide.lines !== 1 || !wide.besideBrand || !wide.footer || wide.menu !== "Events, Entries, Pairings, Standings, Results, Scholastic, Join") {
    fail(`menu at 1100px on ${path}: ${JSON.stringify(wide)}`);
  }
  await layout.setViewport(PHONE);
  await layout.goto(base + path, { waitUntil: "networkidle0" });
  const narrow = await layout.evaluate(() => ({ nav: document.querySelector(".site-nav").getBoundingClientRect().bottom,
    content: document.querySelector("main").getBoundingClientRect().top, wide: document.documentElement.scrollWidth, view: innerWidth }));
  if (narrow.content < narrow.nav || narrow.wide > narrow.view) fail(`${path} on a phone: ${JSON.stringify(narrow)}`);
}
if (failures.length === failedBefore) pass(`the menu fits one line at 1100px, and on a phone covers none of the ${pages.length} pages or makes them scroll sideways`);
await layout.close();

// A quad on the TD desk: round one comes from the round robin table (30G), with no check-in.
const quadPage = await browser.newPage();
quadPage.on("pageerror", (error) => fail(`JavaScript error on /td/ running a quad: ${error.message}`));
const quadCalls = [];
let quad = null;
await quadPage.setRequestInterception(true);
quadPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
    return;
  }
  if (url.host !== "registration.test") return request.continue();
  const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
  quadCalls.push(p);
  // Numbers by lot: 3, 1, 4, 2 for the players in rating order.
  const players = [["11111111", "Ann", 1900, 3], ["22222222", "Ben", 1700, 1], ["33333333", "Cal", 1500, 4], ["44444444", "Dee", 1300, 2]]
    .map(([id, name, rating, number]) => ({ id, number, name, rating, out: null }));
  let body = { ok: true };
  if (p.action === "choices") body = { choices: [{ key: "alley-cat-quad/2026-10-10", name: "Alley Cat Quad", label: "Saturday, October 10, 2026", kind: "entry", first: "2026-10-10", format: "quad", closed: true }] };
  else if (p.action === "entries") body = { entries: [] };
  else if (p.action === "incidents") body = { incidents: [] };
  else if (p.action === "tournament") body = { tournament: quad };
  else if (p.action === "start") {
    quad = { key: "alley-cat-quad/2026-10-10", name: "Alley Cat Quad", format: p.format, plannedRounds: 3, status: "running", coin: "white", players, rounds: [] };
    body = { ok: true, message: "Added 4 player(s)." };
  } else if (p.action === "round") {
    quad.rounds = [{ games: JSON.parse(p.games).map((g) => ({ ...g, result: "" })), byes: [], out: [], posted: true }];
    body = { ok: true, message: "Round 1 is posted." };
  }
  request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
});
quadPage.on("dialog", (d) => d.accept());
await quadPage.goto(base + "/td/", { waitUntil: "networkidle0" });
await quadPage.type("#td-password", "secret");
await quadPage.click(".td-login button");
await quadPage.waitForSelector(".run-start:not([hidden])");
const quadFormat = await quadPage.$eval("#run-format", (s) => s.value);
await press(quadPage, ".run-start button[type=submit]");
await quadPage.waitForSelector(".run-round:not([hidden]) .run-pair");
await quadPage.select('.run-this-round[data-id="11111111"]', "absent");
await press(quadPage, ".run-pair");
await quadPage.waitForSelector(".run-pairings:not([hidden])");
await press(quadPage, ".run-post");
await quadPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const quadRound = JSON.parse((quadCalls.find((c) => c.action === "round") || {}).games || "[]");
quadFormat === "quad" && JSON.stringify(quadRound.map((g) => [g.white, g.black])) === JSON.stringify([["22222222", "33333333"], ["44444444", "11111111"]])
  ? pass("TD desk pairs a quad's first round from the table (1 v 4, 2 v 3)") : fail(`TD desk quad: format ${quadFormat}, ${JSON.stringify(quadRound)}`);
JSON.stringify(quadRound.map((g) => g.result)) === JSON.stringify(["", "1F-0F"])
  ? pass("a quad player not marked present loses that round's game by forfeit") : fail(`TD desk quad forfeits: ${JSON.stringify(quadRound)}`);
await quadPage.close();

// New tournament on the TD desk: the dialog creates an event that isn't on the calendar, which the desk then
// chooses, ready to start in the format given.
const createCalls = [];
const created = [];
const createPage = await mocked("/td/ creating a tournament", (p) => {
  createCalls.push(p);
  if (p.action === "createEvent") {
    created.push({ key: "friday-blitz-quad/2026-10-16", name: p.name, label: "Friday, October 16, 2026", kind: "entry",
      first: "2026-10-16", format: p.format, closed: true });
    return { ok: true, key: created[0].key, message: `${p.name} is on the desk.` };
  }
  return { login: { ok: true, changes: null }, people: { players: [] }, contacts: { headings: [], contacts: [] },
    choices: { choices: [{ key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry", first: "2026-11-07" },
      ...created] },
    entries: { entries: [] }, incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true };
});
await signIn(createPage);
await createPage.waitForSelector(".td-new-event");
for (const viewport of [{ width: 1100, height: 800 }, PHONE]) {
  await createPage.setViewport(viewport);
  await createPage.click(".td-new-event");
  await createPage.waitForSelector("dialog.td-create[open]");
  await axeBoth(createPage, `TD desk New tournament at ${viewport.width}px`);
  if (viewport === PHONE) await fitsPhone(createPage, "TD desk New tournament");
  await createPage.click('dialog.td-create [value="cancel"]');
}
await createPage.setViewport({ width: 1100, height: 800 });
await createPage.click(".td-new-event");
await createPage.type("#td-create-name", "Friday Blitz Quad");
await createPage.select("#td-create-format", "arena");
await createPage.click('dialog.td-create [value="create"]');
await createPage.waitForFunction(() => !document.querySelector("dialog.td-create").open);
await createPage.waitForSelector(".run-start:not([hidden])");
const createAsked = createCalls.find((c) => c.action === "createEvent") || {};
const afterCreate = await createPage.evaluate(() => ({ chosen: document.getElementById("td-event").value,
  format: document.getElementById("run-format").value, set: document.querySelector(".run-format-set").textContent,
  status: document.querySelector(".td-register-status").textContent }));
createAsked.name === "Friday Blitz Quad" && createAsked.format === "arena" && createAsked.fee === ""
  && afterCreate.chosen === "friday-blitz-quad/2026-10-16" && afterCreate.format === "arena" && afterCreate.set.includes("Arena")
  && afterCreate.status === "Friday Blitz Quad is on the desk."
  ? pass("TD desk New tournament creates the event, chooses it, and offers to start it in its format")
  : fail(`TD desk New tournament: ${JSON.stringify({ createAsked, afterCreate })}`);
await createPage.close();

// An arena: the Pairings page shows its games in progress, the queue, and recent results; the
// Standings page, its leaderboard.
const arenaData = () => {
  const players = [["a", "Ann", 1900], ["b", "Ben", 1700], ["c", "Cal", 1500], ["d", "Dee", null]].map(([id, name, rating], i) => ({ id, number: i + 1, name, rating }));
  return { tournaments: [{ name: "Knightmare Arena Classical, Saturday, October 31, 2026", format: "arena", cutoff: "17:30", status: "running",
    players, rounds: [], queue: [{ id: "b", since: "2026-10-31 10:52:10" }, { id: "a", since: "2026-10-31 10:52:10" }],
    games: [{ game: 1, white: "a", black: "b", whitePact: true, blackPact: false, result: "1-0" },
      { game: 2, white: "c", black: "d", whitePact: false, blackPact: true, result: "" }] }] };
};
const arenaPairings = await mocked("/pairings/ with an arena", arenaData);
await arenaPairings.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const shownArena = await arenaPairings.evaluate(() => ({
  headings: [...document.querySelectorAll(".pairings-all h3")].map((h) => h.textContent),
  text: document.querySelector(".pairings-all").textContent,
  standings: Boolean(document.querySelector('.pairings-all a[href="/standings/"]')),
  tables: [...document.querySelectorAll(".pairings-all table")].map((t) => [...t.tBodies[0].rows].map((r) => [...r.cells].map((c) => c.textContent))) }));
JSON.stringify(shownArena.headings) === JSON.stringify(["Games in progress", "Recent results"])
  && shownArena.text.includes("No new games start after 5:30 PM.") && shownArena.text.includes("Waiting for a game: Ben (1700), Ann (1900).")
  && shownArena.tables[0][0][2] === "Dee (unrated), Blood Pact" && shownArena.tables[1][0][3] === "1–0" && shownArena.standings
  ? pass("Pairings page shows an arena's games, queue, and results, and links to its leaderboard") : fail(`Pairings page arena: ${JSON.stringify(shownArena)}`);
await axeBoth(arenaPairings, "Pairings page with an arena");
await arenaPairings.close();
const arenaStandings = await mocked("/standings/ with an arena", arenaData);
await arenaStandings.goto(base + "/standings/", { waitUntil: "networkidle0" });
const leaderboard = await arenaStandings.$$eval(".standings-all tbody tr", (rows) => rows.map((r) => [...r.cells].map((c) => c.textContent)));
JSON.stringify(leaderboard[0]) === JSON.stringify(["1", "Ann", "1900", "3", "1", "1"]) && leaderboard.length === 4
  ? pass("Standings page shows an arena's leaderboard") : fail(`Standings page arena: ${JSON.stringify(leaderboard)}`);
await axeBoth(arenaStandings, "Standings page with an arena");
await arenaStandings.close();

// With LIVE_DB set, Pairings and Standings follow the database's public copy of the tournaments, each a JSON
// string of what ?tournaments=current gives for it, and redraw as it changes, keeping the reader's place.
// Each connection gets the events in liveEvents, then closes, and EventSource reconnects for the next.
const NODE = "classic:2026-11-07";
const liveRound = (games) => ({ games: games.map(([white, black, result], i) => ({ board: i + 1, white, black, result, section: "" })),
  byes: [], out: [], posted: true });
const liveClassic = (...rounds) => ({ key: "classic/2026-11-07", name: "Classic, Saturday, November 7, 2026", format: "swiss",
  plannedRounds: 3, status: "running", sections: [], players: fourPlayers(), rounds });
const roundOne = liveRound([["11111111", "33333333", "1-0"], ["44444444", "22222222", ""]]);
let liveEvents = [["put", { path: "/", data: { [NODE]: JSON.stringify(liveClassic(roundOne)) } }]];
const liveFetches = [];
let releaseReport;
const followed = (label, viewport) => mocked(label, (p) => {
  liveFetches.push(p);
  if (p.action === "report") return new Promise((resolve) => { releaseReport = () => resolve({ ok: true, message: "Board 2: 0–1 is reported. The TD will confirm it." }); });
  return { tournaments: [] };
}, viewport, (path) => (path === "/public/tournaments" ? liveEvents : null));
const livePairings = await followed("/pairings/ following the live database");
await livePairings.evaluateOnNewDocument(() => {
  localStorage.setItem("lccc-register-players", JSON.stringify([{ id: "22222222", last: "Ben", email: "ben@example.com", name: "Ben" }]));
});
await livePairings.goto(base + "/pairings/", { waitUntil: "domcontentloaded" });
await livePairings.waitForSelector(".report");
await livePairings.evaluate(() => { window.notReloaded = true; });
await livePairings.$eval("#report-id", (i) => { i.value = ""; });
await livePairings.type("#report-id", "3333");
const roundTwo = liveRound([["22222222", "11111111", ""], ["33333333", "44444444", ""]]);
liveEvents = [["put", { path: "/", data: { [NODE]: JSON.stringify(liveClassic(roundOne)) } }],
  ["patch", { path: "/", data: { [NODE]: JSON.stringify(liveClassic(roundOne, roundTwo)) } }]];
const newRound = await livePairings.waitForFunction(() => document.querySelector(".pairings-all select")?.value === "2", { timeout: 3000 })
  .then(() => true, () => false);
const afterPost = await livePairings.evaluate(() => ({ reloaded: !window.notReloaded, id: document.querySelector("#report-id").value,
  focused: document.activeElement?.id, rows: [...document.querySelectorAll(".pairings-all tbody tr")].map((r) => r.cells[1].textContent) }));
newRound && !afterPost.reloaded && afterPost.id === "3333" && afterPost.focused === "report-id" && afterPost.rows[0] === "Ben (1700)"
  && !liveFetches.some((p) => p.tournaments)
  ? pass("Pairings page shows a newly posted round from the live database without a reload, keeping a US Chess ID half typed")
  : fail(`Pairings page following the database: ${JSON.stringify({ newRound, afterPost, liveFetches })}`);
// A report on its way when a result comes in stays on its way.
await press(livePairings, ".report button:nth-child(2)");
await livePairings.waitForFunction(() => document.querySelector(".report [role=status]")?.textContent === "Sending…");
const roundTwoBoard2 = liveRound([["22222222", "11111111", ""], ["33333333", "44444444", "1-0"]]);
liveEvents = [["put", { path: "/", data: { [NODE]: JSON.stringify(liveClassic(roundOne, roundTwo)) } }],
  ["put", { path: `/${NODE}`, data: JSON.stringify(liveClassic(roundOne, roundTwoBoard2)) }]];
const resultShown = await livePairings.waitForFunction(() => document.querySelectorAll(".pairings-all tbody tr")[1]?.cells[3].textContent === "1–0",
  { timeout: 3000 }).then(() => true, () => false);
const whileSending = await livePairings.evaluate(() => ({ status: document.querySelector(".report [role=status]")?.textContent,
  disabled: [...document.querySelectorAll(".report button")].map((b) => b.disabled) }));
releaseReport?.();
await livePairings.waitForFunction(() => document.querySelector(".report [role=status]")?.textContent.includes("reported"));
const sent = await livePairings.evaluate(() => ({ pressed: document.querySelector('.report [aria-pressed="true"]')?.textContent,
  focused: document.activeElement?.textContent }));
resultShown && whileSending.status === "Sending…" && whileSending.disabled.join() === "true,true,true"
  && sent.pressed === "0–1, Ann won" && sent.focused === "0–1, Ann won"
  ? pass("Pairings page keeps a report on its way when a result comes in from the live database")
  : fail(`Pairings page result while reporting: ${JSON.stringify({ resultShown, whileSending, sent })}`);
// A reader who picked an earlier round stays on it when the next is posted.
await livePairings.select(".pairings-all select", "1");
await livePairings.focus(".pairings-all select");
const roundThree = liveRound([["11111111", "44444444", ""], ["22222222", "33333333", ""]]);
liveEvents = [["put", { path: "/", data: { [NODE]: JSON.stringify(liveClassic(roundOne, roundTwoBoard2, roundThree)) } }]];
const thirdPosted = await livePairings.waitForFunction(() => document.querySelectorAll(".pairings-all select option").length === 3, { timeout: 3000 })
  .then(() => true, () => false);
const stayed = await livePairings.evaluate(() => ({ round: document.querySelector(".pairings-all select").value,
  focused: document.activeElement?.tagName }));
thirdPosted && stayed.round === "1" && stayed.focused === "SELECT"
  ? pass("Pairings page keeps the round a reader picked, and the focus, when the next round is posted")
  : fail(`Pairings page picked round: ${JSON.stringify({ thirdPosted, stayed })}`);
await livePairings.setViewport(PHONE);
await fitsPhone(livePairings, "Pairings page following the live database");
await axeBoth(livePairings, "Pairings page following the live database");
await livePairings.close();

liveEvents = [["put", { path: "/", data: { [NODE]: JSON.stringify(liveClassic(liveRound([["11111111", "33333333", ""], ["44444444", "22222222", ""]]))) } }]];
const liveStandings = await followed("/standings/ following the live database");
await liveStandings.goto(base + "/standings/", { waitUntil: "domcontentloaded" });
await liveStandings.waitForFunction(() => document.querySelector(".standings-all p")?.textContent.startsWith("Standings appear here"));
liveEvents = [["put", { path: "/", data: { [NODE]: JSON.stringify(liveClassic(roundOne)) } }]];
const standingsUpdated = await liveStandings.waitForFunction(() => document.querySelector(".standings-all tbody tr")?.cells[1].textContent === "Ann",
  { timeout: 3000 }).then(() => true, () => false);
standingsUpdated ? pass("Standings page updates from the live database when a result comes in")
  : fail(`Standings page following the database: ${await liveStandings.$eval(".standings-all", (s) => s.textContent.slice(0, 200))}`);
await liveStandings.close();

const fallback = await mocked("/pairings/ without the live database", (p) => (p.tournaments === "current" ? { tournaments: twoSections() } : {}),
  null, () => null);
await fallback.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const fellBack = await fallback.$$eval(".pairings-all h3", (hs) => hs.map((h) => h.textContent));
JSON.stringify(fellBack) === JSON.stringify(["Open", "Under 1400"])
  ? pass("Pairings page loads the tournaments from the script when the live database refuses the stream")
  : fail(`Pairings page fallback: ${JSON.stringify(fellBack)}`);
await fallback.close();

// With every round in, the desk has no Finish button: it offers the rating report files for MUIR and keeps
// them in a folder the TD picks (a stand-in here for the browser's folder picker), rewritten when a result
// changes and deleted when one is missing, when rounds are added, or on a restart. A rated tournament
// offers nothing to change.
const played = (pairs) => ({ games: pairs.map(([white, black, result], i) => ({ board: i + 1, white, black, result, section: "" })),
  byes: [], out: [], posted: true, postedAt: "2026-11-07 15:05" });
const doneDesk = deskState([played([["11111111", "33333333", "1-0"], ["44444444", "22222222", "0-1"]]),
  played([["22222222", "11111111", "1/2-1/2"], ["33333333", "44444444", "1-0"]]),
  played([["11111111", "44444444", "1-0"], ["22222222", "33333333", "0-1"]])]);
const keptRounds = JSON.parse(JSON.stringify(doneDesk.held.rounds));
const deskAnswer = doneDesk.answer;
doneDesk.answer = (p) => {
  if (p.action === "rounds") {
    doneDesk.held.plannedRounds = Number(p.rounds);
    return { ok: true, message: `It plays ${p.rounds} rounds.` };
  }
  if (p.action === "restart") {
    doneDesk.held = null;
    return { ok: true, message: "Deleted. Start it again when ready." };
  }
  return deskAnswer(p);
};
const donePage = await mocked("/td/ after the last round", (p) => doneDesk.answer(p));
await donePage.evaluateOnNewDocument(() => {
  window.keptFiles = {};
  const folder = { name: "Rating report", queryPermission: async () => "granted", requestPermission: async () => "granted",
    getFileHandle: async (name) => ({ createWritable: async () => {
      let bytes = null;
      return { write: async (b) => { bytes = Array.from(b); }, close: async () => { window.keptFiles[name] = bytes; } };
    } }),
    removeEntry: async (name) => {
      if (!(name in window.keptFiles)) throw new DOMException("No such file", "NotFoundError");
      delete window.keptFiles[name];
    } };
  window.showDirectoryPicker = async () => folder;
});
// What the TD types when Restart asks for the tournament's name.
let typedName = "";
donePage.on("dialog", (dialog) => dialog.accept(dialog.type() === "prompt" ? typedName : undefined));
await signIn(donePage);
await donePage.waitForFunction(() => document.querySelectorAll(".run-report-download").length === 3);
const kept = () => donePage.evaluate(() => Object.keys(window.keptFiles).sort().join(","));
const keptPlayers = () => donePage.evaluate(() => JSON.stringify(window.keptFiles["TDEXPORT.DBF"]));
const reload = async () => {
  await press(donePage, ".run-report-download");
  await new Promise((r) => setTimeout(r, 500));
};
const afterPlay = await donePage.evaluate(() => ({ status: document.querySelector(".run-status").textContent,
  td: document.getElementById("run-report-td").selectedOptions[0]?.textContent,
  finish: Boolean(document.querySelector(".run-finish, .run-arena-finish")), round: document.querySelector(".run-round").hidden }));
await press(donePage, ".run-report-folder");
await donePage.waitForFunction(() => Object.keys(window.keptFiles).length === 3);
const first = await keptPlayers();
const records = await donePage.evaluate(() => new DataView(new Uint8Array(window.keptFiles["TDEXPORT.DBF"]).buffer).getUint32(4, true));
const told = await donePage.$eval(".run-report-folder-status", (p) => p.textContent);
await axeBoth(donePage, "TD desk with the rating report");
doneDesk.held.rounds[2].games[0].result = "0-1";
await reload();
const rewritten = (await kept()) === "TDEXPORT.DBF,THEXPORT.DBF,TSEXPORT.DBF" && (await keptPlayers()) !== first;
doneDesk.held.rounds[2].games[1].result = "";
await reload();
const goneWhenMissing = (await kept()) === "" && await donePage.$eval(".run-report", (d) => d.hidden);
doneDesk.held.rounds = JSON.parse(JSON.stringify(keptRounds));
typedName = "Slow";
await press(donePage, ".run-restart");
const wrongName = { status: await donePage.$eval(".run-status", (p) => p.textContent), held: Boolean(doneDesk.held) };
wrongName.held && wrongName.status === "That isn't Classic, so nothing was restarted."
  ? pass("TD desk won't restart a tournament unless its name is typed") : fail(`TD desk restart with the wrong name: ${JSON.stringify(wrongName)}`);
typedName = " classic ";
await press(donePage, ".run-restart");
await donePage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Deleted"));
await donePage.waitForFunction(() => Object.keys(window.keptFiles).length === 0);
// Restarted and played again, then a round added: the files go until the new round is in.
doneDesk.held = { key: "classic/2026-11-07", name: "Classic", format: "swiss", plannedRounds: 3, status: "running", coin: "white",
  players: fourPlayers(), rounds: JSON.parse(JSON.stringify(keptRounds)), timeControl: "G/70;d10" };
await donePage.evaluate(() => document.dispatchEvent(new Event("td-choice")));
await donePage.waitForFunction(() => Object.keys(window.keptFiles).length === 3);
await donePage.$eval("#run-planned-rounds", (input) => { input.value = "4"; });
await press(donePage, ".run-planned button");
await donePage.waitForFunction(() => Object.keys(window.keptFiles).length === 0 && document.querySelector(".run-report").hidden);
const roundAdded = doneDesk.held.plannedRounds === 4;
await donePage.close();
doneDesk.held.plannedRounds = 3;
doneDesk.held.status = "rated";
const ratedPage = await mocked("/td/ once rated", (p) => doneDesk.answer(p));
await signIn(ratedPage);
await ratedPage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Rated by US Chess"));
const afterRating = await ratedPage.evaluate(() => ({ round: document.querySelector(".run-round").hidden,
  standings: !document.querySelector(".run-standings-wrap").hidden, manage: document.querySelector(".run-manage").hidden }));
afterPlay.status.includes("The rating report is below") && afterPlay.td === "Jared Hall (31847334)" && !afterPlay.finish && afterPlay.round
  && records === 4 && told.includes("up to date in the folder Rating report") && rewritten && goneWhenMissing && roundAdded
  && afterRating.round && afterRating.standings && afterRating.manage
  ? pass("TD desk has no Finish: after the last round it keeps the rating report files in a folder, rewritten when a result changes "
    + "and deleted when one is missing, rounds are added, or it restarts; a rated tournament can't change")
  : fail(`TD desk after the last round: ${JSON.stringify({ afterPlay, records, told, rewritten, goneWhenMissing, roundAdded, afterRating })}`);
await ratedPage.close();

// An extra games section (28M4) once the Open is over: the TD adds it with everyone, and round 4 checks in, pairs,
// and posts only it; it has its own standings and its own section in the rating report, with the players again.
const inOpen = (pairs) => ({ ...played(pairs), games: played(pairs).games.map((g) => ({ ...g, section: "Open" })) });
const extraDesk = deskState([inOpen([["11111111", "33333333", "1-0"], ["44444444", "22222222", "0-1"]]),
  inOpen([["22222222", "11111111", "1/2-1/2"], ["33333333", "44444444", "1-0"]]),
  inOpen([["11111111", "44444444", "1-0"], ["22222222", "33333333", "0-1"]])]);
extraDesk.held.sections = [{ name: "Open" }];
extraDesk.held.players.forEach((p) => { p.section = "Open"; });
const extraAnswer = extraDesk.answer;
extraDesk.answer = (p) => {
  const held = extraDesk.held;
  if (p.action === "extraSection") {
    const first = held.rounds.length + 1;
    held.sections = [...held.sections.map((s) => ({ ...s, last: s.last || held.plannedRounds })),
      { name: p.name, extra: true, first, last: first + Number(p.rounds) - 1, players: JSON.parse(p.players) }];
    held.plannedRounds = first + Number(p.rounds) - 1;
    return { ok: true, message: `${p.name}: added.` };
  }
  if (p.action === "result") {
    held.rounds[Number(p.number) - 1].games.find((g) => g.board === Number(p.board) && g.section === p.section).result = p.result;
    return { ok: true };
  }
  return extraAnswer(p);
};
const extraPage = await mocked("/td/ adding an extra games section", (p) => extraDesk.answer(p));
await signIn(extraPage);
await extraPage.waitForFunction(() => !document.querySelector(".run-report").hidden);
await extraPage.$eval(".run-extra-wrap summary", (s) => s.click());
const extraForm = await extraPage.evaluate(() => ({ name: document.getElementById("run-extra-name").value,
  rounds: document.getElementById("run-extra-rounds").value,
  players: [...document.querySelectorAll(".run-extra-players input")].map((b) => b.checked) }));
await press(extraPage, ".run-extra button[type=submit]");
await extraPage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 4: check in");
const extraCheckin = await extraPage.evaluate(() => ({ headings: [...document.querySelectorAll(".run-attendance-all h4")].map((h) => h.textContent),
  rows: document.querySelectorAll(".run-attendance tbody tr").length, report: document.querySelector(".run-report").hidden,
  list: document.querySelector(".run-extra-list").textContent, planned: [...document.querySelectorAll("#run-planned-section option")].map((o) => o.value),
  rounds: document.getElementById("run-planned-rounds").value }));
await press(extraPage, ".run-pair");
await extraPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("pairings to review"));
await press(extraPage, ".run-post");
await extraPage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 4: results");
const extraPosted = extraDesk.held.rounds[3].games.map((g) => g.section);
for (const label of ["Extra games board 1 result", "Extra games board 2 result"]) {
  await extraPage.select(`select[aria-label="${label}"]`, "1-0");
  await new Promise((r) => setTimeout(r, 200));
}
await extraPage.waitForFunction(() => !document.querySelector(".run-report").hidden);
const extraDone = await extraPage.evaluate(async () => {
  const files = await reportFiles(current);
  const records = (name) => new DataView(files[name].buffer).getUint32(4, true);
  return { standings: [...document.querySelectorAll(".run-standings-all h4")].map((h) => h.textContent),
    openScores: [...document.querySelectorAll(".run-standings")[0].querySelectorAll("tbody tr")].map((r) => r.cells[3].textContent),
    sections: records("TSEXPORT.DBF"), players: records("TDEXPORT.DBF") };
});
// Each section's time control: blitz can't go in the files, so they wait; a dual one goes in its own section.
const sectionControl = async (value) => {
  await extraPage.$eval('input[data-section="Extra games"]', (input, v) => {
    input.value = v;
    input.dispatchEvent(new Event("change"));
  }, value);
  await new Promise((r) => setTimeout(r, 300));
};
await sectionControl("G/5;+3");
const blitzShown = await extraPage.evaluate(async () => ({ problems: document.querySelector(".run-report-problems").textContent,
  fields: [...document.querySelectorAll(".run-report-sections label")].map((l) => l.textContent) }));
await sectionControl("30+30");
const dualShown = await extraPage.evaluate(async () => {
  const files = await reportFiles(current);
  const text = new TextDecoder().decode(files["TSEXPORT.DBF"]);
  return { problems: document.querySelector(".run-report-problems").textContent, dual: text.includes("Game/30;+30"), main: text.includes("Game/70;d10") };
});
await sectionControl("thirty plus thirty");
const unreadable = await extraPage.evaluate(() => ({ error: document.getElementById("run-report-control-error").textContent,
  invalid: document.querySelector('input[data-section="Extra games"]').getAttribute("aria-invalid") }));
await sectionControl("");
const controlCalls = extraDesk.calls.filter((c) => c.action === "timeControl").map((c) => [c.section, c.value]);
blitzShown.problems.startsWith("Extra games: G/5;+3 is blitz") && blitzShown.fields.join() === "Open,Extra games"
  && dualShown.problems === "" && dualShown.dual && dualShown.main
  && JSON.stringify(controlCalls) === JSON.stringify([["Extra games", "G/5;+3"], ["Extra games", "G/30;+30"], ["Extra games", ""]])
  && unreadable.invalid === "true" && unreadable.error.startsWith('Extra games: "thirty plus thirty" isn\'t a time control')
  ? pass("TD desk keeps a time control for each section, and holds back the files for one the upload can't carry")
  : fail(`TD desk section time controls: ${JSON.stringify({ blitzShown, dualShown, unreadable, controlCalls })}`);
await axeBoth(extraPage, "TD desk with an extra games section");
for (const width of [1600, 390]) {
  await extraPage.setViewport({ width, height: 900 });
  if (process.env.SHOTS) await extraPage.screenshot({ path: `${process.env.SHOTS}/extra-${width}.png`, fullPage: true });
}
await fitsPhone(extraPage, "TD desk with an extra games section");
extraForm.name === "Extra games" && extraForm.rounds === "1" && extraForm.players.length === 4 && extraForm.players.every(Boolean)
  && JSON.stringify(extraCheckin.headings) === JSON.stringify(["Extra games (4)"]) && extraCheckin.rows === 4 && extraCheckin.report
  && extraCheckin.list.startsWith("Extra games: 4 players, round 4.") && extraCheckin.planned.join() === "Open,Extra games" && extraCheckin.rounds === "3"
  && extraPosted.join() === "Extra games,Extra games" && extraDone.standings.join() === "Open,Extra games"
  && extraDone.openScores.join() === "2.5,2,1.5,0" && extraDone.sections === 2 && extraDone.players === 8
  ? pass("TD desk adds an extra games section after the last round: it pairs and scores apart, and the rating report has it as a section")
  : fail(`TD desk extra games section: ${JSON.stringify({ extraForm, extraCheckin, extraPosted, extraDone })}`);
await extraPage.close();

// The Pairings page numbers an extra games section's rounds from 1, and a report from it names the tournament's round.
const withExtra = () => {
  const [t] = twoSections();
  t.sections = [{ name: "Open", last: 2 }, { name: "Under 1400", under: 1400, last: 2 },
    { name: "Extra games", extra: true, first: 3, last: 4, players: ["a", "e"] }];
  t.plannedRounds = 4;
  t.rounds[1].games.forEach((g) => { g.result ||= "1-0"; });
  t.rounds.push({ games: [{ board: 1, white: "e", black: "a", result: "", section: "Extra games" }], byes: [], out: [], posted: true });
  return [t];
};
const extraReports = [];
const extraPairings = await mocked("/pairings/ with an extra games section", (p) => {
  if (p.action === "report") extraReports.push(p);
  return p.action === "report" ? { ok: true, message: "Reported." } : { tournaments: withExtra() };
});
await extraPairings.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const extraShown = await extraPairings.evaluate(() => [...document.querySelectorAll(".pairings-all h3")].map((h) =>
  [h.textContent, h.nextElementSibling.querySelector("select")?.selectedOptions[0].textContent]));
JSON.stringify(extraShown) === JSON.stringify([["Open", "2 of 2"], ["Under 1400", "2 of 2"], ["Extra games", "1 of 2"]])
  ? pass("Pairings page numbers an extra games section's rounds from 1") : fail(`Pairings page extra games section: ${JSON.stringify(extraShown)}`);
await extraPairings.evaluate(() => { found.add("e"); redrawAll(); });
await extraPairings.$$eval(".report button", (b) => b[0].click());
await extraPairings.waitForFunction(() => document.querySelector(".report [role=status]")?.textContent === "Reported.");
extraReports.length === 1 && extraReports[0].number === "3" && extraReports[0].section === "Extra games"
  ? pass("Pairings page reports an extra games section's game by the tournament's round")
  : fail(`Pairings page extra games report: ${JSON.stringify(extraReports)}`);
await extraPairings.close();

// Quads with an extra games section: its round checks in as a Swiss's, with byes, and it ranks as a Swiss beside the quads.
const quadPlayers = [...Array(8)].map((_, i) => ({ id: `9000002${i}`, number: i + 1, name: `Q${i + 1}`, rating: 2000 - i * 50,
  section: i < 4 ? "Quad 1" : "Quad 2", out: null }));
const quadRounds = [1, 2, 3].map((n) => {
  const games = Pairing.pairQuadRound(quadPlayers, n).games.map((g) => ({ ...g, result: "1-0",
    section: quadPlayers.find((p) => p.id === g.white).section }));
  games.forEach((g) => { if (g.section === "Quad 2") g.board -= 2; });
  return { games, byes: [], out: [], posted: true };
});
const quadDesk = deskState(quadRounds);
Object.assign(quadDesk.held, { format: "quad", players: quadPlayers,
  sections: [{ name: "Quad 1", last: 3 }, { name: "Quad 2", last: 3 },
    { name: "Extra games", extra: true, first: 4, last: 4, players: quadPlayers.slice(0, 3).map((p) => p.id) }], plannedRounds: 4 });
const quadExtra = await mocked("/td/ quads with an extra games section", (p) => quadDesk.answer(p));
await signIn(quadExtra);
await quadExtra.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 4: check in");
const quadShown = await quadExtra.evaluate(() => ({
  options: [...document.querySelector(".run-this-round").options].map((o) => o.value),
  standings: [...document.querySelectorAll(".run-standings")].map((t) => [...t.tHead.rows[0].cells].map((c) => c.textContent)
    .find((h) => !/^(Place|Name|Rating|Score|Round \d+)$/.test(h))),
  planned: [...document.querySelectorAll("#run-planned-section option")].map((o) => o.value), plannedShown: !document.querySelector(".run-planned").hidden,
  quadHead: [...document.querySelector(".run-standings").tHead.rows[0].cells].map((c) => c.textContent),
  quadTop: [...document.querySelector(".run-standings").tBodies[0].rows[0].cells].slice(0, 9).map((c) => c.textContent) }));
await axeBoth(quadExtra, "TD desk with quads and an extra games section");
for (const width of [1600, 390]) {
  await quadExtra.setViewport({ width, height: 900 });
  if (process.env.SHOTS) await quadExtra.screenshot({ path: `${process.env.SHOTS}/quad-standings-${width}.png`, fullPage: true });
}
await fitsPhone(quadExtra, "TD desk with quads and an extra games section");
// Q3 beats Q1 and Q4 and loses to Q2, and Q1 beats Q2 and Q4: tied on 2, Q3 is ahead on Sonneborn-Berger, so no head-to-head.
quadShown.quadHead.join("|") === "Place|Name|Rating|Score|Round 1|Round 2|Round 3|Sonneborn-Berger|Head-to-head|Performance|Est. rating|Withdraw"
  && quadShown.quadTop.join("|") === "1|Q3|1900|2|L3 b|W2 w|W4 w|3|"
  ? pass("TD desk quad standings show each round and head-to-head, as the Standings page does")
  : fail(`TD desk quad standings: ${JSON.stringify([quadShown.quadHead, quadShown.quadTop])}`);
JSON.stringify(quadShown.options) === JSON.stringify(["play", "absent", "zero", "withdraw"])
  && quadShown.standings.join() === "Sonneborn-Berger,Sonneborn-Berger,Median" && quadShown.planned.join() === "Extra games" && quadShown.plannedShown
  ? pass("TD desk runs quads' extra games section as a Swiss without half-point byes, and changes only its rounds")
  : fail(`TD desk quads with an extra games section: ${JSON.stringify(quadShown)}`);
await quadExtra.close();

// An entrant who came after the quads were made plays in an extra games section only: the form lists them unchosen,
// adding the section sends them, and each extra section's menu adds another player.
const lateDesk = deskState(quadRounds.map((r) => ({ ...r, games: r.games.filter((g) => g.section === "Quad 1") })));
const quadOne = quadPlayers.slice(0, 4);
Object.assign(lateDesk.held, { format: "quad", players: quadOne, sections: [{ name: "Quad 1" }] });
const cory = { id: "13802751", name: "Cory Kohler", rating: "1882", for: "Saturday", out: "" };
const lateAnswer = lateDesk.answer;
lateDesk.answer = (p) => {
  const held = lateDesk.held;
  if (p.action === "entries") return { entries: [cory, ...quadOne.map((q) => ({ id: q.id, name: q.name, rating: String(q.rating), out: "" }))] };
  if (p.action === "extraSection") {
    lateDesk.calls.push(p);
    const ids = JSON.parse(p.players);
    if (ids.includes(cory.id)) held.players.push({ id: cory.id, number: 5, name: cory.name, rating: 1882, section: p.name, out: null });
    held.sections = [{ name: "Quad 1", last: 3 }, { name: p.name, extra: true, first: 4, last: 4, players: ids }];
    held.plannedRounds = 4;
    return { ok: true, message: `${p.name}: ${ids.length} players, 1 round from round 4.` };
  }
  if (p.action === "extraPlayer") {
    lateDesk.calls.push(p);
    held.sections[1].players.push(p.id);
    return { ok: true, message: "Added." };
  }
  return lateAnswer(p);
};
const latePage = await mocked("/td/ an entrant in an extra games section only", (p) => lateDesk.answer(p));
await signIn(latePage);
await latePage.waitForFunction(() => [...document.querySelectorAll(".run-extra-players label")].some((l) => l.textContent.includes("Cory")));
await latePage.click(".run-extra-wrap summary");
const lateForm = await latePage.$$eval(".run-extra-players label", (labels) => labels.map((l) => [l.textContent.trim(), l.querySelector("input").checked]));
for (const id of ["90000021", "90000022", "90000023"]) await latePage.click(`.run-extra-players input[value="${id}"]`);
await latePage.click(`.run-extra-players input[value="${cory.id}"]`);
await press(latePage, ".run-extra button[type=submit]");
await latePage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 4: check in");
const lateSent = JSON.parse(lateDesk.calls.find((c) => c.action === "extraSection")?.players || "[]");
const lateIn = await latePage.$$eval('.run-this-round[data-id="13802751"]', (s) => s.map((x) => x.dataset.section));
await latePage.waitForSelector(".run-extra-add");
const lateMenu = await latePage.$$eval(".run-extra-add option", (o) => o.map((x) => x.value));
await latePage.select(".run-extra-add", "90000021");
await press(latePage, '.run-extra-list button[data-focus="add-Extra games"]');
await latePage.waitForFunction(() => document.querySelector(".run-status").textContent === "Added.");
const lateAdded = lateDesk.calls.find((c) => c.action === "extraPlayer") || {};
JSON.stringify(lateForm) === JSON.stringify([["Q1 (2000)", true], ["Q2 (1950)", true], ["Q3 (1900)", true], ["Q4 (1850)", true],
  ["Cory Kohler (1882), entered, not in a quad yet", false]])
  && lateSent.join() === "90000020,13802751" && lateIn.join() === "Extra games" && lateMenu.join() === "90000021,90000022,90000023"
  && lateAdded.section === "Extra games" && lateAdded.id === "90000021"
  ? pass("TD desk puts an entrant who isn't in a quad into an extra games section only, and adds a player to one")
  : fail(`TD desk entrant in an extra games section: ${JSON.stringify({ lateForm, lateSent, lateIn, lateMenu, lateAdded })}`);
await axeBoth(latePage, "TD desk adding a player to an extra games section");
await latePage.close();

// Byes by the rules on the desk: Cal lost round 1 by forfeit, so he starts round 2 as not here (28P); Fay entered
// late and has no round 1, which the TD can make a half-point bye (28K); and a full-point bye the TD gives Ann,
// who had one in round 1, keeps the round from being saved or posted (28L3).
const byeRules = deskState([{ games: [{ board: 1, white: "22222222", black: "33333333", result: "1F-0F", section: "" },
  { board: 2, white: "44444444", black: "55555555", result: "1-0", section: "" }],
byes: [{ id: "11111111", points: 1, kind: "bye", section: "" }], out: [], posted: true }]);
byeRules.held.players = sixPlayers;
const byePage = await mocked("/td/ byes by the rules", (p) => byeRules.answer(p));
await signIn(byePage);
await byePage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 2: check in");
const noShow = await byePage.evaluate(() => {
  const select = document.querySelector('.run-this-round[data-id="33333333"]');
  return { value: select.value, name: select.closest("tr").cells[1].textContent };
});
await byePage.select('.run-byes-all select[aria-label="Fay (1100), round 1"]', "half");
await byePage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Half-point bye"));
const lateBye = byeRules.calls.find((c) => c.action === "byeKind") || {};
await press(byePage, ".run-pair");
await byePage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("pairings to review"));
await byePage.select("#run-move-0", "11111111");
await byePage.select("#run-move-kind-0", "bye");
await press(byePage, ".run-tools button[data-focus='0|move']");
await press(byePage, ".run-post");
const warned = await byePage.evaluate(() => ({ items: [...document.querySelectorAll(".run-problems li")].map((li) => li.textContent),
  status: document.querySelector(".run-status").textContent }));
const postedAnyway = byeRules.calls.some((c) => c.action === "round");
noShow.value === "absent" && noShow.name.includes("28P") && lateBye.id === "66666666" && lateBye.number === "1" && lateBye.kind === "half"
  && lateBye.section === "" && warned.items.includes("Ann has had a full-point bye already, and 28L3 allows one.")
  && warned.status.startsWith("Not saved yet.") && !postedAnyway
  ? pass("TD desk starts a forfeit loser as not here (28P), lets a late entrant's missed round be a half-point bye (28K), and refuses a second full-point bye (28L3)")
  : fail(`TD desk byes by the rules: ${JSON.stringify({ noShow, lateBye, warned })}`);
await axeBoth(byePage, "TD desk refusing a full-point bye");
await byePage.close();

// The Results page pages its table 20 rows at a time; it is served here with 45 made-up rows
// in place of the real ones.
const resultsPage = await browser.newPage();
resultsPage.on("pageerror", (error) => fail(`JavaScript error on /results/: ${error.message}`));
await resultsPage.setRequestInterception(true);
resultsPage.on("request", async (request) => {
  if (new URL(request.url()).pathname !== "/results/") return request.continue();
  const rows = [...Array(45)].map((_, i) => `<tr><td>Day ${i + 1}</td><td><a href="/results/t-${i + 1}/">Tournament ${i + 1}</a></td></tr>`).join("");
  const page = (await (await fetch(base + "/results/")).text())
    .replace(/(<h2 class="visually-hidden">Tournaments<\/h2>)[\s\S]*?(<\/section>)/, `$1<table class="entries results-table"><thead><tr><th scope="col">Date</th><th scope="col">Tournament</th></tr></thead><tbody>${rows}</tbody></table><nav class="results-pages" aria-label="Pages of results" hidden></nav>$2`)
    .replace(/<script src="\.\.\/results\.js[^"]*" defer><\/script>/, "")
    .replace("</body>", '<script src="../results.js" defer></script></body>');
  request.respond({ contentType: "text/html", body: page });
});
await resultsPage.goto(base + "/results/", { waitUntil: "networkidle0" });
const resultsShown = () => resultsPage.evaluate(() => ({
  visible: [...document.querySelectorAll(".results-table tbody tr:not([hidden])")].map((r) => r.cells[1].textContent),
  where: document.querySelector(".results-pages [role=status]")?.textContent, address: location.search }));
const firstPage = await resultsShown();
await resultsPage.click(".results-pages button:last-child");
await resultsPage.click(".results-pages button:last-child");
const lastPage = await resultsShown();
firstPage.visible.length === 20 && firstPage.visible[0] === "Tournament 1" && firstPage.where === "Page 1 of 3"
  && lastPage.visible.length === 5 && lastPage.visible[0] === "Tournament 41" && lastPage.where === "Page 3 of 3" && lastPage.address === "?page=3"
  ? pass("Results page shows 20 tournaments a page, with the page in the address")
  : fail(`Results paging: ${JSON.stringify({ firstPage, lastPage })}`);
await resultsPage.evaluate(axeSource);
const resultsAxe = await resultsPage.evaluate(() => axe.run());
resultsAxe.violations.length ? fail(`Results page paged: ${resultsAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("Results page paged has no axe violations");
await resultsPage.close();

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
