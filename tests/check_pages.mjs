// Loads every page in Chrome against a local server and checks what HTML
// validation can't: accessibility (axe, light and dark), the event details
// dialog by keyboard, the filters, each card's Run by line and Details link, and
// the events page's structured data.
//   node tests/check_pages.mjs [base URL, default http://127.0.0.1:8765]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const base = process.argv[2] || "http://127.0.0.1:8765";
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const pages = ["/", "/events/", "/scholastic/", "/minutes/", "/minutes/2026-09-24.html"];
const failures = [];
const fail = (message) => { failures.push(message); console.log(`FAIL ${message}`); };
const pass = (message) => console.log(`ok   ${message}`);

const browser = await puppeteer.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const page = await browser.newPage();
// Every filter group sits in a menu, which has to be opened first.
async function choose(group, value) {
  await page.click(`[popovertarget="filter-${group}"]`);
  await page.click(`[data-filter-group="${group}"] button[data-value="${value}"]`);
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
const events = JSON.parse(readFileSync(new URL("../events.json", import.meta.url), "utf8"));
const allUpcoming = events.filter((e) => new Date(e.end) > new Date());
const isYouth = (e) => (e.tags || []).includes("youth");
const upcoming = allUpcoming.filter((e) => !isYouth(e));

const cards = await page.$$eval(".event", (c) => c.length);
cards === upcoming.length ? pass(`events page shows all ${cards} upcoming events`)
  : fail(`events page shows ${cards} cards for ${upcoming.length} upcoming events`);

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
  return card.title !== e.title || card.runBy !== runBy || card.details !== (e.url || "");
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

const data = (await page.$$eval('script[type="application/ld+json"]', (s) => s.map((x) => JSON.parse(x.textContent)))).flat();
const clubEvents = upcoming.filter((e) => e.organizer === "Larimer County Chess Club").length;
const incomplete = data.filter((d) => d["@type"] === "Event" && !(d.name && d.startDate && d.location?.address));
data.filter((d) => d["@type"] === "Event").length === clubEvents && incomplete.length === 0
  ? pass(`structured data for ${clubEvents} club events`)
  : fail(`structured data: ${data.length} items for ${clubEvents} club events, ${incomplete.length} incomplete`);

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

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
