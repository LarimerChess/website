// Tests for arena.js: Knightmare-style scoring (Possessed and Blood Pact), the queue, colors,
// the cutoff, and a simulated day.
//   node --test tests/test_arena.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const Arena = createRequire(import.meta.url)("../arena.js");

const players = (...ids) => ids.map((id) => ({ id, name: id, rating: 1500 }));

/** Games from [white, black, result, whitePact, blackPact], numbered in order. */
const games = (...list) => list.map(([white, black, result, whitePact = false, blackPact = false], i) =>
  ({ game: i + 1, white, black, result, whitePact, blackPact }));

const points = (arena) => Object.fromEntries([...Arena.tally(arena).values()].map((p) => [p.id, p.points]));

test("a win is 2, a draw 1, a loss 0", () => {
  const arena = { players: players("A", "B", "C"), games: games(["A", "B", "1-0"], ["C", "A", "1/2-1/2"]), queue: [] };
  assert.deepEqual(points(arena), { A: 3, B: 0, C: 1 });
});

test("Possessed: after two wins in a row each further win is 3, until a loss or draw", () => {
  const arena = { players: players("A", "B", "C", "D"), queue: [], games: games(
    ["A", "B", "1-0"], ["C", "A", "0-1"], ["A", "D", "1-0"], ["B", "A", "0-1"],
    ["A", "C", "1/2-1/2"], ["D", "A", "0-1"], ["A", "B", "1-0"], ["C", "A", "1-0"], ["A", "D", "1-0"]) };
  // 2 + 2 + 3 + 3, draw 1, then 2 + 2 again, a loss, and 2.
  assert.equal(points(arena).A, 2 + 2 + 3 + 3 + 1 + 2 + 2 + 0 + 2);
  assert.equal(Arena.tally(arena).get("A").streak, 1);
});

test("Blood Pact: a win with the pact against a full-clock opponent earns a bonus point", () => {
  const arena = { players: players("A", "B"), queue: [], games: games(
    ["A", "B", "1-0", true, false],  // A pacted, B didn't: 2 + 1
    ["B", "A", "0-1", true, true],   // both pacted: no bonus
    ["A", "B", "1/2-1/2", true],     // a draw earns no bonus
    ["B", "A", "1-0", true, false],  // B pacted and won: 2 + 1
    ["A", "B", "0-1", true, false]) }; // A pacted and lost: nothing
  const t = Arena.tally(arena);
  assert.equal(t.get("A").points, 3 + 2 + 1);
  assert.equal(t.get("A").bonus, 1);
  assert.equal(t.get("B").points, 1 + 3 + 2);
});

test("a pact win while Possessed is 3 plus the bonus", () => {
  const arena = { players: players("A", "B", "C"), queue: [], games: games(
    ["A", "B", "1-0"], ["C", "A", "0-1"], ["A", "B", "1-0", true, false]) };
  assert.equal(points(arena).A, 2 + 2 + 3 + 1);
});

test("forfeits: a forfeit win is 2 with no run or bonus; a forfeit loss ends a run", () => {
  const arena = { players: players("A", "B", "C"), queue: [], games: games(
    ["A", "B", "1-0"], ["C", "A", "0-1"], ["A", "B", "1F-0F", true, false], ["A", "C", "1-0"],
    ["B", "C", "0F-1F"], ["C", "A", "0F-1F"]) };
  const t = Arena.tally(arena);
  // A: 2, 2, forfeit 2 (no bonus, run stays at 2), 3, forfeit 2.
  assert.equal(t.get("A").points, 2 + 2 + 2 + 3 + 2);
  assert.equal(t.get("A").games, 3);
  assert.equal(t.get("A").bonus, 0);
  assert.equal(t.get("A").streak, 3);
  assert.equal(t.get("C").points, 2);
  assert.equal(t.get("C").streak, 0);
});

test("games in progress don't count", () => {
  const arena = { players: players("A", "B"), queue: [], games: games(["A", "B", ""]) };
  assert.deepEqual(points(arena), { A: 0, B: 0 });
});

test("standings: most points first, and equal points share a place", () => {
  const arena = { players: players("A", "B", "C", "D"), queue: [], games: games(
    ["A", "B", "1-0"], ["C", "D", "1-0"], ["B", "D", "1/2-1/2"]) };
  const rows = Arena.standings(arena);
  assert.deepEqual(rows.map((r) => [r.id, r.place, r.tied]), [["A", 1, true], ["C", 1, true], ["B", 3, true], ["D", 3, true]]);
});

test("the queue pairs the longest-waiting players first", () => {
  const arena = { players: players("A", "B", "C", "D", "E"), games: [], queue: [
    { id: "C", since: "2026-10-31 10:02:00" }, { id: "A", since: "2026-10-31 10:00:00" },
    { id: "E", since: "2026-10-31 10:03:00" }, { id: "B", since: "2026-10-31 10:01:00" },
    { id: "D", since: "2026-10-31 10:02:00" }] };
  const { games: paired, waiting } = Arena.pair(arena);
  assert.deepEqual(paired.map((g) => [g.white, g.black].sort()), [["A", "B"], ["C", "D"]]);
  assert.deepEqual(waiting, ["E"]);
});

test("no immediate rematch: the next free player is skipped, and two who just played wait", () => {
  const played = games(["A", "B", "1-0"], ["C", "D", "1-0"]);
  const two = { players: players("A", "B"), games: played.slice(0, 1), queue: [
    { id: "A", since: "2026-10-31 10:40:00" }, { id: "B", since: "2026-10-31 10:40:00" }] };
  assert.deepEqual(Arena.pair(two), { games: [], waiting: ["A", "B"] });
  const three = { players: players("A", "B", "C"), games: played, queue: [
    { id: "A", since: "2026-10-31 10:40:00" }, { id: "B", since: "2026-10-31 10:40:00" }, { id: "C", since: "2026-10-31 10:45:00" }] };
  const { games: paired, waiting } = Arena.pair(three);
  assert.deepEqual(paired.map((g) => [g.white, g.black].sort()), [["A", "C"]]);
  assert.deepEqual(waiting, ["B"]);
});

test("no immediate rematch from the other side either", () => {
  // B's latest game was against A, though A has played D since, so A waits for someone else.
  const arena = { players: players("A", "B", "D"), games: games(["A", "B", "1-0"], ["D", "A", "1-0"]), queue: [
    { id: "A", since: "2026-10-31 11:00:00" }, { id: "B", since: "2026-10-31 11:00:01" }, { id: "D", since: "2026-10-31 11:00:02" }] };
  const { games: paired, waiting } = Arena.pair(arena);
  assert.deepEqual(paired.map((g) => [g.white, g.black].sort()), [["B", "D"]]);
  assert.deepEqual(waiting, ["A"]);
});

test("colors: fewer whites, then black last time, then the longer wait gets white", () => {
  const history = games(["A", "X", "1-0"], ["Y", "A", "1-0"], ["Y", "B", "1-0"], ["B", "X", "0-1"], ["C", "X", "1-0"]);
  // A and B have had one white each; A had black last.
  assert.deepEqual(Arena.assignColors(history, "B", "A"), ["A", "B"]);
  // C has had one white, D none.
  assert.deepEqual(Arena.assignColors(history, "C", "D"), ["D", "C"]);
  // Neither has played: the longer wait, listed first, has white.
  assert.deepEqual(Arena.assignColors(history, "E", "F"), ["E", "F"]);
  // Forfeits and games in progress don't count as colors played.
  const more = [...history, { game: 6, white: "D", black: "E", result: "1F-0F" }, { game: 7, white: "D", black: "F", result: "" }];
  assert.deepEqual(Arena.assignColors(more, "C", "D"), ["D", "C"]);
});

test("the cutoff: no new games from the time given, in Fort Collins", () => {
  const at = (iso) => new Date(iso);
  assert.equal(Arena.pastCutoff("2026-10-31", "17:30", at("2026-10-31T17:29:00-06:00")), false);
  assert.equal(Arena.pastCutoff("2026-10-31", "17:30", at("2026-10-31T17:30:00-06:00")), true);
  assert.equal(Arena.pastCutoff("2026-10-31", "17:30", at("2026-11-01T09:00:00-06:00")), true);
  assert.equal(Arena.pastCutoff("2026-10-31", "17:30", at("2026-10-30T18:00:00-06:00")), false);
  assert.equal(Arena.pastCutoff("2026-10-31", "", at("2026-10-31T23:00:00-06:00")), false);
  assert.equal(Arena.pastCutoff("2026-12", "21:00", at("2026-12-07T21:05:00-07:00")), true);
  assert.equal(Arena.localTime(at("2026-10-31T23:30:00Z")), "2026-10-31 17:30");
});

test("a simulated day: everyone keeps playing, nobody meets the same opponent twice in a row", () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const ids = "ABCDEFGHIJK".split("");
  const arena = { players: ids.map((id, i) => ({ id, name: id, rating: 2000 - i * 100 })), games: [], queue: [] };
  let minute = 0;
  const stamp = () => `2026-10-31 ${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00`;
  for (const id of ids.slice(0, 9)) arena.queue.push({ id, since: stamp() });
  const ends = new Map();
  while (minute < 450) {
    if (minute === 60) arena.queue.push({ id: "J", since: stamp() }, { id: "K", since: stamp() });
    // E takes a break from 2:00 to 3:00 PM.
    if (minute === 240) arena.queue = arena.queue.filter((q) => q.id !== "E");
    if (minute === 300 && !arena.games.some((g) => !g.result && (g.white === "E" || g.black === "E"))) arena.queue.push({ id: "E", since: stamp() });
    const { games: paired } = Arena.pair(arena);
    for (const g of paired) {
      const game = { game: arena.games.length + 1, ...g, whitePact: random() < 0.2, blackPact: random() < 0.2, result: "" };
      arena.games.push(game);
      arena.queue = arena.queue.filter((q) => q.id !== g.white && q.id !== g.black);
      ends.set(game.game, minute + 40 + Math.floor(random() * 50));
    }
    minute += 5;
    for (const g of arena.games.filter((x) => !x.result && ends.get(x.game) <= minute)) {
      g.result = ["1-0", "0-1", "1/2-1/2"][Math.floor(random() * 3)];
      arena.queue.push({ id: g.white, since: stamp() }, { id: g.black, since: stamp() });
    }
  }
  for (const id of ids) {
    const mine = arena.games.filter((g) => g.white === id || g.black === id);
    const opponents = mine.map((g) => (g.white === id ? g.black : g.white));
    assert.ok(mine.length >= 3, `${id} played ${mine.length} games`);
    opponents.slice(1).forEach((o, i) => assert.notEqual(o, opponents[i], `${id} met ${o} twice in a row`));
    const whites = mine.filter((g) => g.white === id).length;
    assert.ok(Math.abs(2 * whites - mine.length) <= 2, `${id} colors: ${whites} whites of ${mine.length}`);
    for (let i = 1; i < mine.length; i++) assert.ok(mine[i].game > mine[i - 1].game);
  }
  const rows = Arena.standings(arena);
  const total = rows.reduce((sum, r) => sum + r.points, 0);
  const finished = arena.games.filter((g) => g.result);
  assert.ok(total >= finished.length * 2, "each finished game adds at least 2 points");
  rows.slice(1).forEach((r, i) => assert.ok(r.points <= rows[i].points));
});
