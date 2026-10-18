// Section formats on the TD desk: starting a round robin, pairing it from its table, and changing a
// section's format, an extra games section's too.
import { PHONE, Pairing, axeBoth, done, fail, fitsPhone, mocked, pass, press, signIn } from "./common.mjs";

const calls = [];
const players = [["11111111", "Ann", 1900, "Open"], ["22222222", "Ben", 1800, "Open"], ["33333333", "Cal", 1700, "Open"],
  ["44444444", "Dee", 1600, "Open"], ["55555555", "Eve", 1500, "Open"], ["66666666", "Fay", 1300, "Reserve"], ["77777777", "Gus", 1200, "Reserve"]]
  .map(([id, name, rating, section], i) => ({ id, number: i + 1, name, rating, section, out: null }));
// Numbers by lot: Cal 1, Ann 2, Eve 3, Ben 4, Dee 5.
const order = ["33333333", "11111111", "55555555", "22222222", "44444444"];
let held = null;
const desk = await mocked("/td/ with section formats", (p) => {
  calls.push(p);
  if (p.action === "choices") return { choices: [{ key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry", first: "2026-11-07" }] };
  if (p.action === "entries") return { entries: [] };
  if (p.action === "incidents") return { incidents: [] };
  if (p.action === "tournament") return { tournament: held && JSON.parse(JSON.stringify(held)) };
  if (p.action === "start") {
    held = { key: "classic/2026-11-07", name: "Classic", format: "swiss", plannedRounds: 5, status: "running", coin: "white", players, rounds: [],
      sections: [{ name: "Open", format: "rr", order, last: 5 }, { name: "Reserve", last: 4 }], halfByes: { limit: 1, everyRound: true } };
    return { ok: true, message: "Added 7 player(s)." };
  }
  if (p.action === "round") {
    held.rounds[Number(p.number) - 1] = { games: JSON.parse(p.games), byes: JSON.parse(p.byes), out: [], posted: p.post === "yes" };
    return { ok: true, message: `Round ${p.number} is posted.` };
  }
  if (p.action === "sectionNames") {
    held.sections = JSON.parse(p.sections).map((x) => ({ ...held.sections.find((d) => d.name === x.from), name: x.name, format: x.format }));
    return { ok: true, message: "Sections saved." };
  }
  if (p.action === "extraSection") {
    held.sections.push({ name: p.name, extra: true, format: p.format, first: 2, last: 4, players: JSON.parse(p.players) });
    return { ok: true, message: "Added." };
  }
  return { ok: true };
}, PHONE);
const asked = [];
desk.on("dialog", (d) => { asked.push(d.message()); d.accept(); });
await signIn(desk);
await desk.waitForSelector(".run-start:not([hidden])");

// A round robin needs no rounds typed in: its players set them.
await desk.select(".run-start .run-section-format", "rr");
await fitsPhone(desk, "TD desk's start form with a section's format");
await axeBoth(desk, "TD desk's start form with a section's format");
await press(desk, ".run-start button[type=submit]");
await desk.waitForSelector(".run-round:not([hidden]) .run-pair");
const started = calls.find((c) => c.action === "start") || {};
started.sections === JSON.stringify([{ name: "Open", format: "rr" }])
  ? pass("TD desk starts a round robin section without a number of rounds") : fail(`TD desk round robin start: ${JSON.stringify(started)}`);

// Before round 1, the Reserve becomes a double round robin.
await press(desk, ".run-names-wrap summary");
const before = await desk.$$eval(".run-names-format", (m) => m.map((x) => [x.getAttribute("aria-label"), x.value, x.disabled]));
await desk.select('.run-names-format[aria-label="Format of Reserve"]', "drr");
await fitsPhone(desk, "TD desk changing a section's format");
await axeBoth(desk, "TD desk changing a section's format");
if (process.env.SHOTS) {
  for (const width of [390, 1600]) {
    await desk.setViewport({ width, height: 900 });
    await desk.screenshot({ path: `${process.env.SHOTS}/section-formats-${width}.png`, fullPage: true });
  }
  await desk.setViewport(PHONE);
}
await press(desk, ".run-names button[type=submit]");
await desk.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Sections saved"));
const named = calls.find((c) => c.action === "sectionNames") || {};
JSON.stringify(before) === JSON.stringify([["Format of Open", "rr", false], ["Format of Reserve", "swiss", false]])
  && named.sections === JSON.stringify([{ from: "Open", name: "Open", format: "rr" }, { from: "Reserve", name: "Reserve", format: "drr" }])
  && asked.some((m) => m.startsWith("Change the format of Reserve?"))
  ? pass("TD desk changes a section's format before it plays, after asking")
  : fail(`TD desk section formats: ${JSON.stringify({ before, named, asked })}`);

// Round 1 from the tables, by lot numbers; the odd player sits out, and a player not here loses by forfeit.
await desk.waitForSelector('.run-this-round[data-id="22222222"][data-section="Open"]');
const hint = await desk.$eval(".run-checkin-hint", (h) => h.textContent);
await desk.select('.run-this-round[data-id="22222222"][data-section="Open"]', "absent");
await press(desk, ".run-pair");
await desk.waitForSelector(".run-pairings:not([hidden])");
await press(desk, ".run-post");
await desk.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const round = calls.find((c) => c.action === "round") || {};
const games = JSON.parse(round.games || "[]").map((g) => [g.section, g.white, g.black, g.result]);
const byes = JSON.parse(round.byes || "[]").map((b) => [b.section, b.id, b.kind]);
const table = Pairing.roundRobinTable(5, "rr")[0];
const expected = [...table.filter((pair) => !pair.includes(6)).map(([w, b]) => [order[w - 1], order[b - 1]])
  .map(([w, b]) => ["Open", w, b, w === "22222222" ? "0F-1F" : b === "22222222" ? "1F-0F" : ""]), ["Reserve", "66666666", "77777777", ""]];
const sitting = order[table.find((pair) => pair.includes(6)).find((n) => n !== 6) - 1];
hint.includes("round robin's table") && JSON.stringify(games) === JSON.stringify(expected) && JSON.stringify(byes) === JSON.stringify([["Open", sitting, "unplayed"]])
  ? pass("TD desk pairs round robins from their tables by lot numbers, one sitting out, an absent player forfeiting")
  : fail(`TD desk round robin round 1: ${JSON.stringify({ hint, games, expected, byes, sitting })}`);
const after = await desk.$$eval(".run-names-format", (m) => m.map((x) => x.disabled));
JSON.stringify(after) === JSON.stringify([true, true]) ? pass("TD desk keeps a section's format once it has a posted round")
  : fail(`TD desk formats after round 1: ${JSON.stringify(after)}`);

// An extra games section can be a round robin, whose rounds field goes away.
await press(desk, ".run-extra-wrap summary");
await desk.select("#run-extra-format", "rr");
const roundsHidden = await desk.$eval("#run-extra-rounds", (i) => i.hidden);
await press(desk, ".run-extra button[type=submit]");
await desk.waitForFunction(() => document.querySelector(".run-extra-list").textContent.includes("a round robin"));
const extra = calls.find((c) => c.action === "extraSection") || {};
roundsHidden && extra.format === "rr" ? pass("TD desk adds an extra games section as a round robin")
  : fail(`TD desk extra round robin: ${JSON.stringify({ roundsHidden, extra })}`);
await desk.close();

await done();
