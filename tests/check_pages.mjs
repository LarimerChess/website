// Loads every page in Chrome against a local server and checks what HTML
// validation can't: accessibility (axe, light and dark), the add-to-calendar
// menu by keyboard, the filters, and the events page's structured data.
//   node tests/check_pages.mjs [base URL, default http://127.0.0.1:8765]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const base = process.argv[2] || "http://127.0.0.1:8765";
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const pages = ["/", "/events/", "/minutes/", "/minutes/2026-09-24.html"];
const failures = [];
const fail = (message) => { failures.push(message); console.log(`FAIL ${message}`); };
const pass = (message) => console.log(`ok   ${message}`);

const browser = await puppeteer.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const page = await browser.newPage();
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
const upcoming = events.filter((e) => new Date(e.end) > new Date());

const cards = await page.$$eval(".event", (c) => c.length);
cards === upcoming.length ? pass(`events page shows all ${cards} upcoming events`)
  : fail(`events page shows ${cards} cards for ${upcoming.length} upcoming events`);

const cities = [...new Set(upcoming.map((e) => e.city).filter(Boolean))].sort();
const cityButtons = await page.$$eval('[data-filter-group="city"] button', (b) => b.map((x) => x.textContent));
JSON.stringify(cityButtons) === JSON.stringify(["All cities", ...cities]) ? pass(`city filters: ${cityButtons.join(", ")}`)
  : fail(`city filters ${JSON.stringify(cityButtons)} don't match event cities ${JSON.stringify(cities)}`);

for (const kind of ["club", "youth", "senior", "all"]) {
  await page.click(`[data-filter-group="kind"] button[data-value="${kind}"]`);
  const shown = await page.$$eval(".event:not([hidden])", (c) => c.length);
  const expected = kind === "all" ? upcoming.length : upcoming.filter((e) => (e.tags || []).includes(kind)).length;
  const status = await page.$eval("#filter-status", (s) => s.textContent);
  shown === expected && status.startsWith(`Showing ${expected} `) ? pass(`filter ${kind}: ${status}`)
    : fail(`filter ${kind} shows ${shown}, expected ${expected}; announced "${status}"`);
}

for (const [value, keep] of [["weekly", true], ["not-weekly", false]]) {
  await page.click(`[data-filter-group="schedule"] button[data-value="${value}"]`);
  const shown = await page.$$eval(".event:not([hidden])", (c) => c.length);
  const expected = upcoming.filter((e) => (e.tags || []).includes("weekly") === keep).length;
  shown === expected ? pass(`schedule ${value}: ${shown} events`) : fail(`schedule ${value} shows ${shown}, expected ${expected}`);
}
await page.click('[data-filter-group="schedule"] button[data-value="all"]');

const rated = upcoming.filter((e) => e.organizer === "Larimer County Chess Club" && !(e.tags || []).includes("rated"));
rated.length === 0 ? pass("every club event is tagged rated")
  : fail(`club events not tagged rated: ${[...new Set(rated.map((e) => e.title))].join(", ")}`);

await page.focus(".event-date");
await page.keyboard.press("Enter");
const opened = await page.evaluate(() => ({
  expanded: document.querySelector(".event-date").getAttribute("aria-expanded"),
  focus: document.activeElement.textContent,
}));
opened.expanded === "true" && opened.focus.startsWith("Google Calendar") ? pass("Enter opens the add-to-calendar menu")
  : fail(`Enter on a card: ${JSON.stringify(opened)}`);
await page.keyboard.press("Escape");
const closed = await page.evaluate(() => document.activeElement.classList.contains("event-date")
  && document.querySelector(".event-date").getAttribute("aria-expanded") === "false");
closed ? pass("Escape closes the menu and returns focus") : fail("Escape didn't close the menu or return focus");

const data = (await page.$$eval('script[type="application/ld+json"]', (s) => s.map((x) => JSON.parse(x.textContent)))).flat();
const clubEvents = upcoming.filter((e) => e.organizer === "Larimer County Chess Club").length;
const incomplete = data.filter((d) => d["@type"] === "Event" && !(d.name && d.startDate && d.location?.address));
data.filter((d) => d["@type"] === "Event").length === clubEvents && incomplete.length === 0
  ? pass(`structured data for ${clubEvents} club events`)
  : fail(`structured data: ${data.length} items for ${clubEvents} club events, ${incomplete.length} incomplete`);

await page.goto(base + "/", { waitUntil: "networkidle0" });
const homeCards = await page.$$eval(".event", (c) => c.length);
homeCards > 0 && homeCards <= 6 ? pass(`home page shows ${homeCards} events`) : fail(`home page shows ${homeCards} events`);

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
