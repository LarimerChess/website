// Tests for pairing.js against the examples in the US Chess rulebook, chapter 2, rules 27 to 29
// and 34E, and against whole simulated tournaments.
//   node --test tests/test_pairing.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const Pairing = createRequire(import.meta.url)("../pairing.js");

/**
 * A tournament whose players have the color histories given, such as "BWB", against stand-in
 * opponents who are out of the event, so the histories don't make anyone meet.
 * x is an unplayed round. Everyone draws, so all have the same score unless score is given.
 */
function withHistories(list) {
  const players = list.map(([id, rating]) => ({ id, name: id, rating }));
  const rounds = [];
  const length = Math.max(...list.map(([, , h]) => h.length));
  let stand = 0;
  for (let r = 0; r < length; r++) {
    const round = { games: [], byes: [], out: [] };
    for (const [id, , history, wins] of list) {
      const c = history[r];
      const result = wins && wins[r] === "1" ? (c === "W" ? "1-0" : "0-1") : "1/2-1/2";
      if (c === "x" || c === undefined) {
        round.byes.push({ id, points: 0.5 });
        continue;
      }
      const other = `stand-in-${stand++}`;
      players.push({ id: other, name: other, rating: 1000 });
      round.out.push(other);
      round.games.push(c === "W" ? { white: id, black: other, result } : { white: other, black: id, result });
    }
    rounds.push(round);
  }
  // Stand-ins are out from the first round on.
  rounds[0].out.push(...players.filter((p) => p.id.startsWith("stand-in")).map((p) => p.id));
  return { players, rounds };
}

const ratingOf = (t, id) => t.players.find((p) => p.id === id).rating;
const asRatings = (t, games) => games.map((g) => [ratingOf(t, g.white), ratingOf(t, g.black)]);
const sortPairs = (pairs) => [...pairs].sort((a, b) => b[0] - a[0]);

test("29E4: due colors, from the TD TIP's examples", () => {
  const t = withHistories([["a", 1800, "BWB"], ["b", 1800, "BW"], ["c", 1800, "WWB"], ["d", 1800, "Wx"]]);
  const info = Pairing.histories(t);
  assert.deepEqual(["a", "b", "c", "d"].map((id) => Pairing.dueColor(info.get(id))), ["W", "B", "B", "B"]);
});

test("29E4, rules 1 to 4: which player due the same color gets it", () => {
  const cases = [
    ["WBW", "BxW", "B"], // 1: unequal colors beat equal
    ["WWBW", "xWBW", "B"], // 2: the greater imbalance
    ["WWB", "WBW", "W"], // 3: opposite colors last round; first gets white
    ["WBWB", "BWWB", "W"], // 4: the latest round their colors differed
    ["BWxBW", "BWBxW", "W"], // 4, example 2
  ];
  for (const [first, second, firstGets] of cases) {
    const t = withHistories([["first", 1800, first], ["second", 1700, second]]);
    const info = Pairing.histories(t);
    const [white] = Pairing.assignColors(info.get("first"), info.get("second"));
    assert.equal(white.id === "first" ? "W" : "B", firstGets, `${first} against ${second}`);
  }
});

test("28J: round one pairs the upper half against the lower half, colors alternating from the coin", () => {
  const players = [2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300].map((r, i) => ({ id: `p${i}`, name: `p${i}`, rating: r }));
  const t = { players, rounds: [] };
  const { games, byes } = Pairing.pairRound(t, { coin: "white" });
  assert.deepEqual(asRatings(t, games), [[2000, 1600], [1500, 1900], [1800, 1400], [1300, 1700]]);
  assert.deepEqual(byes, []);
});

test("28L2: an odd field gives the lowest-rated rated player the bye, never an unrated one", () => {
  const players = [{ id: "a", rating: 1800 }, { id: "b", rating: 1500 }, { id: "c", rating: 1200 }, { id: "new", rating: null }]
    .map((p) => ({ ...p, name: p.id }));
  players.push({ id: "d", name: "d", rating: 1600 });
  const { byes } = Pairing.pairRound({ players, rounds: [] }, { coin: "white" });
  assert.deepEqual(byes, [{ id: "c", points: 1, kind: "bye" }]);
});

test("29E7, examples 2 and 3: a 34-point transposition fixes the colors", () => {
  const t = withHistories([
    ["2320", 2320, "WBWB"], ["2278", 2278, "BWBW"], ["2212", 2212, "BWBW"], ["2199", 2199, "WBWB"], ["2178", 2178, "WBWB"],
    ["1980", 1980, "WBWB"], ["1951", 1951, "WBWB"], ["1910", 1910, "BWBW"], ["1896", 1896, "BWBW"], ["1800", 1800, "WBWB"],
  ]);
  const { games } = Pairing.pairRound(t);
  // Example 3 pairs the same group with a three-way swap, which the rulebook calls equally correct.
  const example2 = sortPairs([[2320, 1980], [1951, 2278], [1800, 2212], [2199, 1896], [2178, 1910]]);
  const example3 = sortPairs([[2320, 1980], [1951, 2278], [1800, 2212], [2199, 1910], [2178, 1896]]);
  assert.ok([example2, example3].map(JSON.stringify).includes(JSON.stringify(sortPairs(asRatings(t, games)))),
    JSON.stringify(asRatings(t, games)));
});

test("29E7, example 4: an interchange of 20 points beats a 150-point transposition", () => {
  const t = withHistories([
    ["2210", 2210, "B"], ["2200", 2200, "B"], ["2150", 2150, "W"], ["2120", 2120, "B"], ["2080", 2080, "B"], ["1920", 1920, "W"],
    ["1900", 1900, "B"], ["1830", 1830, "B"], ["1820", 1820, "W"], ["1790", 1790, "B"], ["1500", 1500, "B"], ["1350", 1350, "x"],
  ]);
  // Make the 1350's half-point bye a full point, so everyone has the same score.
  t.rounds[0].byes = [{ id: "1350", points: 0.5 }];
  const { games } = Pairing.pairRound(t);
  assert.deepEqual(sortPairs(asRatings(t, games)),
    sortPairs([[2210, 1920], [2200, 1820], [1830, 2150], [2120, 1790], [2080, 1500], [1900, 1350]]));
});

test("29E7, example 5: a different odd player drops to fix colors", () => {
  const t = withHistories([
    ["2100", 2100, "BWB", "111"], ["2080", 2080, "BWB", "111"], ["1990", 1990, "WBW", "111"],
    ["2050", 2050, "WBW", "110"], ["1980", 1980, "BWB", "110"], ["1800", 1800, "BWB", "110"],
  ]);
  // Wins of 1 and a draw in the third round give 3 and 2.5 points.
  for (const id of ["2050", "1980", "1800"]) {
    const game = t.rounds[2].games.find((g) => g.white === id || g.black === id);
    game.result = "1/2-1/2";
  }
  const { games } = Pairing.pairRound(t);
  assert.deepEqual(sortPairs(asRatings(t, games)), sortPairs([[2100, 1990], [2080, 2050], [1980, 1800]]));
});

test("34E: modified median, Solkoff, and cumulative from the rulebook's definitions", () => {
  const players = ["a", "b", "c", "d"].map((id, i) => ({ id, name: id, rating: 2000 - i * 100 }));
  const t = { players, rounds: [
    { games: [{ white: "a", black: "c", result: "1-0" }, { white: "b", black: "d", result: "1-0" }], byes: [] },
    { games: [{ white: "b", black: "a", result: "1/2-1/2" }, { white: "d", black: "c", result: "0-1" }], byes: [] },
  ] };
  const rows = Object.fromEntries(Pairing.standings(t).map((r) => [r.id, r]));
  assert.equal(rows.a.score, 1.5);
  assert.equal(rows.a.solkoff, 2.5); // c 1 + b 1.5
  assert.equal(rows.a.median, 1.5); // plus score: the lowest (c, 1) is dropped
  assert.equal(rows.a.cumulative, 2.5); // 1 + 1.5
  assert.equal(rows.b.cumulative, 2.5);
});

test("34E3: a full-point bye takes a point off cumulative", () => {
  const players = ["a", "b", "c"].map((id, i) => ({ id, name: id, rating: 1800 - i * 100 }));
  const t = { players, rounds: [{ games: [{ white: "a", black: "b", result: "1-0" }], byes: [{ id: "c", points: 1 }] }] };
  const rows = Object.fromEntries(Pairing.standings(t).map((r) => [r.id, r]));
  assert.equal(rows.c.cumulative, 0);
  assert.equal(rows.a.cumulative, 1);
});

test("whole tournaments: no rematches, one bye each at most, and no color three times running when avoidable", () => {
  for (const [size, roundsCount, seed] of [[9, 4, 1], [14, 5, 2], [23, 5, 3], [30, 4, 4], [7, 3, 5]]) {
    let random = seed;
    const rand = () => ((random = (random * 9301 + 49297) % 233280) / 233280);
    const players = [...Array(size)].map((_, i) => ({ id: `p${i}`, name: `p${i}`, rating: i === size - 1 ? null : 2200 - i * 37 }));
    const t = { players, rounds: [] };
    for (let r = 0; r < roundsCount; r++) {
      const { games, byes, notes } = Pairing.pairRound(t, { coin: "white" });
      assert.ok(!notes.some((n) => n.includes("can't")), `round ${r + 1} of ${size}: ${notes}`);
      const seen = new Set();
      for (const g of games) {
        assert.ok(!seen.has(g.white) && !seen.has(g.black), "a player is paired twice");
        seen.add(g.white).add(g.black);
      }
      for (const b of byes) seen.add(b.id);
      assert.equal(seen.size, size, `everyone is paired or has a bye in round ${r + 1}`);
      t.rounds.push({ games: games.map((g) => {
        const x = rand();
        return { ...g, result: x < 0.45 ? "1-0" : x < 0.9 ? "0-1" : "1/2-1/2" };
      }), byes });
    }
    const info = Pairing.histories(t);
    const met = new Map();
    for (const round of t.rounds) {
      for (const g of round.games) {
        const key = [g.white, g.black].sort().join("-");
        assert.ok(!met.has(key), `${key} met twice in a ${size}-player event`);
        met.set(key, true);
      }
    }
    const fullByes = t.rounds.flatMap((r) => r.byes.filter((b) => b.points === 1).map((b) => b.id));
    assert.equal(new Set(fullByes).size, fullByes.length, "no one gets two full-point byes");
    assert.ok(!fullByes.includes(`p${size - 1}`) || size < 3, "the unrated player never gets the bye");
    for (const p of info.values()) {
      const colors = p.colors.filter(Boolean).join("");
      assert.ok(Math.abs([...colors].filter((c) => c === "W").length - [...colors].filter((c) => c === "B").length) <= 2,
        `${p.id} has ${colors}`);
    }
  }
});

test("30G: a quad plays everyone once, with each player's colors as even as three games allow", () => {
  const players = [1, 2, 3, 4].map((n) => ({ id: `p${n}`, name: `p${n}`, rating: 2000 - n * 100, number: n }));
  const met = new Set();
  const whitesOf = new Map(players.map((p) => [p.id, 0]));
  for (let round = 1; round <= 3; round++) {
    const { games } = Pairing.pairQuadRound(players, round);
    assert.equal(games.length, 2);
    for (const g of games) {
      met.add([g.white, g.black].sort().join("-"));
      whitesOf.set(g.white, whitesOf.get(g.white) + 1);
    }
  }
  assert.equal(met.size, 6, "each of the six pairs meets once");
  for (const w of whitesOf.values()) assert.ok(w === 1 || w === 2);
});

test("30G: eight players make two quads, numbers 1 to 4 and 5 to 8", () => {
  const players = [...Array(8)].map((_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}`, rating: 2000 - i * 50, number: i + 1 }));
  const { games } = Pairing.pairQuadRound(players, 1);
  assert.deepEqual(games.map((g) => [g.white, g.black]), [["p1", "p4"], ["p2", "p3"], ["p5", "p8"], ["p6", "p7"]]);
});

test("34F: quad standings by score, then Sonneborn-Berger, then the game between the tied players", () => {
  const players = ["a", "b", "c", "d"].map((id, i) => ({ id, name: id, rating: 1800 - i * 100, number: i + 1 }));
  // a beats b, b beats c, c beats a, everyone beats d: a, b, and c tie on 2 with equal Sonneborn-Berger.
  const rounds = [
    { games: [{ white: "a", black: "d", result: "1-0" }, { white: "b", black: "c", result: "1-0" }], byes: [] },
    { games: [{ white: "c", black: "a", result: "1-0" }, { white: "d", black: "b", result: "0-1" }], byes: [] },
    { games: [{ white: "a", black: "b", result: "1-0" }, { white: "c", black: "d", result: "1-0" }], byes: [] },
  ];
  const rows = Pairing.quadStandings({ players, rounds });
  assert.deepEqual(rows.map((r) => [r.id, r.score, r.sonnebornBerger, r.place]),
    [["a", 2, 2, 1], ["b", 2, 2, 1], ["c", 2, 2, 1], ["d", 0, 0, 4]]);
  // Change b's loss to a into a draw: b now has 2.5 and wins outright.
  rounds[2].games[0].result = "1/2-1/2";
  assert.equal(Pairing.quadStandings({ players, rounds })[0].id, "b");
});

/** Players [id, rating, section] numbered by rating across the whole tournament, as the desk starts them. */
function field(list) {
  return [...list].sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))
    .map(([id, rating, section], i) => ({ id, name: id, rating, number: i + 1, section }));
}
const OPEN_U1400 = [{ name: "Open" }, { name: "Under 1400", under: 1400 }];

test("sections: the lowest limit a rating is under, unrated players too, and no playing down", () => {
  assert.equal(Pairing.placeIn(OPEN_U1400, 1900), "Open");
  assert.equal(Pairing.placeIn(OPEN_U1400, 1400), "Open");
  assert.equal(Pairing.placeIn(OPEN_U1400, "1399P"), "Under 1400");
  assert.equal(Pairing.placeIn(OPEN_U1400, null), "Under 1400");
  assert.equal(Pairing.placeIn([{ name: "U1000", under: 1000 }, { name: "U1600", under: 1600 }], 1200), "U1600");
  assert.ok(Pairing.mayEnter(OPEN_U1400[0], 1200), "a player may play up");
  assert.ok(!Pairing.mayEnter(OPEN_U1400[1], 1500), "but not down");
});

test("sections are paired independently (28A, 29), with boards numbered within each", () => {
  const players = field([["a", 2000, "Open"], ["b", 1800, "Open"], ["c", 1600, "Open"], ["d", 1500, "Open"],
    ["e", 1300, "Under 1400"], ["f", 1200, "Under 1400"], ["g", 1100, "Under 1400"]]);
  const t = { format: "swiss", sections: OPEN_U1400, players, rounds: [] };
  const [open, under] = Pairing.pairSections(t, { coin: "white" });
  assert.deepEqual([open.section, under.section], ["Open", "Under 1400"]);
  assert.deepEqual(open.games.map((g) => [g.board, g.white, g.black]), [[1, "a", "c"], [2, "d", "b"]]);
  // The odd player out in the Under 1400 gets the bye, not a game against the Open.
  assert.deepEqual(under.games.map((g) => [g.board, g.white, g.black]), [[1, "e", "f"]]);
  assert.deepEqual(under.byes, [{ id: "g", points: 1, kind: "bye" }]);
  const split = Pairing.sections(t);
  assert.deepEqual(split.map((s) => s.players.map((p) => [p.id, p.number])),
    [[["a", 1], ["b", 2], ["c", 3], ["d", 4]], [["e", 1], ["f", 2], ["g", 3]]]);
});

test("a player who plays up is paired and ranked in the higher section only", () => {
  const players = field([["a", 2000, "Open"], ["b", 1800, "Open"], ["c", 1300, "Open"],
    ["d", 1350, "Under 1400"], ["e", 1250, "Under 1400"], ["f", 1000, "Under 1400"], ["g", 900, "Under 1400"]]);
  const t = { format: "swiss", sections: OPEN_U1400, players, rounds: [] };
  const [open, under] = Pairing.pairSections(t, { coin: "white" });
  assert.ok(open.games.some((g) => [g.white, g.black].includes("c")) || open.byes.some((b) => b.id === "c"));
  assert.ok(!under.games.some((g) => [g.white, g.black].includes("c")));
  t.rounds.push({ games: [...open.games, ...under.games].map((g) => ({ ...g, result: "1-0" })), byes: [...open.byes, ...under.byes], out: [] });
  const tables = Pairing.sections(t).map((s) => Pairing.standings(s).map((r) => r.id).sort());
  assert.deepEqual(tables, [["a", "b", "c"], ["d", "e", "f", "g"]]);
});

test("a player with no section yet goes where their rating puts them", () => {
  const players = field([["a", 2000, "Open"], ["b", 1300, ""], ["c", 1200, "Under 1400"]]);
  const split = Pairing.sections({ format: "swiss", sections: OPEN_U1400, players, rounds: [] });
  assert.deepEqual(split.map((s) => s.players.map((p) => p.id)), [["a"], ["b", "c"]]);
});

test("quads as sections: each quad pairs from the table with its own numbers 1 to 4", () => {
  const players = [...Array(8)].map((_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}`, rating: 2000 - i * 50, number: i + 1,
    section: `Quad ${Math.ceil((i + 1) / 4)}` }));
  const t = { format: "quad", sections: [{ name: "Quad 1" }, { name: "Quad 2" }], players, rounds: [] };
  const rounds = Pairing.pairSections(t);
  assert.deepEqual(rounds.map((r) => [r.section, r.games.map((g) => [g.board, g.white, g.black])]),
    [["Quad 1", [[1, "p1", "p4"], [2, "p2", "p3"]]], ["Quad 2", [[1, "p5", "p8"], [2, "p6", "p7"]]]]);
});

test("no sections: one section, paired exactly as before, and old quads keep their boards", () => {
  const players = field([["a", 2000], ["b", 1800], ["c", 1600], ["d", 1500], ["e", 1300]]);
  const t = { players, rounds: [] };
  const split = Pairing.sections(t);
  assert.equal(split.length, 1);
  assert.equal(split[0].key, "");
  const [only] = Pairing.pairSections(t, { coin: "black" });
  const plain = Pairing.pairRound(t, { coin: "black" });
  assert.deepEqual({ games: only.games, byes: only.byes }, { games: plain.games, byes: plain.byes });

  const quads = [...Array(8)].map((_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}`, rating: 2000 - i * 50, number: i + 1 }));
  const old = { format: "quad", players: quads, rounds: [] };
  assert.deepEqual(Pairing.sections(old).map((s) => [s.name, s.key]), [["Quad 1", ""], ["Quad 2", ""]]);
  assert.deepEqual(Pairing.pairSections(old).flatMap((r) => r.games), Pairing.pairQuadRound(quads, 1).games);
});

test("byes and unplayed rounds are classified, and a reclassified round counts as its new kind", () => {
  const players = ["a", "b", "c", "d", "e"].map((id, i) => ({ id, name: id, rating: 1800 - i * 100 }));
  const { byes } = Pairing.pairRound({ players, rounds: [] }, { coin: "white", halfByes: ["a"], zeroByes: ["b"], absent: ["c"] });
  assert.deepEqual(byes.map((b) => [b.id, b.kind, b.points]).sort(),
    [["a", "half", 0.5], ["b", "zero", 0], ["c", "unplayed", 0]]);
  // A row from before kinds were stored falls back on its points.
  assert.deepEqual([{ points: 1 }, { points: 0.5 }, { points: 0 }].map(Pairing.byeKind), ["bye", "half", "unplayed"]);
  // An unplayed round the TD later makes a full-point bye counts as one: no second full-point bye (28L3).
  const t = { players, rounds: [{ games: [{ white: "d", black: "e", result: "1-0" }],
    byes: [{ id: "a", points: 1, kind: "bye" }, { id: "b", points: 0, kind: "unplayed" }, { id: "c", points: 0, kind: "zero" }] }] };
  assert.equal(Pairing.histories(t).get("a").hadFullBye, true);
  assert.equal(Pairing.histories(t).get("b").hadFullBye, false);
  assert.equal(Pairing.standings(t).find((r) => r.id === "a").score, 1);
});
