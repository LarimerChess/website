// Swiss pairings by the US Chess rules, chapter 2, sections 27 to 29: the TD desk pairs each
// round with it, and tests/test_pairing.mjs checks it against the rulebook's examples. The TD
// reviews every round and can swap pairings before posting them (29E7: the director is still
// responsible for the pairings).
//
// A tournament is { players, rounds }:
//   players: [{ id, name, rating, byes }]  rating null for an unrated player
//     byes: the rounds they asked in advance to take half-point byes in (22C), if any
//   rounds:  [{ games: [{ white, black, result }], byes: [{ id, points, kind }], out: [ids] }]
//     result: "1-0", "0-1", "1/2-1/2", or a forfeit, "1F-0F", "0F-1F", "0F-0F"
//     byes: the rounds players have no game in; kind is bye (1 point), half (0.5), zero, or unplayed (0)
//     out: withdrawn or expelled before this round, and in every later round
//
// pairRound(tournament, { halfByes, zeroByes, absent, out, coin }) returns { games: [{ board, white, black }], byes, notes }
// for the next round. coin, for round one: "white" if the higher-rated player on board one has white.
//
// A tournament with sections also has sections: [{ name, under }] and each player's section;
// sections(t) splits it into one such tournament per section, and pairSections pairs them all.
// An extra rated games section (28M4), { name, extra: true, first, last, players: [ids] }, holds
// players who are also in another section, from round first to round last of the tournament;
// once a tournament has one, its other sections carry last too.

(function (root) {
  "use strict";

  const POINTS = { "1-0": [1, 0], "0-1": [0, 1], "1/2-1/2": [0.5, 0.5], "1F-0F": [1, 0], "0F-1F": [0, 1], "0F-0F": [0, 0] };
  const FORFEIT = (result) => /F/.test(result);
  // A round a player has no game in: a full-point bye (28L), a half-point bye (22C), a zero-point
  // bye asked for in advance, or unplayed, such as a no-show. The TD can reclassify one afterward,
  // so a row may carry its kind; one without falls back on its points.
  const BYE_KINDS = { bye: 1, half: 0.5, zero: 0, unplayed: 0 };
  const byeKind = (b) => (BYE_KINDS[b.kind] !== undefined ? b.kind
    : Number(b.points) === 1 ? "bye" : Number(b.points) === 0.5 ? "half" : "unplayed");

  /** Everything the rules look at for each player, after the rounds played so far. */
  function histories(tournament) {
    const info = new Map(tournament.players.map((p) => [p.id, {
      id: p.id, name: p.name, rating: p.rating == null ? null : Number(p.rating), score: 0,
      colors: [], met: new Set(), hadFullBye: false, hadForfeitWin: false, hadHalfBye: false, out: false,
      // Asked for a half-point bye in a round after the one being paired (28L4).
      committed: (p.byes || []).some((n) => Number(n) > tournament.rounds.length + 1),
    }]));
    tournament.rounds.forEach((round) => {
      for (const id of round.out || []) if (info.has(id)) info.get(id).out = true;
      const touched = new Set();
      for (const g of round.games) {
        const [w, b] = POINTS[g.result] || [0, 0];
        const white = info.get(g.white), black = info.get(g.black);
        if (!white || !black) continue;
        if (g.result) { white.score += w; black.score += b; }
        if (g.result && FORFEIT(g.result)) {
          // 27A1: a game forfeited by a no-show doesn't count as meeting; 29E1: nor for color.
          if (g.result === "1F-0F") white.hadForfeitWin = true;
          if (g.result === "0F-1F") black.hadForfeitWin = true;
          white.colors.push(null);
          black.colors.push(null);
        } else {
          white.met.add(black.id);
          black.met.add(white.id);
          white.colors.push("W");
          black.colors.push("B");
        }
        touched.add(white.id).add(black.id);
      }
      for (const bye of round.byes || []) {
        const p = info.get(bye.id);
        if (!p) continue;
        p.score += Number(bye.points) || 0;
        if (byeKind(bye) === "bye") p.hadFullBye = true;
        if (byeKind(bye) === "half") p.hadHalfBye = true;
        p.colors.push(null);
        touched.add(p.id);
      }
      for (const p of info.values()) if (!touched.has(p.id)) p.colors.push(null);
    });
    return info;
  }

  const played = (p) => p.colors.filter(Boolean);
  const whites = (p) => played(p).filter((c) => c === "W").length;
  const blacks = (p) => played(p).filter((c) => c === "B").length;
  const lastColor = (p) => played(p).at(-1) || null;

  /** 29E3a: the color that equalizes, or else the opposite of the last; null if no games yet. */
  function dueColor(p) {
    const diff = whites(p) - blacks(p);
    if (diff > 0) return "B";
    if (diff < 0) return "W";
    const last = lastColor(p);
    return last ? (last === "W" ? "B" : "W") : null;
  }

  /** Rank (29A): score, then rating; unrated players below rated ones in their score group. */
  function byRank(a, b) {
    return b.score - a.score || (b.rating ?? -1) - (a.rating ?? -1) || String(a.id).localeCompare(String(b.id));
  }

  /** 29E4: which of two players gets their due color. Returns [white, black]. */
  function assignColors(a, b) {
    const dueA = dueColor(a), dueB = dueColor(b);
    if (!dueA && !dueB) return byRank(a, b) <= 0 ? [a, b] : [b, a];
    if (!dueB) return dueA === "W" ? [a, b] : [b, a];
    if (!dueA) return dueB === "W" ? [b, a] : [a, b];
    if (dueA !== dueB) return dueA === "W" ? [a, b] : [b, a];
    const winner = colorPriority(a, b);
    const due = winner === a ? dueA : dueB;
    const loser = winner === a ? b : a;
    return due === "W" ? [winner, loser] : [loser, winner];
  }

  /** 29E4, rules 1 to 5: the player with the stronger claim to the color both are due. */
  function colorPriority(a, b) {
    const imbalance = (p) => Math.abs(whites(p) - blacks(p));
    if (imbalance(a) !== imbalance(b)) return imbalance(a) > imbalance(b) ? a : b;
    // Rules 3 and 4: the latest round in which their colors differed; whoever had the color
    // they are both due then has the weaker claim.
    const due = dueColor(a);
    for (let i = Math.min(a.colors.length, b.colors.length) - 1; i >= 0; i--) {
      if (a.colors[i] !== b.colors[i]) {
        if (a.colors[i] === due) return b;
        if (b.colors[i] === due) return a;
        return a.colors[i] ? a : b;
      }
    }
    return byRank(a, b) <= 0 ? a : b;
  }

  /** How badly a pairing serves each player's colors: [equalization, three in a row, alternation]. */
  function colorCost(white, black) {
    let equalize = 0, series = 0, alternate = 0;
    for (const [p, c] of [[white, "W"], [black, "B"]]) {
      const due = dueColor(p);
      if (!due || due === c) continue;
      if (whites(p) !== blacks(p)) equalize++;
      else alternate++;
      const recent = played(p).slice(-2);
      if (recent.length === 2 && recent.every((x) => x === c)) series++;
    }
    return [equalize, series, alternate];
  }

  /** Whether the players can all be paired with no one meeting twice. */
  function pairable(players) {
    if (players.length % 2) return false;
    const list = [...players];
    const seen = new Map();
    const go = (left) => {
      if (!left.length) return true;
      const key = left.map((p) => p.id).join(",");
      if (seen.has(key)) return seen.get(key);
      const [first, ...rest] = left;
      let ok = false;
      for (let i = 0; i < rest.length && !ok; i++) {
        if (!first.met.has(rest[i].id)) ok = go(rest.filter((_, j) => j !== i));
      }
      seen.set(key, ok);
      return ok;
    };
    return go(list);
  }

  /** The permutations of [0..n), nearest the identity first, up to a limit. */
  function permutations(n, limit = 50000) {
    const out = [];
    const walk = (prefix, left) => {
      if (out.length >= limit) return;
      if (!left.length) return out.push(prefix);
      for (const x of left) walk([...prefix, x], left.filter((y) => y !== x));
    };
    walk([], [...Array(n).keys()]);
    return out;
  }

  /** The size of a switch from the natural pairing, by 29E5c: the smaller of the two ways of
   *  making it, each the largest rating move. Unrated players don't count (29E5g). */
  function switchSize(upper, lower, perm) {
    const r = (p) => p.rating ?? null;
    const moves = (fromSlots, toSlots) => fromSlots.reduce((max, p, i) => {
      const q = toSlots[i];
      if (p === q || r(p) == null || r(q) == null) return max;
      return Math.max(max, Math.abs(r(p) - r(q)));
    }, 0);
    // Moving the lower half: slot i gets lower[perm[i]].
    const lowerWay = moves(perm.map((j) => lower[j]), lower);
    // Or moving the upper half: lower[j] keeps its slot and meets upper[inverse[j]].
    const inverse = [];
    perm.forEach((j, i) => { inverse[j] = i; });
    const upperWay = moves(inverse.map((i) => upper[i]), upper);
    return Math.min(lowerWay, upperWay);
  }

  const better = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };

  /** The best pairing of an even group by halves (29C), with transpositions and at most one
   *  interchange to avoid rematches and fix colors within the 80- and 200-point rules (29E5). */
  function pairHalves(group) {
    const sorted = [...group].sort(byRank);
    const half = sorted.length / 2;
    const options = [{ upper: sorted.slice(0, half), lower: sorted.slice(half), interchange: false, size: 0 }];
    // 29C2: an interchange between the bottom of the upper half and the top of the lower half.
    for (let i = half - 1; i >= Math.max(0, half - 2); i--) {
      for (let j = half; j < Math.min(sorted.length, half + 2); j++) {
        const s = [...sorted];
        [s[i], s[j]] = [s[j], s[i]];
        const r = (p) => p.rating ?? 0;
        options.push({ upper: s.slice(0, half), lower: s.slice(half), interchange: true, size: Math.abs(r(sorted[i]) - r(sorted[j])) });
      }
    }
    const candidates = [];
    for (const option of options) {
      for (const perm of permutations(half, half > 7 ? 5040 : 50000)) {
        const pairs = perm.map((j, i) => [option.upper[i], option.lower[j]]);
        if (pairs.some(([a, b]) => a.met.has(b.id))) continue;
        const size = Math.max(option.size, switchSize(option.upper, option.lower, perm));
        const games = pairs.map(([a, b]) => assignColors(a, b));
        const cost = games.reduce((sum, [w, b]) => colorCost(w, b).map((x, k) => x + sum[k]), [0, 0, 0]);
        candidates.push({ games, size, cost, interchange: option.interchange });
      }
    }
    if (!candidates.length) return null;
    // Switches to avoid rematches have no limit (29D1b); the color limits count from there.
    const base = Math.min(...candidates.map((c) => c.size));
    const natural = candidates.reduce((best, c) => c.size === base && (!best || better(c.cost, best.cost)) ? c : best, null);
    let best = null;
    for (const c of candidates) {
      const extra = c.size - base;
      // 29E5b: up to 200 points to reduce equalization problems or three in a row;
      // 29E5a: up to 80 points for alternation.
      const helpsEqualizing = c.cost[0] < natural.cost[0] || (c.cost[0] === natural.cost[0] && c.cost[1] < natural.cost[1]);
      if (extra > 200 || (extra > 80 && !helpsEqualizing)) continue;
      // 29E5e: a transposition within 80 points comes before any interchange; otherwise the smaller switch.
      c.key = [...c.cost, !c.interchange && extra <= 80 ? 0 : 1, extra];
      if (!best || better(c.key, best.key)) best = c;
    }
    return best ? { games: best.games, cost: best.cost } : null;
  }

  /** Pairs everyone in rank order, group by group, dropping odd players (29D). */
  function pairGroups(players) {
    const ranked = [...players].sort(byRank);
    const scores = [...new Set(ranked.map((p) => p.score))];
    const attempt = (index, carried) => {
      if (index >= scores.length) return carried.length ? null : [];
      const own = ranked.filter((p) => p.score === scores[index]);
      const below = ranked.filter((p) => p.score < scores[index]);
      // Carried players are paired first, each with the highest-rated player they can play (29D2).
      const pairCarried = (carriedLeft, pool, games) => {
        if (!carriedLeft.length) return [{ pool, games }];
        const [first, ...others] = carriedLeft;
        const results = [];
        const choices = pool.filter((p) => !first.met.has(p.id)).sort(byRank);
        for (const opponent of choices) {
          const left = pool.filter((p) => p !== opponent);
          for (const r of pairCarried(others, left, [...games, assignColors(first, opponent)])) results.push(r);
          if (results.length > 6) break;
        }
        return results;
      };
      const tries = pairCarried(carried, own, []);
      // Carried players who can't be paired here drop again.
      if (!tries.length && carried.length) {
        return attempt(index + 1, [...carried, ...own]);
      }
      for (const { pool, games } of tries) {
        // 29D1: the lowest-rated, but not an unrated, player is the odd one; then the next lowest.
        const dropOrders = [];
        const byRating = [...pool].sort((a, b) => (a.rating == null) - (b.rating == null) || (a.rating ?? 0) - (b.rating ?? 0));
        const needed = pool.length % 2;
        if (needed === 0) dropOrders.push([]);
        if (needed === 1) dropOrders.push(...oddPlayers(pool, byRating, below).map((d) => [d]));
        for (let k = needed + 2; k <= Math.min(pool.length, needed + 4); k += 2) {
          for (const c of combinations(byRating, k)) dropOrders.push(c);
        }
        for (const drop of dropOrders) {
          const stay = pool.filter((p) => !drop.includes(p));
          const rest = [...drop, ...below];
          const paired = stay.length ? pairHalves(stay) : { games: [] };
          if (paired === null) continue;
          if (!pairable(rest)) continue;
          const next = attempt(index + 1, [...drop].sort(byRank));
          if (next) return [...games, ...paired.games, ...next];
        }
      }
      return null;
    };
    return attempt(0, []);
  }

  /**
   * The order to try odd players in (29D1): the lowest-rated first, unless another drop gives
   * better colors within the 80- and 200-point rules (29E7, example 5), and then the next lowest
   * (29D1b). The size of that switch is the smaller of the two ratings changes: between the odd
   * players, or between the opponents the natural odd player would have had.
   */
  function oddPlayers(pool, byRating, below) {
    const nextScore = below.length ? below.reduce((m, p) => Math.max(m, p.score), -Infinity) : null;
    const next = below.filter((p) => p.score === nextScore).sort(byRank);
    const natural = byRating[0];
    const r = (p) => p?.rating ?? 0;
    const option = (d) => {
      const group = pairHalves(pool.filter((p) => p !== d));
      const opponent = next.find((p) => !d.met.has(p.id));
      if (!group || !opponent) return { d, key: [Infinity] };
      const drop = assignColors(d, opponent);
      const cost = colorCost(...drop).map((x, k) => x + group.cost[k]);
      const naturalOpponent = next.find((p) => !natural.met.has(p.id));
      const game = group.games.find(([w, b]) => w === natural || b === natural);
      const partner = game ? (game[0] === natural ? game[1] : game[0]) : null;
      const size = d === natural ? 0 : Math.min(Math.abs(r(d) - r(natural)),
        partner && naturalOpponent ? Math.abs(r(partner) - r(naturalOpponent)) : Infinity);
      return { d, cost, size };
    };
    const options = byRating.map(option);
    const base = options[0];
    options.forEach((o, i) => { o.fromBottom = i; });
    for (const o of options) {
      if (!o.cost) continue;
      const helpsEqualizing = base.cost && (o.cost[0] < base.cost[0] || (o.cost[0] === base.cost[0] && o.cost[1] < base.cost[1]));
      const allowed = o.size <= 80 || (o.size <= 200 && helpsEqualizing);
      o.key = allowed ? [0, ...o.cost, o.fromBottom] : [1, o.fromBottom];
    }
    return options.sort((a, b) => better(a.key, b.key) ? -1 : better(b.key, a.key) ? 1 : 0).map((o) => o.d);
  }

  /** Subsets of size k, preferring the first elements (the lowest rated). */
  function combinations(list, k, limit = 200) {
    const out = [];
    const walk = (start, chosen) => {
      if (out.length >= limit) return;
      if (chosen.length === k) return out.push(chosen);
      for (let i = start; i < list.length; i++) walk(i + 1, [...chosen, list[i]]);
    };
    walk(0, []);
    return out;
  }

  /** 28L2: the full-point bye, from the lowest score group up: the lowest-rated eligible player. */
  function chooseBye(players) {
    const eligible = (p, strict) => !p.hadFullBye && !p.hadForfeitWin && (!strict || (!p.hadHalfBye && !p.committed && p.rating != null));
    const order = [...players].sort((a, b) => a.score - b.score
      || (a.rating == null) - (b.rating == null) || (a.rating ?? 0) - (b.rating ?? 0));
    for (const strict of [true, false]) {
      for (const p of order) {
        if (!eligible(p, strict)) continue;
        if (pairable(players.filter((q) => q !== p))) return p;
      }
    }
    return order.find((p) => !p.hadFullBye) || order[0];
  }

  /** 28J: round one. Upper half against lower half by rating, colors alternating down from the coin. */
  function firstRound(players, coin) {
    const sorted = [...players].sort(byRank);
    const half = sorted.length / 2;
    return sorted.slice(0, half).map((p, i) => {
      const q = sorted[half + i];
      const higherWhite = (i % 2 === 0) === (coin !== "black");
      return higherWhite ? [p, q] : [q, p];
    });
  }

  function pairRound(tournament, options = {}) {
    const info = histories(tournament);
    const halfByes = new Set(options.halfByes || []);
    const absent = new Set(options.absent || []);
    const zeroByes = new Set(options.zeroByes || []);
    const leaving = new Set(options.out || []);
    const notes = [];
    const byes = [];
    const playing = [];
    for (const p of info.values()) {
      if (p.out || leaving.has(p.id)) continue;
      if (halfByes.has(p.id)) byes.push({ id: p.id, points: 0.5, kind: "half" });
      else if (zeroByes.has(p.id)) byes.push({ id: p.id, points: 0, kind: "zero" });
      else if (absent.has(p.id)) byes.push({ id: p.id, points: 0, kind: "unplayed" });
      else playing.push(p);
    }
    if (playing.length % 2) {
      const bye = chooseBye(playing);
      byes.push({ id: bye.id, points: 1, kind: "bye" });
      playing.splice(playing.indexOf(bye), 1);
      notes.push(`Full-point bye: ${bye.name || bye.id}.`);
    }
    const firstGames = tournament.rounds.every((r) => !r.games.length);
    let pairs = firstGames ? firstRound(playing, options.coin) : pairGroups(playing);
    if (!pairs) {
      notes.push("These players can't all be paired without someone meeting an opponent twice; the TD pairs this round by hand.");
      pairs = [];
    }
    const games = pairs
      .map(([white, black]) => ({ white, black }))
      .sort((a, b) => {
        const top = (g) => [g.white, g.black].sort(byRank)[0];
        return byRank(top(a), top(b));
      })
      .map((g, i) => ({ board: i + 1, white: g.white.id, black: g.black.id }));
    return { games, byes, notes };
  }

  /** Each player's performance rating over the games played so far against rated opponents: the
   *  rating whose Elo expected score is the score made, or null with no such games. A perfect or
   *  zero score has no such rating; it is capped at 800 above or below the opponents' average, as
   *  FIDE does. Forfeits and byes are not games played. */
  function performance(tournament, info) {
    const games = new Map([...info.keys()].map((id) => [id, { points: 0, ratings: [] }]));
    for (const round of tournament.rounds) {
      for (const g of round.games) {
        if (!POINTS[g.result] || FORFEIT(g.result)) continue;
        const [w, b] = POINTS[g.result];
        for (const [me, them, points] of [[g.white, g.black, w], [g.black, g.white, b]]) {
          const rating = info.get(them)?.rating;
          if (!games.has(me) || !(rating > 0)) continue;
          games.get(me).points += points;
          games.get(me).ratings.push(rating);
        }
      }
    }
    return new Map([...games].map(([id, { points, ratings }]) => {
      if (!ratings.length) return [id, null];
      const average = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
      const p = points / ratings.length;
      const difference = Math.max(-800, Math.min(800, 400 * Math.log10(p / (1 - p))));
      return [id, Math.round(average + difference)];
    }));
  }

  /** Each player's rounds, as on a wall chart: { code, opponent, color } with code W, L, D, X (won by
   *  forfeit), F (lost by forfeit), B (full-point bye), H (half-point bye), U (not played), or "" for
   *  a game without a result yet, and color w or b for a game on the board. */
  function roundByRound(tournament) {
    const out = new Map(tournament.players.map((p) => [p.id, []]));
    for (const round of tournament.rounds) {
      const got = new Map();
      for (const g of round.games) {
        const points = POINTS[g.result];
        const forfeit = Boolean(points) && FORFEIT(g.result);
        for (const [me, them, color, side] of [[g.white, g.black, "w", 0], [g.black, g.white, "b", 1]]) {
          const code = !points ? "" : forfeit ? (points[side] ? "X" : "F") : points[side] === 1 ? "W" : points[side] ? "D" : "L";
          got.set(me, { code, opponent: them, color: forfeit ? "" : color });
        }
      }
      for (const b of round.byes || []) got.set(b.id, { code: { bye: "B", half: "H" }[byeKind(b)] || "U", opponent: null, color: "" });
      for (const [id, list] of out) list.push(got.get(id) || { code: "U", opponent: null, color: "" });
    }
    return out;
  }

  // US Chess's rating system, as specified April 6, 2026 (glicko.net/ratings/rating.system.pdf);
  // section numbers below are that document's.

  /** 3: the effective number of prior games. */
  function effectiveGames(rating, games) {
    return Math.min(games, rating > 2355 ? 50 : 50 / Math.sqrt(0.662 + 0.00000739 * (2569 - rating) ** 2));
  }

  /** 4.1: the special formula, found by the document's own iteration so that ties between equally
   *  good ratings break as US Chess's do. games: [{ rating, score }]; sweep: "wins" or "losses" if
   *  every prior game was one. */
  function specialRating(r0, effective, games, sweep) {
    const score = games.reduce((sum, g) => sum + g.score, 0);
    const prior = sweep === "wins" ? r0 - 400 : sweep === "losses" ? r0 + 400 : r0;
    const target = sweep === "wins" ? score + effective : sweep === "losses" ? score : score + effective / 2;
    const pwe = (r, ri) => (r <= ri - 400 ? 0 : r >= ri + 400 ? 1 : 0.5 + (r - ri) / 800);
    const f = (r) => effective * pwe(r, prior) + games.reduce((sum, g) => sum + pwe(r, g.rating), 0) - target;
    const knots = [...new Set([prior, ...games.map((g) => g.rating)].flatMap((x) => [x - 400, x + 400]))].sort((a, b) => a - b);
    const below = (m) => knots.filter((z) => z < m).at(-1);
    const above = (m) => knots.find((z) => z > m);
    const eps = 1e-7;
    let m = prior;
    for (let step = 0; step < 1000; step++) {
      const fm = f(m);
      if (fm > eps) {
        const za = below(m);
        if (za === undefined) break;
        if (Math.abs(fm - f(za)) < eps) { m = za; continue; }
        m = Math.max(za, m - fm * (m - za) / (fm - f(za)));
      } else if (fm < -eps) {
        const zb = above(m);
        if (zb === undefined) break;
        if (Math.abs(f(zb) - fm) < eps) { m = zb; continue; }
        m = Math.min(zb, m - fm * (zb - m) / (f(zb) - fm));
      } else {
        const near = games.filter((g) => Math.abs(m - g.rating) <= 400).length + (Math.abs(m - prior) <= 400 ? 1 : 0);
        if (!near) {
          const za = below(m), zb = above(m);
          if (za !== undefined && r0 < za) m = za;
          else if (zb !== undefined && r0 > zb) m = zb;
          else m = r0;
        }
        break;
      }
    }
    return Math.min(2700, m);
  }

  /** 4.2: the standard formula. The bonus needs three games against different opponents, or more
   *  than three with no opponent met three times. */
  function standardRating(r0, effective, games) {
    const m = games.length;
    const k = 800 / (effective + m);
    const change = k * games.reduce((sum, g) => sum + g.score - 1 / (1 + 10 ** (-(r0 - g.rating) / 400)), 0);
    const meetings = Math.max(0, ...Object.values(games.reduce((n, g) => ({ ...n, [g.id]: (n[g.id] || 0) + 1 }), {})));
    const bonus = (m === 3 && meetings === 1) || (m > 3 && meetings <= 2);
    return r0 + change + (bonus ? Math.max(0, change - 10 * Math.sqrt(Math.max(m, 4))) : 0);
  }

  /** Each player's estimated regular rating once the games played so far are rated, by the five
   *  steps of section 1; null for a player with none. A player carries rating, games (their rated
   *  games before the event, null if unknown), sweep, and floor. An unrated player starts at the
   *  1300 the document gives an adult of unknown age, which decides only ties (4.1, step 4b); one
   *  with games unknown counts as established. Not modeled: unrated players' other ratings (2),
   *  the K for players over 2200 in dual-rated events (4.2), and anything after the event. */
  function ratingEstimates(tournament) {
    const players = new Map(tournament.players.map((p) => {
      const rating = Number(p.rating) > 0 ? Number(p.rating) : null;
      const games = rating == null ? 0 : p.games == null || p.games === "" ? 50 : Number(p.games);
      return [p.id, { r0: rating ?? 1300, games, effective: effectiveGames(rating ?? 1300, games), sweep: p.sweep || "",
        floor: Math.max(100, Number(p.floor) || 0), played: [] }];
    }));
    for (const round of tournament.rounds) {
      for (const g of round.games) {
        if (!POINTS[g.result] || FORFEIT(g.result) || !players.has(g.white) || !players.has(g.black)) continue;
        const [w, b] = POINTS[g.result];
        players.get(g.white).played.push({ id: g.black, score: w });
        players.get(g.black).played.push({ id: g.white, score: b });
      }
    }
    const rate = (p, ratingOf, effective = p.effective) => {
      const games = p.played.map((g) => ({ id: g.id, score: g.score, rating: ratingOf(g.id) }));
      const r = p.games <= 8 || p.sweep ? specialRating(p.r0, effective, games, p.sweep) : standardRating(p.r0, effective, games);
      return Math.max(100, r);
    };
    const pre = (id) => players.get(id).r0;
    // Step 3: unrated players first, with one effective game, against everyone's pre-event ratings.
    const first = new Map([...players].filter(([, p]) => p.games === 0).map(([id, p]) => [id, rate(p, pre, 1)]));
    const step3 = (id) => first.get(id) ?? pre(id);
    const step4 = new Map([...players].map(([id, p]) => [id, rate(p, step3)]));
    return new Map([...players].map(([id, p]) => [id, p.played.length
      ? Math.round(Math.max(p.floor, rate(p, (o) => step4.get(o)))) : null]));
  }

  /** Standings: score, then the US Chess tiebreaks in their default order (34E): modified
   *  median, Solkoff, cumulative, and cumulative of opposition. */
  function standings(tournament) {
    const info = histories(tournament);
    const rounds = tournament.rounds.length;
    const ids = [...info.keys()];
    const each = new Map(ids.map((id) => [id, { opponents: [], perRound: [], unplayed: 0, unearned: 0 }]));
    tournament.rounds.forEach((round) => {
      const got = new Map();
      for (const g of round.games) {
        const [w, b] = POINTS[g.result] || [0, 0];
        const forfeit = !g.result || FORFEIT(g.result);
        got.set(g.white, { points: w, opponent: forfeit ? null : g.black });
        got.set(g.black, { points: b, opponent: forfeit ? null : g.white });
      }
      for (const bye of round.byes || []) got.set(bye.id, { points: Number(bye.points) || 0, opponent: null });
      for (const id of ids) {
        const e = each.get(id);
        const r = got.get(id) || { points: 0, opponent: null };
        e.perRound.push(r.points);
        if (r.opponent) e.opponents.push(r.opponent);
        else {
          e.unplayed++;
          // 34E3: one point off for each unplayed win or full-point bye, a half for each half-point bye.
          e.unearned += r.points;
        }
      }
    });
    // 34E1: opponents' scores adjusted so each unplayed game counts a half point.
    const adjusted = new Map(ids.map((id) => {
      const e = each.get(id);
      const playedPoints = e.perRound.reduce((sum, x) => sum + x, 0) - e.unearned;
      return [id, playedPoints + e.unplayed * 0.5];
    }));
    const cumulative = new Map(ids.map((id) => {
      const e = each.get(id);
      let running = 0, total = 0;
      for (const x of e.perRound) { running += x; total += running; }
      return [id, total - e.unearned];
    }));
    const drop = rounds >= 9 ? 2 : 1;
    const perf = performance(tournament, info);
    const estimate = ratingEstimates(tournament);
    const rows = ids.map((id) => {
      const p = info.get(id), e = each.get(id);
      // The player's own unplayed games count as opponents with adjusted scores of 0.
      const opp = [...e.opponents.map((o) => adjusted.get(o)), ...Array(e.unplayed).fill(0)].sort((a, b) => a - b);
      const even = rounds / 2;
      const median = p.score > even ? opp.slice(drop) : p.score < even ? opp.slice(0, opp.length - drop) : opp.slice(drop, opp.length - drop);
      return {
        id, name: p.name, rating: p.rating, score: p.score,
        median: median.reduce((sum, x) => sum + x, 0),
        solkoff: opp.reduce((sum, x) => sum + x, 0),
        cumulative: cumulative.get(id),
        opposition: e.opponents.reduce((sum, o) => sum + cumulative.get(o), 0),
        performance: perf.get(id), estimate: estimate.get(id),
      };
    });
    return rows.sort((a, b) => b.score - a.score || b.median - a.median || b.solkoff - a.solkoff
      || b.cumulative - a.cumulative || b.opposition - a.opposition || (b.rating ?? 0) - (a.rating ?? 0));
  }

  // 30G: quads. Players numbered 1 to 4 in each group of four by rating (numbers 5 to 8 are
  // the second group, and so on) play a three-round round robin from this table, white first.
  const QUAD_TABLE = [[[1, 4], [2, 3]], [[3, 1], [4, 2]], [[1, 2], [3, 4]]];

  /** A quad round's games, from players' numbers; boards run through the groups in order. */
  function pairQuadRound(players, round) {
    const byNumber = new Map(players.map((p) => [Number(p.number), p]));
    const groups = Math.ceil(players.length / 4);
    const games = [];
    for (let g = 0; g < groups; g++) {
      for (const [w, b] of QUAD_TABLE[round - 1] || []) {
        const white = byNumber.get(g * 4 + w), black = byNumber.get(g * 4 + b);
        if (white && black) games.push({ board: games.length + 1, white: white.id, black: black.id });
      }
    }
    const notes = players.length % 4 ? [`${players.length} players don't make whole quads of four; pair the last group by hand.`] : [];
    return { games, byes: [], notes };
  }

  /** Quad standings, group by group: score, then Sonneborn-Berger, then the games between the
   *  tied players (34F). Players with equal scores and tiebreaks share a place. */
  function quadStandings(tournament) {
    const info = histories(tournament);
    const numbers = new Map(tournament.players.map((p) => [p.id, Number(p.number)]));
    const results = new Map([...info.keys()].map((id) => [id, []]));
    for (const round of tournament.rounds) {
      for (const g of round.games) {
        const [w, b] = POINTS[g.result] || [null, null];
        if (w == null || FORFEIT(g.result)) continue;
        results.get(g.white)?.push({ opponent: g.black, points: w });
        results.get(g.black)?.push({ opponent: g.white, points: b });
      }
    }
    const perf = performance(tournament, info);
    const estimate = ratingEstimates(tournament);
    const rows = [...info.values()].map((p) => ({
      id: p.id, name: p.name, rating: p.rating, performance: perf.get(p.id), estimate: estimate.get(p.id), number: numbers.get(p.id), group: Math.ceil(numbers.get(p.id) / 4), score: p.score,
      // Nothing is added for losses or unplayed games.
      sonnebornBerger: results.get(p.id).reduce((sum, r) => sum + r.points * info.get(r.opponent).score, 0),
    }));
    const headToHead = (a, tied) => results.get(a.id).filter((r) => tied.some((t) => t.id === r.opponent)).reduce((sum, r) => sum + r.points, 0);
    const out = [];
    for (const group of [...new Set(rows.map((r) => r.group))].sort((a, b) => a - b)) {
      const mine = rows.filter((r) => r.group === group);
      for (const r of mine) {
        const tied = mine.filter((x) => x !== r && x.score === r.score && x.sonnebornBerger === r.sonnebornBerger);
        r.headToHead = headToHead(r, tied);
      }
      mine.sort((a, b) => b.score - a.score || b.sonnebornBerger - a.sonnebornBerger || b.headToHead - a.headToHead);
      mine.forEach((r, i) => {
        const prev = mine[i - 1];
        r.place = prev && prev.score === r.score && prev.sonnebornBerger === r.sonnebornBerger && prev.headToHead === r.headToHead
          ? prev.place : i + 1;
      });
      out.push(...mine);
    }
    return out;
  }

  /** The section a rating puts a player in: the one with the lowest limit the rating is under,
   *  or else one without a limit. Unrated players may enter any section. */
  function placeIn(defs, rating) {
    const r = rating == null || rating === "" ? null : parseInt(rating, 10);
    const allowed = defs.filter((s) => !s.under || r == null || Number.isNaN(r) || r < Number(s.under));
    const limited = allowed.filter((s) => s.under).sort((a, b) => a.under - b.under);
    return (limited[0] || allowed[0] || [...defs].sort((a, b) => (b.under || Infinity) - (a.under || Infinity))[0])?.name || "";
  }

  /** Whether a player may enter a section: playing up is allowed, playing down isn't. */
  function mayEnter(def, rating) {
    const r = rating == null || rating === "" ? NaN : parseInt(rating, 10);
    return !def.under || Number.isNaN(r) || r < Number(def.under);
  }

  /**
   * A tournament's sections in order, each a tournament of its own (28A, 29): { name, key, under,
   * extra, first, last, players, rounds }. A player plays in one section, and may also be in extra
   * sections, numbered 1 up within each in the order of their numbers; the rounds are the
   * section's own, from the tournament's round first to last (null for through the planned
   * rounds), keeping only the section's games and byes. key is what the spreadsheet's Section
   * cells hold for it, empty for a tournament started before sections, which is one section, or
   * for quads one per four numbers.
   */
  function sections(t) {
    const all = (t.sections || []).filter((s) => s && s.name);
    const defs = all.filter((s) => !s.extra);
    const extras = all.filter((s) => s.extra);
    let groups;
    if (defs.length || t.players.some((p) => p.section)) {
      const names = defs.map((s) => s.name);
      const where = new Map(t.players.map((p) => [p.id, p.section || placeIn(defs, p.rating)]));
      for (const name of where.values()) if (name && !names.includes(name)) names.push(name);
      groups = names.map((name) => ({ name, key: name, under: defs.find((s) => s.name === name)?.under || null,
        members: t.players.filter((p) => where.get(p.id) === name) }));
    } else if (t.format === "quad") {
      const quads = [...new Set(t.players.map((p) => Math.ceil(Number(p.number) / 4)))].sort((a, b) => a - b);
      groups = quads.map((q) => ({ name: `Quad ${q}`, key: "", under: null,
        members: t.players.filter((p) => Math.ceil(Number(p.number) / 4) === q) }));
    } else {
      groups = [{ name: "", key: "", under: null, members: t.players }];
    }
    for (const d of extras) {
      const ids = new Set(d.players || []);
      // The byes a player asked for are the rounds of their own section.
      groups.push({ name: d.name, key: d.name, under: null, extra: true,
        members: t.players.filter((p) => ids.has(p.id)).map(({ byes, ...p }) => p) });
    }
    // A player in two sections has a game or bye in each, told apart by its section.
    const here = (x, key) => !extras.length || (x.section || "") === key;
    return groups.map(({ members, ...g }) => {
      const def = all.find((s) => s.name === g.key) || {};
      const first = Number(def.first) || 1;
      const last = Number(def.last) || null;
      const ids = new Set(members.map((p) => p.id));
      const players = [...members].sort((a, b) => Number(a.number) - Number(b.number)).map((p, i) => ({ ...p, number: i + 1 }));
      const rounds = t.rounds.slice(first - 1, last ?? undefined).map((r) => ({ ...r,
        games: r.games.filter((x) => ids.has(x.white) && ids.has(x.black) && here(x, g.key)),
        byes: (r.byes || []).filter((b) => ids.has(b.id) && here(b, g.key)),
        out: (r.out || []).filter((id) => ids.has(id)) }));
      return { extra: false, ...g, first, last, players, rounds };
    });
  }

  /** Whether a section plays the tournament's round number. */
  const playsIn = (s, number) => number >= s.first && (s.last == null || number <= s.last);

  /**
   * The next round for every section, each paired on its own: [{ section, name, games, byes, notes }],
   * section being the key to save the round under. Boards are numbered within each section,
   * except in a tournament started before sections, whose boards run on through its quads as
   * they always did. Only the sections playing the round are paired; options may be a function
   * that gives each section its own.
   */
  function pairSections(t, options = {}) {
    const number = t.rounds.length + 1;
    let board = 0;
    return sections(t).filter((s) => s.players.length && playsIn(s, number)).map((s) => {
      const result = t.format === "quad" ? pairQuadRound(s.players, number)
        : pairRound(s, typeof options === "function" ? options(s) : options);
      const offset = s.key ? 0 : board;
      board += result.games.length;
      return { section: s.key, name: s.name, ...result, games: result.games.map((g) => ({ ...g, board: g.board + offset })) };
    });
  }

  const Pairing = { BYE_KINDS, byeKind, pairRound, standings, roundByRound, ratingEstimates, specialRating, standardRating, pairQuadRound, quadStandings, sections, playsIn, pairSections, placeIn, mayEnter,
    QUAD_TABLE, dueColor, assignColors, histories, POINTS };
  if (typeof module !== "undefined" && module.exports) module.exports = Pairing;
  else root.Pairing = Pairing;
})(typeof window !== "undefined" ? window : globalThis);
