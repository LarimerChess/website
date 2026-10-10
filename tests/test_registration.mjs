// Tests for scripts/registration.gs's running tournaments, against in-memory sheets: a spreadsheet
// from before sections (a quad mid-event), a Swiss in two sections, and quads as sections.
//   node --test tests/test_registration.mjs
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const ROOT = new URL("..", import.meta.url).pathname;
const Pairing = createRequire(import.meta.url)("../pairing.js");
// Objects from the script are of another realm, so they are compared as JSON.
const eq = (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message);

function makeSheet(rows) {
  const data = rows.map((r) => r.map(String));
  const width = () => Math.max(1, ...data.map((r) => r.length));
  const sheet = {
    data,
    getDataRange: () => ({ getDisplayValues: () => (data.length ? data.map((r) => [...r, ...Array(width() - r.length).fill("")]) : [[""]]) }),
    getRange: (row, col) => {
      const range = {
        setNumberFormat: () => range,
        setValues: (values) => {
          values.forEach((vals, i) => vals.forEach((v, j) => {
            while (data.length < row + i) data.push([]);
            const r = data[row + i - 1];
            while (r.length < col + j) r.push("");
            r[col + j - 1] = String(v);
          }));
          return range;
        },
        setValue: (v) => range.setValues([[v]]),
      };
      return range;
    },
    setFrozenRows: () => {},
    getLastRow: () => data.length,
    getMaxRows: () => data.length + 100,
    insertRowAfter: () => {},
    deleteRow: (n) => data.splice(n - 1, 1),
  };
  return sheet;
}

function load(tabs) {
  const sheets = Object.fromEntries(Object.entries(tabs).map(([name, rows]) => [name, makeSheet(rows)]));
  const book = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet([])) };
  const context = {
    console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => "sheet" }) },
    SpreadsheetApp: { openById: () => book, getActiveSpreadsheet: () => book },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {}, removeAll() {} }) },
    Utilities: { formatDate: () => "2026-10-10 10:00", getUuid: () => "uuid" },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(`${ROOT}scripts/registration.gs`, "utf8"), context);
  return { gs: context, sheets };
}

const heading = (sheet) => sheet.data[0];
const rowsOf = (sheet) => sheet.data.slice(1).map((r) => Object.fromEntries(heading(sheet).map((h, i) => [h, r[i] || ""])));

test("a quad started before sections, with none of their columns, runs as before", () => {
  const key = "alley-cat-quad/2026-10-10";
  const players = [...Array(8)].map((_, i) => [key, String(i + 1), `9000000${i + 1}`, `P${i + 1}`, String(2000 - i * 100), ""]);
  const round1 = Pairing.pairQuadRound(players.map((p) => ({ id: p[2], number: Number(p[1]) })), 1).games
    .map((g) => [key, "1", String(g.board), g.white, g.black, "1-0", "", "2026-10-10 10:05"]);
  const { gs, sheets } = load({
    Tournaments: [["Key", "Event", "Name", "Format", "Rounds", "Status", "Started", "Coin", "Finished"],
      [key, "alley-cat-quad", "Alley Cat Quad", "quad", "3", "running", "2026-10-10 10:00", "white", ""]],
    Players: [["Key", "No.", "US Chess ID", "Name", "Rating", "Out from round"], ...players],
    Rounds: [["Key", "Round", "Board", "White", "Black", "Result", "Bye points", "Posted"], ...round1],
  });
  const t = gs.tournament(key, true);
  eq(t.sections, []);
  assert.ok(t.players.every((p) => p.section === ""));
  assert.equal(t.rounds[0].games.length, 4);
  // The new desk pairs round 2 as the old one did: boards 1 to 4 through both quads, no section.
  const parts = Pairing.pairSections({ ...t, rounds: t.rounds });
  const games = parts.flatMap((s) => s.games.map((g) => ({ ...g, section: s.section })));
  eq(games.map((g) => g.board), [1, 2, 3, 4]);
  eq(games, Pairing.pairQuadRound(t.players, 2).games.map((g) => ({ ...g, section: "" })));
  assert.equal(gs.saveRound({ event: "alley-cat-quad", date: "2026-10-10", number: "2", post: "yes", games: JSON.stringify(games), byes: "[]" }).ok, true);
  // The old desk sends no section; the new one sends "".
  assert.equal(gs.saveResult({ event: "alley-cat-quad", date: "2026-10-10", number: "2", board: "3", result: "0-1" }).ok, true);
  assert.equal(gs.saveResult({ event: "alley-cat-quad", date: "2026-10-10", number: "2", board: "4", section: "", result: "1-0" }).ok, true);
  const r2 = rowsOf(sheets.Rounds).filter((r) => r.Round === "2");
  eq(r2.map((r) => [r.Board, r.Result, r.Section]), [["1", "", ""], ["2", "", ""], ["3", "0-1", ""], ["4", "1-0", ""]]);
  eq(heading(sheets.Players), ["Key", "No.", "US Chess ID", "Name", "Rating", "Out from round", "Section"]);
  eq(heading(sheets.Tournaments).slice(-2), ["Cutoff", "Sections"]);
  // Its rows are where they were; only headings were added.
  assert.equal(rowsOf(sheets.Players)[4]["No."], "5");
  eq(gs.sectionsByKey(), {});
});

test("a Swiss in two sections: placed by rating, moved up, paired, posted, and scored by section", () => {
  const { gs, sheets } = load({ Tournaments: [], Players: [], Rounds: [] });
  gs.clubEvents = () => ({ "classic/2026-11-07": { event: "classic", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry" } });
  const entrants = [["11111111", "Ann", "1900"], ["22222222", "Ben", "1700"], ["33333333", "Cal", "1450"], ["44444444", "Dee", "1300"],
    ["55555555", "Eve", "1200P"], ["66666666", "Fay", ""]].map(([id, name, rating]) => ({ id, name, rating, out: "" }));
  let registered = entrants.slice(0, 5);
  gs.entries = () => registered;
  const p = { event: "classic", date: "2026-11-07" };
  assert.match(gs.startTournament({ ...p, format: "swiss", rounds: "3", coin: "white", sections: '[{"name":"Open"},{"name":"Open"}]' }).error, /Two sections/);
  assert.match(gs.startTournament({ ...p, format: "swiss", rounds: "3", coin: "white", sections: '[{"name":"Open"},{"name":"U1400","under":"14x"}]' }).error, /rating limit/);
  const started = gs.startTournament({ ...p, format: "swiss", rounds: "3", coin: "white", sections: '[{"name":"Open"},{"name":"Under 1400","under":1400}]' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const sectionOf = () => Object.fromEntries(rowsOf(sheets.Players).map((r) => [r.Name, r.Section]));
  eq(sectionOf(), { Ann: "Open", Ben: "Open", Cal: "Open", Dee: "Under 1400", Eve: "Under 1400" });
  registered = entrants;
  gs.syncPlayers("classic/2026-11-07");
  assert.equal(sectionOf().Fay, "Under 1400", "an unrated late entrant goes to the lowest section");
  assert.match(gs.setSection({ ...p, id: "33333333", section: "Under 1400" }).error, /play up, not down/);
  assert.equal(gs.setSection({ ...p, id: "55555555", section: "Open" }).ok, true);
  const t = gs.tournament("classic/2026-11-07", true);
  eq(t.sections, [{ name: "Open" }, { name: "Under 1400", under: 1400 }]);
  const parts = Pairing.pairSections(t, { coin: t.coin });
  const games = parts.flatMap((s) => s.games.map((g) => ({ ...g, section: s.section })));
  const byes = parts.flatMap((s) => s.byes.map((b) => ({ ...b, section: s.section })));
  // Saved, not posted: a section change deletes it, to be paired again.
  gs.saveRound({ ...p, number: "1", post: "no", games: JSON.stringify(games), byes: JSON.stringify(byes) });
  assert.equal(gs.setSection({ ...p, id: "55555555", section: "Under 1400" }).ok, true);
  assert.equal(rowsOf(sheets.Rounds).length, 0);
  gs.setSection({ ...p, id: "55555555", section: "Open" });
  gs.saveRound({ ...p, number: "1", post: "yes", games: JSON.stringify(games), byes: JSON.stringify(byes) });
  assert.match(gs.setSection({ ...p, id: "55555555", section: "Under 1400" }).error, /posted/);
  assert.match(gs.setSections({ ...p, sections: '[{"name":"Open"}]' }).error, /posted/);
  const rows = rowsOf(sheets.Rounds);
  eq(rows.filter((r) => r.Black).map((r) => [r.Section, r.Board]), [["Open", "1"], ["Open", "2"], ["Under 1400", "1"]]);
  eq(rows.filter((r) => !r.Black).length, 0);
  // Board 1 is in both sections; the result goes to the one named.
  assert.equal(gs.saveResult({ ...p, number: "1", board: "1", section: "Under 1400", result: "0-1" }).ok, true);
  eq(rowsOf(sheets.Rounds).filter((r) => r.Black).map((r) => r.Result), ["", "", "0-1"]);
  const back = gs.tournament("classic/2026-11-07", false);
  eq(back.rounds[0].games.map((g) => [g.section, g.board]), [["Open", 1], ["Under 1400", 1], ["Open", 2]]);
  eq(back.rounds[0].games.filter((g) => g.section === "Open").flatMap((g) => [g.white, g.black]).sort(), ["11111111", "22222222", "33333333", "55555555"]);
  assert.equal(gs.sectionsByKey()["classic/2026-11-07"]["44444444"], "Under 1400");
});

test("quads are sections Quad 1 and Quad 2, still numbered 1 to 8 across them", () => {
  const { gs, sheets } = load({ Tournaments: [], Players: [], Rounds: [] });
  gs.clubEvents = () => ({ "quad/2026-11-14": { event: "quad", name: "Quad", label: "Saturday", kind: "entry" } });
  gs.entries = () => [...Array(8)].map((_, i) => ({ id: `9000001${i}`, name: `Q${i}`, rating: String(2000 - i * 50), out: "" }));
  gs.startTournament({ event: "quad", date: "2026-11-14", format: "quad" });
  const players = rowsOf(sheets.Players);
  eq(players.map((r) => r.Section), ["Quad 1", "Quad 1", "Quad 1", "Quad 1", "Quad 2", "Quad 2", "Quad 2", "Quad 2"]);
  eq(players.slice(4).map((r) => Number(r["No."])).sort(), [5, 6, 7, 8]);
  assert.equal(rowsOf(sheets.Tournaments)[0].Sections, '[{"name":"Quad 1"},{"name":"Quad 2"}]');
  const t = gs.tournament("quad/2026-11-14", true);
  // The old desk's pairing, from numbers across the quads, still works on these rows.
  assert.equal(Pairing.pairQuadRound(t.players, 1).games.length, 4);
  eq(Pairing.pairSections(t).map((s) => [s.section, s.games.map((g) => g.board)]), [["Quad 1", [1, 2]], ["Quad 2", [1, 2]]]);
});

test("a player's contact is found by first and last name, a nickname, or not at all when unclear", () => {
  const { gs } = load({ Contacts: [
    ["Name", "Email", "Phone", "Status"],
    ["Steven Garverick", "steven@example.com", "650-555-0100", "Core member"],
    ["Anthony (Tony) Whitt", "tony@example.com", "970-555-0101", "Core member"],
    ["Sam Lee", "sam1@example.com", "", "Player"],
    ["Sam Lee", "sam2@example.com", "", "Player"],
  ] });
  assert.equal(gs.contactFor("Steven Garverick").email, "steven@example.com");
  assert.equal(gs.contactFor("STEVEN GARVERICK".toLowerCase()).phone, "650-555-0100");
  assert.equal(gs.contactFor("Tony Whitt").email, "tony@example.com");
  assert.equal(gs.contactFor("Anthony Whitt").email, "tony@example.com");
  assert.equal(gs.contactFor("Sam Lee"), null, "two contacts share the name");
  assert.equal(gs.contactFor("Steven Smith"), null);
});
