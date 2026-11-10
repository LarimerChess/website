// Sections on different rounds: extra games can start while the Open is still playing.
import { PHONE, axeBoth, dismissRefusal, done, fail, fitsPhone, mocked, pass, press, signIn } from "./common.mjs";

const calls = [];
const held = {
  key: "classic/2026-11-07", name: "Classic", format: "swiss", status: "running", coin: "white", plannedRounds: 3,
  sectionPairing: true, halfByes: { limit: 1, everyRound: true },
  sections: [{ name: "Open", last: 3 }, { name: "Reserve", under: 1400, last: 3 },
    { name: "Extra games", extra: true, format: "drr", order: ["11111111", "33333333"], first: 2, last: 3, players: ["11111111", "33333333"] }],
  players: [["11111111", "Ann", 1900, "Open"], ["22222222", "Ben", 1700, "Open"],
    ["33333333", "Cal", 1300, "Reserve"], ["44444444", "Dee", 1200, "Reserve"]]
    .map(([id, name, rating, section], i) => ({ id, name, rating, section, number: i + 1, out: null })),
  rounds: [{ posted: true, postedSections: ["Open", "Reserve"], out: [], byes: [], games: [
    { section: "Open", board: 1, white: "11111111", black: "22222222", result: "", reports: { white: "1-0", black: "1-0" } },
    { section: "Reserve", board: 1, white: "33333333", black: "44444444", result: "1-0" },
  ] }],
};
const desk = await mocked("/td/ independently pairing sections", (p) => {
  calls.push(p);
  if (p.action === "choices") return { choices: [{ key: held.key, name: "Classic", label: "Saturday, November 7, 2026", kind: "entry", first: "2026-11-07" }] };
  if (p.action === "entries") return { entries: [] };
  if (p.action === "incidents") return { incidents: [] };
  if (p.action === "tournament") return { tournament: structuredClone(held) };
  if (p.action === "sectionRound") {
    const keys = JSON.parse(p.sections);
    const i = Number(p.number) - 1;
    while (held.rounds.length <= i) held.rounds.push({ posted: false, postedSections: [], games: [], byes: [], out: [] });
    const r = held.rounds[i];
    r.games = r.games.filter((g) => !keys.includes(g.section)).concat(JSON.parse(p.games));
    r.byes = r.byes.filter((b) => !keys.includes(b.section)).concat(JSON.parse(p.byes));
    r.postedSections = r.postedSections.filter((s) => !keys.includes(s)).concat(p.post === "yes" ? keys : []);
    r.posted = Boolean(r.postedSections.length);
    return { ok: true, message: `Round ${p.number} is ${p.post === "yes" ? "posted" : "saved"}.` };
  }
  if (p.action === "results") {
    for (const x of JSON.parse(p.results)) held.rounds[Number(p.number) - 1].games.find((g) => g.section === x.section && g.board === Number(x.board)).result = x.result;
  }
  if (p.action === "result") held.rounds[Number(p.number) - 1].games.find((g) => g.section === p.section && g.board === Number(p.board)).result = p.result;
  return { ok: true };
}, PHONE);
desk.on("dialog", (d) => d.accept());
const title = (text) => desk.waitForFunction((t) => document.querySelector(".run-round-title").textContent === t, {}, text);
await signIn(desk);
await title("Round 1: results");
await desk.select("#run-section", "Extra games");
await title("Round 2: check in");
await press(desk, ".run-pair");
await press(desk, ".run-save");
await title("Round 2: pairings to review");
await desk.waitForFunction(() => document.querySelector(".run-status").textContent.includes("rounds paired"));
const saved = calls.find((p) => p.action === "sectionRound");
saved?.number === "2" && saved.post === "no" && saved.sections === '["Extra games"]'
  && held.rounds[0].games[0].result === "" && held.rounds[1].postedSections.length === 0
  ? pass("Extra games pair and save independently while Open has no result") : fail(`Independent extra games save: ${JSON.stringify(saved)}`);

await desk.select("#run-section", "Reserve");
await title("Round 2: check in");
await press(desk, ".run-by-hand");
await title("Round 2: pairings to review");
await press(desk, '.run-tools button[data-focus$="add"]');
await press(desk, ".run-post");
await title("Round 2: results");
held.rounds[1].postedSections.includes("Reserve") && !held.rounds[1].postedSections.includes("Extra games")
  && held.rounds[1].games.length === 2
  ? pass("Reserve posts a hand-paired round alongside the extra games section's private draft") : fail("Reserve changed another section's draft");

await desk.select("#run-section", "Extra games");
await title("Round 2: pairings to review");
await press(desk, ".run-repair");
await title("Round 2: check in");
await press(desk, ".run-pair");
await press(desk, ".run-post");
await title("Round 2: results");
held.rounds[1].games.length === 2 && held.rounds[1].postedSections.length === 2
  ? pass("A saved section stays private after another section posts, and re-pairing preserves the other section") : fail("Re-pairing lost the Reserve game");
await desk.select('select[aria-label="Extra games board 1 result"]', "1-0");
await title("Round 3: check in");
await press(desk, ".run-pair");
await press(desk, ".run-post");
await title("Round 3: results");
await axeBoth(desk, "TD desk pairing sections independently");
await fitsPhone(desk, "TD desk pairing sections independently");
await desk.select('select[aria-label="Extra games board 1 result"]', "1/2-1/2");
await desk.waitForSelector(".run-round[hidden]", { hidden: true });
await desk.select("#run-section", "Open");
await title("Round 1: results");
await press(desk, ".run-confirm-agreed");
await title("Round 2: check in");
const confirmed = calls.find((p) => p.action === "results");
confirmed?.number === "1" && JSON.parse(confirmed.results)[0].section === "Open"
  ? pass("Returning to a section confirms its earlier round's reports even after extra games finish") : fail(`Wrong round confirmed: ${JSON.stringify(confirmed)}`);
const reportHidden = await desk.$eval(".run-report", (el) => el.hidden);
reportHidden ? pass("The rating report waits for every section's planned rounds") : fail("Rating report offered with missing section rounds");
await desk.select("#run-section", "");
await title("Round 2: results");
const headings = await desk.$$eval(".run-games-all h4", (els) => els.map((el) => el.textContent));
JSON.stringify(headings) === '["Reserve"]' ? pass("All sections returns to the earliest round needing results")
  : fail(`All sections selected the wrong work: ${JSON.stringify(headings)}`);
held.sectionPairing = false;
await press(desk, ".run-refresh");
await desk.waitForFunction(() => current?.sectionPairing === false);
await desk.select("#run-section", "Open");
await title("Round 2: check in");
await press(desk, ".run-pair");
const saves = calls.filter((p) => ["round", "sectionRound"].includes(p.action)).length;
await press(desk, ".run-post");
const refusal = await dismissRefusal(desk);
refusal.includes("deployment") && calls.filter((p) => ["round", "sectionRound"].includes(p.action)).length === saves
  ? pass("An older server cannot replace a whole round with one selected section") : fail(`Older server save was not refused: ${refusal}`);
await desk.close();
await done();
