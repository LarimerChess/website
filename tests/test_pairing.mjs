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

test("34E: players tied on score and all four tiebreaks share a place; rating only orders the rows", () => {
  const players = ["a", "b", "c", "d"].map((id, i) => ({ id, name: id, rating: 2000 - i * 100 }));
  const t = { players, rounds: [{ games: [{ white: "a", black: "c", result: "1-0" }, { white: "b", black: "d", result: "1-0" }], byes: [] }] };
  assert.deepEqual(Pairing.standings(t).map((r) => [r.id, r.place]), [["a", 1], ["b", 1], ["c", 3], ["d", 3]]);
});

test("performance rating: Elo over rated games played, capped at 800, without forfeits, byes, or unrated opponents", () => {
  const players = [["a", 2000], ["b", 1800], ["c", 1600], ["d", null], ["e", 1500]].map(([id, rating]) => ({ id, name: id, rating }));
  const t = { players, rounds: [
    { games: [{ white: "a", black: "b", result: "1-0" }, { white: "c", black: "d", result: "1/2-1/2" }], byes: [{ id: "e", points: 1 }] },
    { games: [{ white: "b", black: "c", result: "1/2-1/2" }, { white: "a", black: "e", result: "1F-0F" }, { white: "d", black: "c", result: "" }], byes: [] },
    { games: [{ white: "c", black: "a", result: "1-0" }], byes: [] },
  ] };
  const rows = Object.fromEntries(Pairing.standings(t).map((r) => [r.id, r]));
  assert.equal(rows.a.performance, 1700); // 1 of 2 against 1800 and 1600
  assert.equal(rows.b.performance, 1609); // 0.5 of 2 against 2000 and 1600: 1800 - 400 log10(3)
  assert.equal(rows.c.performance, 2091); // 1.5 of 2 against 1800 and 2000; d is unrated
  assert.equal(rows.d.performance, 1600);
  assert.equal(rows.e.performance, null);
  const quad = Pairing.quadStandings({ players: players.slice(0, 2).map((p, i) => ({ ...p, number: i + 1 })), rounds: t.rounds.slice(0, 1) });
  assert.deepEqual(quad.map((r) => [r.id, r.performance]), [["a", 2600], ["b", 1200]]);
});

test("rating estimates match US Chess's ratings of a real section, The Garage 1 quad 2 (2026-09-26)", () => {
  // Pre-event ratings to the hundredth, as US Chess stores them; all six were established, and
  // number 3 (1810.71) has an 1800 floor.
  const players = [[1, 1670.49], [2, 1286.67], [3, 1810.71, 1800], [4, 1444.84], [5, 1692.69], [6, 1279.57]]
    .map(([id, rating, floor]) => ({ id, name: String(id), rating, games: 50, floor }));
  const rounds = [
    [[1, 4, "1/2-1/2"], [2, 5, "0-1"], [6, 3, "1-0"]],
    [[1, 2, "1-0"], [3, 5, "1/2-1/2"], [4, 6, "1-0"]],
    [[5, 1, "1/2-1/2"], [3, 4, "1-0"], [6, 2, "0-1"]],
  ].map((games) => ({ games: games.map(([white, black, result]) => ({ white, black, result })), byes: [] }));
  const official = { 1: 1666.32, 2: 1301.58, 3: 1800, 4: 1463.63, 5: 1698.88, 6: 1290.02 };
  const estimates = Pairing.ratingEstimates({ players, rounds });
  for (const [id, post] of Object.entries(official)) assert.equal(estimates.get(Number(id)), Math.round(post), `player ${id}`);
});

test("special formula: the rating whose provisional expectancy matches the score", () => {
  // Unrated (no prior games): a win over a 1400 and a loss to a 1600 is 1500.
  assert.equal(Pairing.specialRating(1300, 0, [{ rating: 1400, score: 1 }, { rating: 1600, score: 0 }], ""), 1500);
  // A lone loss leaves every rating up to 1250 equally good; the document picks the one nearest the prior rating.
  assert.equal(Pairing.specialRating(1300, 0, [{ rating: 1650, score: 0 }], ""), 1250);
  assert.equal(Pairing.specialRating(1000, 0, [{ rating: 1650, score: 0 }], ""), 1000);
  // Two prior games, both losses: they count as two losses to an 1200, the old rating plus 400, so
  // a win over another 1200 is one point in three, an expectancy of 1/3 at 1200 - 800/6.
  assert.equal(Pairing.specialRating(800, 2, [{ rating: 1200, score: 1 }], "losses"), 1066.6666666666667);
  // Unrated players get estimates; a player with no games gets none.
  const t = { players: [{ id: "a", rating: null }, { id: "b", rating: 1500, games: 30 }, { id: "c", rating: 1400, games: 4 }],
    rounds: [{ games: [{ white: "a", black: "b", result: "1-0" }], byes: [] }] };
  const e = Pairing.ratingEstimates(t);
  assert.ok(e.get("a") > 1500 && e.get("b") < 1500 && e.get("c") === null, JSON.stringify([...e]));
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
      const before = Pairing.histories(t);
      const { games, byes, notes } = Pairing.pairRound(t, { coin: "white" });
      // 28L2: the unrated player has the bye only when no rated player in the lowest score group could.
      const full = byes.find((b) => b.points === 1);
      if (full?.id === `p${size - 1}`) {
        const score = before.get(full.id).score;
        assert.ok(![...before.values()].some((p) => p.rating != null && p.score <= score && !p.hadFullBye && !p.hadForfeitWin),
          `round ${r + 1} of ${size}: the unrated player has the bye while a rated player could`);
      }
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
  const changed = Pairing.quadStandings({ players, rounds });
  assert.equal(changed[0].id, "b");
  assert.equal(changed[0].headToHead, null, "head-to-head only between tied players");
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

test("an extra rated games section (28M4) has its own players and rounds, and its games stay out of their sections", () => {
  const players = field([["a", 2000, "Open"], ["b", 1800, "Open"], ["c", 1600, "Open"], ["d", 1500, "Open"]]);
  players[0].byes = [2];
  const game = (white, black, result, section) => ({ white, black, result, section });
  const t = { format: "swiss", players,
    sections: [{ name: "Open", last: 2 }, { name: "Extra games", extra: true, first: 2, last: 3, players: ["a", "b", "c"] }],
    rounds: [{ games: [game("a", "c", "1-0", "Open"), game("d", "b", "0-1", "Open")], byes: [], out: [] }] };
  const [open, extra] = Pairing.sections(t);
  assert.deepEqual([open.first, open.last, open.rounds.length, extra.first, extra.last, extra.rounds.length], [1, 2, 1, 2, 3, 0]);
  assert.deepEqual(extra.players.map((p) => [p.id, p.number, p.byes]), [["a", 1, undefined], ["b", 2, undefined], ["c", 3, undefined]],
    "numbered within the section, without the byes asked for in the player's own");
  assert.deepEqual([2, 3].map((n) => [Pairing.playsIn(open, n), Pairing.playsIn(extra, n)]), [[true, true], [false, true]]);
  // Round 2: a takes the half-point bye asked for in the Open and still plays in the extra section.
  const [openTwo, extraTwo] = Pairing.pairSections(t, (s) => ({ halfByes: s.extra ? [] : ["a"] }));
  assert.deepEqual(openTwo.byes.find((b) => b.id === "a"), { id: "a", points: 0.5, kind: "half" });
  assert.ok(extraTwo.games.some((g) => [g.white, g.black].includes("a")));
  assert.deepEqual(extraTwo.byes.map((b) => [b.kind, b.points]), [["unplayed", 0]], "three players: one has no game, and no point (28M4)");
  t.rounds.push({ games: [game("b", "c", "1-0", "Open"), game("b", "c", "0-1", "Extra games")],
    byes: [{ id: "a", points: 0.5, kind: "half", section: "Open" }, { id: "d", points: 0, kind: "unplayed", section: "Open" },
      { id: "a", points: 1, kind: "bye", section: "Extra games" }], out: [] });
  const [openAfter, extraAfter] = Pairing.sections(t);
  assert.deepEqual(Pairing.standings(openAfter).map((r) => [r.id, r.score]), [["b", 2], ["a", 1.5], ["c", 0], ["d", 0]]);
  assert.deepEqual(Pairing.standings(extraAfter).map((r) => [r.id, r.score]), [["c", 1], ["a", 1], ["b", 0]]);
  t.rounds.push({ games: [], byes: [], out: [] });
  assert.equal(Pairing.sections(t)[0].rounds.length, 2, "the Open ends with its last round");
  assert.deepEqual(Pairing.pairSections({ ...t, rounds: t.rounds.slice(0, 2) }).map((s) => s.section), ["Extra games"]);
});

test("quads as sections: each quad pairs from the table with its own numbers 1 to 4", () => {
  const players = [...Array(8)].map((_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}`, rating: 2000 - i * 50, number: i + 1,
    section: `Quad ${Math.ceil((i + 1) / 4)}` }));
  const t = { format: "quad", sections: [{ name: "Quad 1" }, { name: "Quad 2" }], players, rounds: [] };
  const rounds = Pairing.pairSections(t);
  assert.deepEqual(rounds.map((r) => [r.section, r.games.map((g) => [g.board, g.white, g.black])]),
    [["Quad 1", [[1, "p1", "p4"], [2, "p2", "p3"]]], ["Quad 2", [[1, "p5", "p8"], [2, "p6", "p7"]]]]);
});

test("quads with an extra games section: the quads play their table, the extra section a Swiss", () => {
  const players = [...Array(8)].map((_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}`, rating: 2000 - i * 50, number: i + 1,
    section: i < 4 ? "Quad 1" : "Quad 2" }));
  const t = { format: "quad", players, rounds: [],
    sections: [{ name: "Quad 1", last: 3 }, { name: "Quad 2", last: 3 }, { name: "Extra games", extra: true, first: 1, last: 2, players: ["p1", "p5", "p6"] }] };
  const [one, two, extra] = Pairing.pairSections(t, { coin: "white" });
  assert.deepEqual([one.format, two.format, extra.format], ["quad", "quad", "swiss"]);
  assert.deepEqual(one.games.map((g) => [g.white, g.black]), [["p1", "p4"], ["p2", "p3"]], "the quad table");
  assert.deepEqual([extra.games.length, extra.byes.map((b) => b.kind)], [1, ["unplayed"]], "three players in a Swiss: one game, and one without");
});

test("a player whose section is an extra games section's name plays in it only, not placed in a quad or section by rating", () => {
  const quad = [...Array(4)].map((_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}`, rating: 2000 - i * 50, number: i + 1, section: "Quad 1" }));
  const late = { id: "late", name: "late", rating: 1882, number: 5, section: "Extra games" };
  const t = { format: "quad", players: [...quad, late], rounds: [],
    sections: [{ name: "Quad 1", last: 3 }, { name: "Extra games", extra: true, first: 1, last: 2, players: ["p1", "late"] }] };
  assert.deepEqual(Pairing.sections(t).map((s) => [s.name, s.players.map((p) => [p.id, p.number])]),
    [["Quad 1", [["p1", 1], ["p2", 2], ["p3", 3], ["p4", 4]]], ["Extra games", [["p1", 1], ["late", 2]]]]);
  assert.deepEqual(Pairing.pairSections(t).map((s) => [s.section, s.games.map((g) => [g.white, g.black].sort())]),
    [["Quad 1", [["p1", "p4"], ["p2", "p3"]]], ["Extra games", [["late", "p1"]]]]);
  // In a Swiss too, with no section's limit placing them.
  const swiss = { format: "swiss", rounds: [], players: [...field([["a", 2000, "Open"], ["b", 1800, "Open"]]), { ...late, number: 3 }],
    sections: [{ name: "Open", last: 1 }, { name: "Extra games", extra: true, first: 2, last: 3, players: ["a", "late"] }] };
  assert.deepEqual(Pairing.sections(swiss).map((s) => [s.name, s.players.map((p) => p.id)]), [["Open", ["a", "b"]], ["Extra games", ["a", "late"]]]);
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

test("28L4: a player who asked for a half-point bye in a later round gets the full-point bye only when no one else can", () => {
  const players = ["a", "b", "c", "d", "e"].map((id, i) => ({ id, name: id, rating: 1800 - i * 100 }));
  const asking = (rounds, ids = ["e"]) => players.map((p) => (ids.includes(p.id) ? { ...p, byes: rounds } : p));
  const bye = (t) => Pairing.pairRound(t, { coin: "white" }).byes;
  const later = { players: asking([3]), rounds: [] };
  assert.equal(Pairing.histories(later).get("e").committed, true);
  assert.deepEqual(bye(later), [{ id: "d", points: 1, kind: "bye" }], "e, the lowest rated, asked for round 3's");
  assert.deepEqual(Pairing.pairSections(later, { coin: "white" })[0].byes, [{ id: "d", points: 1, kind: "bye" }], "sections keep the requests");
  const everyone = { players: asking([2, 3], players.map((p) => p.id)), rounds: [] };
  assert.deepEqual(bye(everyone), [{ id: "e", points: 1, kind: "bye" }], "when everyone asked for one, the lowest rated after all");
  // The round being paired: e, here after all, isn't committed to a later one.
  const now = { players: asking([1]), rounds: [] };
  assert.equal(Pairing.histories(now).get("e").committed, false);
  assert.deepEqual(bye(now), [{ id: "e", points: 1, kind: "bye" }]);
});

test("28L2 to 28L4: the full-point bye stays in the lowest score group, rated, then unrated who have played, then new", () => {
  const bye = (players, rounds) => Pairing.pairRound({ players, rounds }, { coin: "white" }).byes.find((b) => b.points === 1)?.id;
  const player = (id, rating, extra = {}) => ({ id, name: id, rating, ...extra });
  const game = (white, black, result) => ({ white, black, result });
  const field = [player("a", 2000), player("b", 1900), player("c", 1800), player("d", 1700), player("n", null)];
  // After round 1, b, d, and the unrated n have no points: the lowest-rated rated player among them.
  assert.equal(bye(field, [{ games: [game("a", "b", "1-0"), game("c", "d", "1-0")], byes: [{ id: "n", points: 0, kind: "unplayed" }] }]), "d");
  // With everyone else on ½, n is the lowest score group alone and has the bye, not a rated player a group up.
  assert.equal(bye(field, [{ games: [game("a", "c", "1/2-1/2")], byes: [{ id: "b", points: 0.5, kind: "half" },
    { id: "d", points: 0.5, kind: "half" }, { id: "n", points: 0, kind: "unplayed" }] }]), "n");
  // d and n on 0, d having asked for a half-point bye in round 3: n, though unrated (28L4).
  const asking = field.map((p) => (p.id === "d" ? { ...p, byes: [3] } : p));
  assert.equal(bye(asking, [{ games: [game("a", "d", "1-0"), game("b", "c", "1/2-1/2")], byes: [{ id: "n", points: 0, kind: "unplayed" }] }]), "n");
  // Two unrated players on 0: the one with rated games before the event, then the new one.
  const unrated = [player("a", 2000), player("b", 1900), player("c", 1800), player("x", null, { games: 0 }), player("y", null, { games: 3 })];
  assert.equal(bye(unrated, [{ games: [game("a", "x", "1-0"), game("b", "y", "1-0")], byes: [{ id: "c", points: 1, kind: "bye" }] }]), "y");
});

test("29D2: a player who can meet nobody in the next score group drops on alone, not with that group", () => {
  const p = (id, rating) => ({ id, name: id, rating });
  const g = (white, black, result) => ({ white, black, result });
  // After round 3, B (2½) has met D and E (2), so B drops past them to C (0); D and E play each other.
  const t = { players: [p("A", 2000), p("B", 1900), p("C", 1800), p("D", 1700), p("E", 1600)], rounds: [
    { games: [g("A", "C", "1-0"), g("D", "B", "0-1")], byes: [{ id: "E", points: 1, kind: "bye" }] },
    { games: [g("A", "B", "1/2-1/2"), g("E", "C", "1-0")], byes: [{ id: "D", points: 1, kind: "bye" }] },
    { games: [g("C", "D", "0F-1F"), g("B", "E", "1-0")], byes: [{ id: "A", points: 0, kind: "unplayed" }] }] };
  const { games, byes, notes } = Pairing.pairRound(t, { coin: "white" });
  assert.deepEqual(notes.filter((n) => n.includes("can't")), []);
  assert.deepEqual(byes.map((b) => b.id), ["A"], "C can't take the bye: B could then play nobody");
  assert.deepEqual(games.map((x) => [x.white, x.black].sort().join("-")).sort(), ["B-C", "D-E"]);
});

test("30B: in a quad, a player who withdrew before playing half their games counts in no one's score", () => {
  const players = ["q1", "q2", "q3", "q4"].map((id, i) => ({ id, name: id, rating: 1800 - i * 100, number: i + 1 }));
  const g = (white, black, result) => ({ white, black, result });
  // q3 draws q2, then withdraws and forfeits to q1 and q4.
  const rounds = [{ games: [g("q1", "q4", "1/2-1/2"), g("q2", "q3", "1/2-1/2")], byes: [], out: [] },
    { games: [g("q3", "q1", "0F-1F"), g("q4", "q2", "1/2-1/2")], byes: [], out: ["q3"] },
    { games: [g("q1", "q2", "1/2-1/2"), g("q3", "q4", "0F-1F")], byes: [], out: ["q3"] }];
  const rows = Pairing.quadStandings({ players: players.map((p) => (p.id === "q3" ? { ...p, out: 2 } : p)), rounds });
  assert.deepEqual(rows.map((r) => [r.id, r.score, r.place]), [["q1", 1, 1], ["q2", 1, 1], ["q4", 1, 1], ["q3", 0.5, null]]);
});

test("byeProblems: a round's byes by the rules, half-point (22C) and full-point (28L), each with its reason", () => {
  const p = (id, rating, extra) => ({ id, name: id, rating, number: 0, section: "", ...extra });
  const g = (white, black, result = "") => ({ white, black, result });
  const swiss = (players, rounds) => Pairing.sections({ format: "swiss", players, rounds })[0];
  const page = { limit: 1, everyRound: true };
  const check = (s, number, games, byes, halfByes = page, last = 4) => Pairing.byeProblems(s, number, games, byes, last, halfByes);
  const half = (id) => ({ id, kind: "half", points: 0.5 });
  const full = (id) => ({ id, kind: "bye", points: 1 });
  // Round 1 to come: A to E, rated 2000 down to 1600.
  const five = ["A", "B", "C", "D", "E"].map((id, i) => p(id, 2000 - i * 100));
  const fresh = swiss(five, []);
  assert.deepEqual(check(fresh, 1, [g("A", "C"), g("B", "D")], [full("E")]), [], "the lowest rated (28L2)");
  assert.match(check(fresh, 1, [g("A", "C"), g("B", "E")], [full("D")])[0], /D is rated 1700; .* E \(1600\), or with 28L2a someone within 80 points/);
  assert.deepEqual(check(swiss(five.map((x) => (x.id === "D" ? { ...x, rating: 1650 } : x)), []), 1, [g("A", "C"), g("B", "E")], [full("D")]), [],
    "within 80 points, 28L2a");
  assert.match(check(fresh, 1, [g("A", "B")], [full("C"), full("D"), half("E")])[0], /^2 full-point byes: only the odd player has one \(28L1\)\.$/);
  // Unrated players come after rated ones; a new player after one who has played rated games.
  const unrated = swiss([...five.slice(0, 4), p("N", null, { games: 0 }), p("U", null, { games: 6 })].slice(1), []);
  assert.match(check(unrated, 1, [g("B", "C"), g("D", "U")], [full("N")])[0], /^N is a new player; 28L2 gives .* to a rated player/);
  // Half-point byes: up to one, with those asked for; in the last round only when asked for (22C4); and without a
  // page announcing them, only the first half's rounds (22C1).
  const asked = swiss([...five.slice(0, 4), p("E", 1600, { byes: [3] })], [{ games: [g("A", "C", "1-0"), g("B", "D", "1-0")], byes: [full("E")] }]);
  assert.deepEqual(check(asked, 3, [], [half("E")]), []);
  assert.equal(check(asked, 2, [], [half("E")])[0], "E already has or asked for a half-point bye, in round 3, and the event allows one per player.");
  assert.equal(check(asked, 4, [], [half("A")])[0], "A didn't ask for a last-round bye before round 1, so they can't have one (22C4).");
  assert.match(check(asked, 3, [], [half("E")], { limit: 1, everyRound: false })[0], /\(22C1\), and round 3 isn't one\.$/);
  assert.deepEqual(check(asked, 2, [], [half("A")], { limit: 1, everyRound: false }), [], "round 2 of 4 is in the first half");
  // After round 1, E has had the full point (28L3 forbids a second); A and B lead.
  assert.equal(check(asked, 2, [g("A", "B"), g("C", "D")], [full("E")])[0], "E has had a full-point bye already, and 28L3 allows one.");
  assert.deepEqual(check(asked, 2, [g("A", "B")], [full("C"), full("E"), half("D")]).slice(-2),
    ["2 full-point byes: only the odd player has one (28L1).", "E has had a full-point bye already, and 28L3 allows one."]);
  assert.match(check(asked, 2, [g("C", "D"), g("B", "E")], [full("A")])[0], /^A has 1; 28L2 gives the full-point bye to the lowest score group where someone can take it, 0 points\.$/);
  assert.deepEqual(check(asked, 2, [g("A", "B"), g("C", "E")], [full("D")]), []);
  // 28L4: not a player who asked for a half-point bye, while another in the group can take it.
  const later = swiss([p("A", 2000), p("B", 1900), p("C", 1800, { byes: [3] })], []);
  assert.match(check(later, 1, [g("A", "B")], [full("C")], page, 3)[0], /^C took or asked for a half-point bye, so 28L4/);
  // 28L3: not a player who won by a no-show's forfeit, while someone else can take it.
  const forfeit = swiss(["A", "B", "C", "D", "E"].map((id, i) => p(id, 2000 - i * 100)),
    [{ games: [g("A", "D", "1-0"), g("E", "B", "1F-0F")], byes: [half("C")] }]);
  assert.match(check(forfeit, 2, [g("A", "C"), g("B", "D")], [full("E")])[0], /^E won a game by forfeit, and 28L3 says not to/);
  // None in an extra games section (28M4) or a quad, of either kind.
  const extra = Pairing.sections({ format: "swiss", sections: [{ name: "Open" }, { name: "Extra", extra: true, first: 2, last: 2, players: ["A", "B", "C"] }],
    players: five.slice(0, 3).map((x) => ({ ...x, section: "Open" })), rounds: [{ games: [g("A", "B", "1-0")], byes: [full("C")] }] })[1];
  assert.match(check(extra, 2, [g("A", "B")], [full("C")])[0], /^An extra games section gives no full-point bye \(28M4\); make C's round unplayed\.$/);
  assert.match(check(extra, 2, [g("A", "B")], [half("C")])[0], /^An extra games section has no half-point byes/);
});
