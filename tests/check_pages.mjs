// Loads every page in Chrome against a local server and checks what HTML
// validation can't: accessibility (axe, light and dark), the event details
// dialog by keyboard, the filters, each card's Run by line and Details link, and
// the structured data on the events page and each club event's page, its
// Register form and entry list, and the home page's register cards.
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
const pages = ["/", "/events/", "/scholastic/", "/minutes/", "/minutes/2026-09-24.html", ...seriesPages];
const failures = [];
const fail = (message) => { failures.push(message); console.log(`FAIL ${message}`); };
const pass = (message) => console.log(`ok   ${message}`);

const browser = await puppeteer.launch({ executablePath: chrome, args: ["--no-sandbox"] });
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
      posted.push(Object.fromEntries(new URLSearchParams(request.postData())));
      request.respond({ headers, contentType: "application/json", body: JSON.stringify({ ok: true, message: "Test Player is registered." }) });
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
  await registration.click(".register-form button");
  await registration.waitForFunction(() => document.querySelector(".register-status").textContent.includes("registered"));
  const sent = posted[0] || {};
  sent.event === registerPath.split("/").filter(Boolean).pop() && /^\d{4}-\d\d(-\d\d)?$/.test(sent.date)
    && sent.id === "12345678" && sent.last === "Player" && sent.email === "test@example.com" && !sent.website
    ? pass(`${registerPath} sends the registration`) : fail(`${registerPath} sent ${JSON.stringify(sent)}`);
  for (const scheme of ["light", "dark"]) {
    await registration.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await registration.evaluate(axeSource);
    const result = await registration.evaluate(() => axe.run({ include: ["#register", "#entries"] }));
    result.violations.length ? fail(`${registerPath} form (${scheme}): ${result.violations.map((v) => v.id).join(", ")}`)
      : pass(`${registerPath} form has no axe violations (${scheme})`);
  }
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

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
