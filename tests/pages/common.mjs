// Shared by the page checks in this folder, each of which runs in its own Chrome (tests/check_pages.mjs
// runs them all at once). Each check file ends with done(), which reports whether any check failed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
export const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
export const Pairing = require("../../pairing.js");
export const base = process.argv[2] || "http://127.0.0.1:8765";
export const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
export const events = JSON.parse(readFileSync(new URL("../../events.json", import.meta.url), "utf8"));
export const CLUB = "Larimer County Chess Club";
export const seriesPages = [...new Set(events.map((e) => e.page).filter(Boolean))];
// The results pages outlive the events, so they come from the sitemap, not events.json.
const sitemap = readFileSync(new URL("../../sitemap.xml", import.meta.url), "utf8");
export const resultsPages = [...sitemap.matchAll(/<loc>https:\/\/larimerchess\.org(\/results\/[^<]*)<\/loc>/g)].map((m) => m[1]);
// So are the archived event pages, which have left events.json.
export const archivedPages = [...sitemap.matchAll(/<loc>https:\/\/larimerchess\.org(\/events\/[^<]+\/)<\/loc>/g)]
  .map((m) => m[1]).filter((path) => !seriesPages.includes(path));
export const pages = ["/", "/events/", "/scholastic/", "/minutes/", "/minutes/2026-09-24.html", "/minutes/2026-10-19.html", "/privacy/", "/td/", "/entries/", "/pairings/", "/standings/",
  ...seriesPages, ...archivedPages, ...resultsPages];
export const failures = [];
export const fail = (message) => { failures.push(message); console.log(`FAIL ${message}`); };
export const pass = (message) => console.log(`ok   ${message}`);

// Wide enough for the menu to fit on one line, so the sticky menu covers nothing the checks click.
export const browser = await puppeteer.launch({ executablePath: chrome, args: ["--no-sandbox"], defaultViewport: { width: 1100, height: 800 } });
// register.js pointed at the stand-ins: the script at registration.test, and no live database or Firebase
// sign-in, which a check that wants one points at its own stand-in.
export const offline = (source) => source.replace(/^const ENDPOINT = ".*";$/m, 'const ENDPOINT = "https://registration.test/exec";')
  .replace(/^const LIVE_DB = ".*";$/m, 'const LIVE_DB = "";')
  .replace(/^const FIREBASE = (null|\{[^}]*\});$/m, "const FIREBASE = null;");

// The live registration script, which can take longer than a navigation may, and the live database, whose
// stream never lets a page finish loading; these checks need neither.
export const outside = (request) => /(^|\.)(script\.google\.com|firebaseio\.com)$/.test(new URL(request.url()).host);

// Runs check(tab, item) on each item, four tabs at a time, with the live script and database cut off
// as for the events page.
export async function tabs(items, check) {
  const queue = [...items];
  await Promise.all([...Array(4)].map(async () => {
    const tab = await browser.newPage();
    await tab.setRequestInterception(true);
    tab.on("request", (request) => (outside(request) ? request.abort() : request.continue()));
    tab.on("pageerror", (error) => fail(`JavaScript error on ${tab.url()}: ${error.message}`));
    for (let item; (item = queue.shift()) !== undefined; ) await check(tab, item);
    await tab.close();
  }));
}

// Clicks an element in the middle of the screen, since one at the edge can be under the sticky menu.
export async function press(tab, selector) {
  await tab.$eval(selector, (el) => el.scrollIntoView({ block: "center" }));
  await tab.click(selector);
}

// The TD desk pops up why something wasn't done; returns its message once it shows, and closes it.
export async function dismissRefusal(tab) {
  await tab.waitForSelector(".td-refused[open]");
  const message = await tab.$eval(".td-refused-message", (p) => p.textContent);
  await tab.click(".td-refused button");
  await tab.waitForSelector(".td-refused:not([open])", { visible: false });
  return message;
}

export const clubEvents = events.filter((e) => e.organizer === CLUB);

// A page whose register.js points at a stand-in for the Apps Script; answer(fields) gives each call's JSON,
// or a promise of it. With stream, LIVE_DB points at a stand-in for the database too: stream(path) gives
// the events each connection to a path gets before it closes, as [event, data] pairs, or null to refuse it.
export async function mocked(label, answer, viewport, stream) {
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

export async function axeBoth(tab, label) {
  for (const scheme of ["light", "dark"]) {
    await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await tab.evaluate(axeSource);
    const result = await tab.evaluate(() => axe.run());
    result.violations.length ? fail(`${label} (${scheme}): ${result.violations.map((v) => `${v.id} at ${v.nodes[0].target}`).join(", ")}`)
      : pass(`${label} has no axe violations (${scheme})`);
  }
  await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
}

export async function fitsPhone(tab, label) {
  const { page: wide, view } = await tab.evaluate(() => ({ page: document.documentElement.scrollWidth, view: innerWidth }));
  wide <= view ? pass(`${label} fits a ${view}px screen without scrolling sideways`) : fail(`${label} is ${wide}px wide on a ${view}px screen`);
}

export const PHONE = { width: 390, height: 844 };

// A tournament in two sections for the Pairings and Standings pages: round 1 done, round 2 under way.
export const twoSections = () => {
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


export const fourPlayers = () => [["11111111", "Ann", 1900], ["22222222", "Ben", 1700], ["33333333", "Cal", 1500], ["44444444", "Dee", 1300]]
  .map(([id, name, rating], i) => ({ id, number: i + 1, name, rating, section: "", out: null }));

// A desk that keeps a Swiss of four in memory, for the checks below. rounds, if given, starts it with them.
export function deskState(rounds) {
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

export async function signIn(tab) {
  await tab.goto(base + "/td/", { waitUntil: "networkidle0" });
  await tab.type("#td-password", "secret");
  await tab.click(".td-login button");
}

export const sixPlayers = [...fourPlayers(), { id: "55555555", number: 5, name: "Eve", rating: 1200, section: "", out: null },
  { id: "66666666", number: 6, name: "Fay", rating: 1100, section: "", out: null }];

export async function done() {
  await browser.close();
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
}
