// Quads, New tournament, and arenas on the TD desk, and Pairings and Standings following the live database.
import { PHONE, axeBoth, base, browser, done, fail, fitsPhone, fourPlayers, mocked, offline, pass, press, signIn, twoSections } from "./common.mjs";

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

// An arena in sections: the Pairings page shows each section with who is available in it, the games in
// progress, and recent results. Ann, saved on this device, is available in both sections, challenges Ben
// in Blood Pact, halving her clock, and reports the game. The Standings page shows the leaderboards.
const arenaState = () => {
  const players = [["11111111", "Ann", 1900], ["22222222", "Ben", 1700], ["33333333", "Cal", 1500], ["44444444", "Dee", null]].map(([id, name, rating], i) => ({ id, number: i + 1, name, rating }));
  return { key: "knightmare-arena-classical/2026-10-31", name: "Knightmare Arena Classical, Saturday, October 31, 2026", format: "arena", cutoff: "17:30",
    status: "running", players, rounds: [],
    sections: [{ name: "Classical", timeControl: "G/30;+30", rated: true }, { name: "Blood Pact", timeControl: "G/15;+15 against G/30;+30", rated: false, pact: true }],
    queue: [{ id: "22222222", since: "2026-10-31 10:52:10", sections: ["Classical", "Blood Pact"] }, { id: "11111111", since: "2026-10-31 10:52:20", sections: ["Classical", "Blood Pact"] }],
    games: [{ game: 1, section: "Classical", white: "11111111", black: "44444444", whitePact: false, blackPact: false, result: "1-0" },
      { game: 2, section: "Blood Pact", white: "33333333", black: "44444444", whitePact: false, blackPact: true, result: "" }] };
};
const arenaLive = arenaState();
const arenaSent = [];
const arenaAnswer = (fields) => {
  if (fields.tournaments === "current") return { tournaments: [arenaLive] };
  arenaSent.push(fields);
  if (fields.action === "arenaChallenge") {
    arenaLive.games.push({ game: 3, section: fields.section, white: fields.id, black: fields.opponent, whitePact: fields.pact === "me", blackPact: fields.pact === "opponent", result: "" });
    return { ok: true, game: 3, message: `Game 3, ${fields.section}: Ann has white, Ben black.` };
  }
  if (fields.action === "arenaReport") {
    arenaLive.games[2].reports = { white: fields.result, black: "" };
    return { ok: true, message: "Game 3: 1–0 is reported. It counts unless the TD changes it." };
  }
  return { ok: true, message: "Done." };
};
const arenaPairings = await mocked("/pairings/ with an arena", arenaAnswer);
await arenaPairings.evaluateOnNewDocument(() => localStorage.setItem("lccc-register-players", JSON.stringify([{ id: "11111111", name: "Ann", last: "", email: "" }])));
await arenaPairings.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const shownArena = await arenaPairings.evaluate(() => ({
  headings: [...document.querySelectorAll(".pairings-all h3")].map((h) => h.textContent),
  text: document.querySelector(".pairings-all").textContent,
  lists: [...document.querySelectorAll(".arena-available")].map((l) => [...l.children].map((li) => li.textContent.trim())),
  available: [...document.querySelectorAll(".arena-available-me input")].map((i) => i.checked),
  challenge: [...document.querySelectorAll('[id^="arena-challenge-"]')].map((b) => b.id),
  standings: Boolean(document.querySelector('.pairings-all a[href="/standings/"]')),
  page: document.querySelector(".pairings-all h2 a")?.getAttribute("href"),
  tables: [...document.querySelectorAll(".pairings-all table")].map((t) => [...t.tBodies[0].rows].map((r) => [...r.cells].map((c) => c.textContent))) }));
JSON.stringify(shownArena.headings) === JSON.stringify(["Classical, G/30;+30", "Blood Pact, G/15;+15 against G/30;+30 (not US Chess rated)", "Games in progress", "Recent results"])
  && shownArena.text.includes("No new games start after 5:30 PM.")
  && JSON.stringify(shownArena.lists) === JSON.stringify([["Ben (1700) Challenge Ben (1700)", "Ann (1900)"], ["Ben (1700) Challenge Ben (1700)", "Ann (1900)"]])
  && JSON.stringify(shownArena.available) === JSON.stringify([true, true])
  && JSON.stringify(shownArena.challenge) === JSON.stringify(["arena-challenge-0-0-22222222", "arena-challenge-0-1-22222222"])
  && JSON.stringify(shownArena.tables[0]) === JSON.stringify([["2", "Blood Pact", "Cal (1500)", "Dee (unrated), Blood Pact"]])
  && JSON.stringify(shownArena.tables[1]) === JSON.stringify([["1", "Classical", "Ann (1900)", "Dee (unrated)", "1–0"]]) && shownArena.standings
  && shownArena.page === "/events/knightmare-arena-classical/"
  ? pass("Pairings page shows an arena's sections, who is available in each, its games, and results, and links to its page and leaderboard")
  : fail(`Pairings page arena: ${JSON.stringify(shownArena)}`);
await axeBoth(arenaPairings, "Pairings page with an arena");
// Ann challenges Ben in Classical, which asks nothing more, then in Blood Pact, which asks who halves their clock.
await press(arenaPairings, "#arena-challenge-0-0-22222222");
await arenaPairings.waitForSelector(".arena-challenge");
const plain = await arenaPairings.evaluate(() => ({ pact: Boolean(document.querySelector(".arena-pact")), text: document.querySelector(".arena-challenge").textContent }));
await press(arenaPairings, "#arena-challenge-0-1-22222222");
await arenaPairings.waitForSelector(".arena-pact");
await axeBoth(arenaPairings, "Pairings page with a challenge open");
const asked = await arenaPairings.evaluate(() => ({ legend: document.querySelector(".arena-pact legend").textContent,
  choices: [...document.querySelectorAll(".arena-pact label")].map((l) => l.textContent), checked: document.querySelectorAll(".arena-pact input:checked").length }));
!plain.pact && plain.text.includes("Challenge Ben (1700) in Classical, as Ann.") && asked.legend === "Who halves their clock?"
  && JSON.stringify(asked.choices) === JSON.stringify(["Me, Ann", "Ben"]) && asked.checked === 0
  ? pass("Pairings page asks who halves their clock for a Blood Pact challenge, and nothing more for another section's")
  : fail(`Pairings page challenge forms: ${JSON.stringify({ plain, asked })}`);
await press(arenaPairings, "#arena-pact-0-me");
await press(arenaPairings, "#arena-start-0");
await arenaPairings.waitForFunction(() => document.querySelector(".arena-note")?.textContent.includes("Game 3, Blood Pact"));
await arenaPairings.waitForSelector(".report[data-players='11111111 22222222']");
const challenged = arenaSent.find((c) => c.action === "arenaChallenge");
const inGame = await arenaPairings.evaluate(() => ({
  text: document.querySelector(".pairings-all").textContent,
  buttons: [...document.querySelectorAll(".report .td-buttons button")].map((b) => b.textContent),
  challenge: document.querySelectorAll('[id^="arena-challenge-"]').length }));
challenged && challenged.id === "11111111" && challenged.opponent === "22222222" && challenged.section === "Blood Pact" && challenged.pact === "me"
  && challenged.event === "knightmare-arena-classical" && challenged.date === "2026-10-31"
  && inGame.text.includes("You're in game 3.") && inGame.text.includes("Ann (1900), Blood Pact with white, Ben (1700) with black") && inGame.challenge === 0
  && JSON.stringify(inGame.buttons) === JSON.stringify(["1–0, Ann won", "0–1, Ben won", "½–½, a draw"])
  ? pass("Pairings page sends a player's Blood Pact challenge, saying who halves their clock, then shows their game with buttons to report it")
  : fail(`Pairings page arena challenge: ${JSON.stringify({ challenged, inGame })}`);
await press(arenaPairings, ".report .td-buttons button:first-child");
await arenaPairings.waitForFunction(() => document.querySelector(".pairings-all").textContent.includes("reported, awaiting the TD"));
const reportSent = arenaSent.find((c) => c.action === "arenaReport");
const afterReport = await arenaPairings.evaluate(() => ({
  pressed: document.querySelector('.report .td-buttons button[aria-pressed="true"]')?.textContent,
  results: [...document.querySelectorAll(".pairings-all table")].at(-1).tBodies[0].rows[0].cells[4].textContent,
  pending: document.querySelector(".pairings-all").textContent.includes("1 result is reported by the players and not yet confirmed by the TD.") }));
reportSent && reportSent.id === "11111111" && reportSent.game === "3" && reportSent.result === "1-0"
  && afterReport.pressed === "1–0, Ann won" && afterReport.results === "1–0, reported, awaiting the TD" && afterReport.pending
  ? pass("Pairings page sends a player's report of their arena game and shows it awaiting the TD")
  : fail(`Pairings page arena report: ${JSON.stringify({ reportSent, afterReport })}`);
await arenaPairings.setViewport(PHONE);
await fitsPhone(arenaPairings, "Pairings page with an arena");
await arenaPairings.close();
const arenaStandings = await mocked("/standings/ with an arena", arenaAnswer);
await arenaStandings.goto(base + "/standings/", { waitUntil: "networkidle0" });
const leaderboards = await arenaStandings.evaluate(() => ({
  headings: [...document.querySelectorAll(".standings-all h3, .standings-all h4")].map((h) => h.textContent),
  tables: [...document.querySelectorAll(".standings-all table")].map((t) => [...t.tBodies[0].rows].map((r) => [...r.cells].map((c) => c.textContent))),
  page: document.querySelector(".standings-all h2 a")?.getAttribute("href"),
  pending: document.querySelector(".standings-all").textContent.includes("1 result the players reported counts here until the TD confirms or corrects it.") }));
JSON.stringify(leaderboards.headings) === JSON.stringify(["Leaderboard", "By section", "Classical, G/30;+30", "Blood Pact, G/15;+15 against G/30;+30 (not US Chess rated)"])
  && JSON.stringify(leaderboards.tables[0].slice(0, 2)) === JSON.stringify([["1", "Ann", "1900", "5", "2", "2 (Possessed)"], ["2 (tied)", "Ben", "1700", "0", "1", "0"]])
  && leaderboards.tables[0].length === 4 && leaderboards.tables[1][0][3] === "2" && leaderboards.tables[2][0][3] === "3" && leaderboards.pending
  && leaderboards.page === "/events/knightmare-arena-classical/"
  ? pass("Standings page shows an arena's leaderboard, each section's, the reports that count, and a link to its page") : fail(`Standings page arena: ${JSON.stringify(leaderboards)}`);
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

await done();
