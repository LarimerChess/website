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
const base = process.argv[2] || "http://127.0.0.1:8765";
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const events = JSON.parse(readFileSync(new URL("../events.json", import.meta.url), "utf8"));
const CLUB = "Larimer County Chess Club";
const seriesPages = [...new Set(events.map((e) => e.page).filter(Boolean))];
// The results pages outlive the events, so they come from the sitemap, not events.json.
const resultsPages = [...readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8")
  .matchAll(/<loc>https:\/\/larimerchess\.org(\/results\/[^<]*)<\/loc>/g)].map((m) => m[1]);
const pages = ["/", "/events/", "/scholastic/", "/minutes/", "/minutes/2026-09-24.html", "/td/", "/entries/", "/pairings/", "/standings/",
  ...seriesPages, ...resultsPages];
const failures = [];
const fail = (message) => { failures.push(message); console.log(`FAIL ${message}`); };
const pass = (message) => console.log(`ok   ${message}`);

// Wide enough for the menu to fit on one line, so the sticky menu covers nothing the checks click.
const browser = await puppeteer.launch({ executablePath: chrome, args: ["--no-sandbox"], defaultViewport: { width: 1100, height: 800 } });
const page = await browser.newPage();
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

for (const value of ["free", "free-youth", "cost-unknown"]) {
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

const rated = upcoming.filter((e) => e.organizer === "Larimer County Chess Club" && !(e.tags || []).includes("rated"));
rated.length === 0 ? pass("every club event is tagged rated")
  : fail(`club events not tagged rated: ${[...new Set(rated.map((e) => e.title))].join(", ")}`);

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

// Every club event's card, and its details at the top and bottom, offer Register.
await page.goto(base + "/events/", { waitUntil: "networkidle0" });
const invitationalIds = new Set(events.filter((e) => (e.tags || []).includes("invitational")).map((e) => e.title));
const clubCards = await page.$$(".event-club");
let clubCard = null;
for (const card of clubCards) {
  const title = await card.$eval(".event-open", (b) => b.firstChild.textContent);
  if (!invitationalIds.has(title)) { clubCard = card; break; }
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
  /^\/events\/[^/]+\/\?date=\d{4}-\d\d-\d\d#register$/.test(cardLink || "") && dialogLinks.length === 2
    && dialogLinks.every((h) => h === cardLink) && otherCards === 0
    ? pass(`club cards and their details offer Register (${cardLink})`)
    : fail(`Register links: card ${cardLink}, details ${JSON.stringify(dialogLinks)}, on other cards ${otherCards}`);
  await page.keyboard.press("Escape");
}

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
      body: source.replace(/^const ENDPOINT = ".*";$/m, 'const ENDPOINT = "https://registration.test/exec";') });
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
const registerPath = seriesPages.find((p) => clubEvents.filter((e) => e.page === p).length > 1) || seriesPages[0];
if (registerPath) {
  await registration.goto(base + registerPath, { waitUntil: "networkidle0" });
  const rows = await registration.$$eval(".entries tbody tr", (r) => r.map((x) => x.textContent));
  rows.length === 2 && rows[1].includes("Unrated") ? pass(`${registerPath} lists the entries`)
    : fail(`${registerPath} entries: ${JSON.stringify(rows)}`);
  await registration.type("#register-id", "12345678");
  await registration.type("#register-last", "Player");
  await registration.type("#register-email", "test@example.com");
  await registration.click(".register-form button[type=submit]");
  await registration.waitForFunction(() => document.querySelector(".register-status").textContent.includes("registered"));
  const sent = posted[0] || {};
  sent.event === registerPath.split("/").filter(Boolean).pop() && /^\d{4}-\d\d(-\d\d)?$/.test(sent.date)
    && sent.id === "12345678" && sent.last === "Player" && sent.email === "test@example.com" && !sent.website
    && !("uschess-id" in sent) ? pass(`${registerPath} sends the registration`) : fail(`${registerPath} sent ${JSON.stringify(sent)}`);

  // Remembered players: a second registration goes first in the list, and after a reload
  // each fills the form in one tap and can be forgotten.
  await registration.type("#register-id", "87654321");
  await registration.type("#register-last", "Kid");
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
    website: document.querySelector("#register-website").value, focus: document.activeElement.matches("#register-date, button[type=submit]") }));
  filled.id === "12345678" && filled.last === "Player" && filled.email === "test@example.com" && !filled.website && filled.focus
    && posted.length === 2 ? pass(`${registerPath} fills in a saved player without registering`) : fail(`${registerPath} filled ${JSON.stringify(filled)}`);
  for (const scheme of ["light", "dark"]) {
    await registration.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await registration.evaluate(axeSource);
    const result = await registration.evaluate(() => axe.run({ include: ["#register", "#entries"] }));
    result.violations.length ? fail(`${registerPath} form (${scheme}): ${result.violations.map((v) => v.id).join(", ")}`)
      : pass(`${registerPath} form with saved players has no axe violations (${scheme})`);
  }
  await registration.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await registration.click(".register-saved li:first-child .register-forget");
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

// The home page's register cards. Through a month's second Monday the club night card asks
// players to register for the month, then to drop in; the clock is set an hour before each case.
const clubNights = clubEvents.filter((e) => !e.tags.includes("tournament"));
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
await desk.setRequestInterception(true);
desk.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: source.replace(/^const ENDPOINT = ".*";$/m, 'const ENDPOINT = "https://registration.test/exec";') });
  } else if (url.host === "registration.test") {
    const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
    deskCalls.push(p);
    const body = p.password !== "secret" ? { error: "Wrong password.", login: true }
      : { login: { ok: true },
          choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" }] },
          search: { players: [{ id: "12345678", name: "Test Player", state: "CO", rating: "1500", expires: "2027-01-31" }] },
          register: { ok: true, message: "Test Player is registered." },
          entries: { entries: [{ name: "Test Player", id: "12345678", rating: "1500", for: "Whole month", category: "Adult", amount: "15", email: "", expires: "2027-01-31", token: "t1" }] },
          remove: { message: "Test Player is withdrawn." },
          paid: { ok: true, message: "Test Player paid $15." },
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
await desk.waitForFunction(() => document.querySelector(".td-entries-status").textContent.includes("Still owed: $15"));
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
const sentByDesk = deskCalls.find((c) => c.action === "register") || {};
sentByDesk.event === "club-night" && sentByDesk.date === "2026-10" && sentByDesk.id === "12345678"
  ? pass("TD desk finds a player and registers them") : fail(`TD desk sent ${JSON.stringify(sentByDesk)}`);
whileSaving.field === "" && whileSaving.pending === 1 && deskCalls.filter((c) => c.action === "register").length === 2
  ? pass("TD desk takes the next player while the last one saves") : fail(`TD desk while saving: ${JSON.stringify(whileSaving)}`);
await desk.click(".td-entries tbody tr td:nth-child(7) button");
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.includes("paid $15"));
deskCalls.some((c) => c.action === "paid" && c.token === "t1" && c.amount === "15") ? pass("TD desk marks a player paid")
  : fail(`TD desk paid call: ${JSON.stringify(deskCalls.filter((c) => c.action === "paid"))}`);
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

// The Entries page, against a stand-in for the Apps Script's ?entries=all.
const entriesPage = await browser.newPage();
entriesPage.on("pageerror", (error) => fail(`JavaScript error on /entries/: ${error.message}`));
await entriesPage.setRequestInterception(true);
entriesPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: source.replace(/^const ENDPOINT = ".*";$/m, 'const ENDPOINT = "https://registration.test/exec";') });
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
  months: [...document.querySelectorAll(".entries-month > h2")].map((h) => h.textContent),
  events: [...document.querySelectorAll(".entries-month > section")].map((s) => ({ title: s.querySelector("h3").textContent,
    rows: s.querySelectorAll("tbody tr").length, register: s.querySelector("a.button")?.getAttribute("href") })),
  more: document.querySelector(".events-more:not([hidden])")?.textContent || "" }));
const entriesOpened = await entriesShown();
JSON.stringify(entriesOpened.months) === JSON.stringify(["October 2026"]) && entriesOpened.events.length === 1 && entriesOpened.events[0].rows === 1
  && entriesOpened.events[0].register === "/events/club-night/?date=2026-10-12#register" && entriesOpened.more === "Show November 2026"
  ? pass("Entries page opens on the first month, with each event's players and a Register link")
  : fail(`Entries page on open: ${JSON.stringify(entriesOpened)}`);
await entriesPage.evaluate(() => scrollTo(0, document.body.scrollHeight));
await entriesPage.waitForFunction(() => document.querySelectorAll(".entries-month").length === 2);
const entriesScrolled = await entriesShown();
JSON.stringify(entriesScrolled.months) === JSON.stringify(["October 2026", "November 2026"]) && entriesScrolled.events[1].rows === 0 && !entriesScrolled.more
  ? pass("Entries page shows the next month as the reader scrolls to the end") : fail(`Entries page after scrolling: ${JSON.stringify(entriesScrolled)}`);
await entriesPage.evaluate(axeSource);
const entriesAxe = await entriesPage.evaluate(() => axe.run());
entriesAxe.violations.length ? fail(`Entries page filled: ${entriesAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("Entries page filled has no axe violations");
await entriesPage.close();

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
      body: source.replace(/^const ENDPOINT = ".*";$/m, 'const ENDPOINT = "https://registration.test/exec";') });
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
await runPage.type("#run-rounds", "3");
await press(runPage, ".run-start button[type=submit]");
await runPage.waitForSelector(".run-round:not([hidden]) .run-pair");
await runPage.waitForFunction(() => document.querySelectorAll(".run-attendance tbody tr").length === 4);
await press(runPage, ".run-pair");
await runPage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Present first"));
pass("TD desk won't pair a round before anyone is marked present");
await press(runPage, ".run-all-present");
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
      body: source.replace(/^const ENDPOINT = ".*";$/m, 'const ENDPOINT = "https://registration.test/exec";') });
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
const startFields = await arenaPage.evaluate(() => ({ cutoff: !document.querySelector("#run-cutoff").hidden,
  rounds: !document.querySelector("#run-rounds").hidden, value: document.querySelector("#run-cutoff").value }));
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

// A page whose register.js points at a stand-in for the Apps Script; answer(fields) gives each call's JSON.
async function mocked(label, answer, viewport) {
  const tab = await browser.newPage();
  tab.on("pageerror", (error) => fail(`JavaScript error on ${label}: ${error.message}`));
  if (viewport) await tab.setViewport(viewport);
  await tab.setRequestInterception(true);
  tab.on("request", async (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/register.js") {
      const source = await (await fetch(base + "/register.js")).text();
      request.respond({ contentType: "text/javascript",
        body: source.replace(/^const ENDPOINT = ".*";$/m, 'const ENDPOINT = "https://registration.test/exec";') });
    } else if (url.host === "registration.test") {
      const fields = Object.fromEntries(new URLSearchParams(request.postData() || url.search));
      request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(answer(fields)) });
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
    rows: [...menu.nextElementSibling.querySelectorAll("tbody tr")].map((r) => [...r.cells].map((c) => c.textContent)) };
}));
const now = await standingsTables();
JSON.stringify(now.map((s) => [s.name, s.after, s.options, s.rows.length])) === JSON.stringify([
  ["Open", "2", ["1", "2 (in progress)"], 4], ["Under 1400", "1", ["1"], 3]])
  && now[0].head.join("|") === "Place|Name|Rating|Score|Median|Solkoff|Cumulative|Opp. cumulative"
  && now[0].rows.slice(0, 2).every((r) => r[3] === "1.5")
  ? pass("Standings page shows each section after its latest round with results, with the 34E tiebreaks")
  : fail(`Standings page: ${JSON.stringify(now)}`);
await standingsPage.select(".standings-all select", "1");
const afterOne = await standingsTables();
afterOne[0].after === "1" && afterOne[0].rows[0][1] === "Ann" && afterOne[0].rows[0][3] === "1"
  ? pass("Standings page's menu shows the standings after an earlier round") : fail(`Standings page after round 1: ${JSON.stringify(afterOne)}`);
await axeBoth(standingsPage, "Standings page with two sections");
await standingsPage.setViewport(PHONE);
await fitsPhone(standingsPage, "Standings page with two sections");
await standingsPage.close();

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
quadHead.join("|") === "Place|Name|Rating|Score|Sonneborn-Berger|Head-to-head"
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
      coin: p.coin, sections, players, rounds: [] };
    return { ok: true, message: "Added 7 player(s)." };
  }
  if (p.action === "section") {
    sectioned.players.find((x) => x.id === p.id).section = p.section;
    return { ok: true, message: "Moved." };
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
started.sections === JSON.stringify([{ name: "Open" }, { name: "Under 1400", under: 1400 }])
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
await press(sectionDesk, ".run-all-present");
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
// The round without a game can be reclassified afterward; the change saves at once.
await sectionDesk.select('.run-byes-all select[aria-label$="round 1"]', "half");
await sectionDesk.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Half-point bye"));
const reclassified = sectionCalls.find((c) => c.action === "byeKind") || {};
reclassified.id === "66666666" && reclassified.number === "1" && reclassified.kind === "half"
  ? pass("TD desk reclassifies a full-point bye as a half-point bye afterward") : fail(`TD desk reclassify: ${JSON.stringify(reclassified)}`);
await axeBoth(sectionDesk, "TD desk entering results in two sections");
await fitsPhone(sectionDesk, "TD desk entering results in two sections");
await sectionDesk.close();

// The menu: on one line at 1100px; on a phone it wraps, without covering the page or scrolling sideways.
const layout = await browser.newPage();
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
      body: source.replace(/^const ENDPOINT = ".*";$/m, 'const ENDPOINT = "https://registration.test/exec";') });
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
await press(quadPage, ".run-all-present");
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

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
