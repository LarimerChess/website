// Arena tournaments: players play as many games as they can before a cutoff, each pairing taken
// from the queue of players waiting for a game. The TD desk pairs and scores with it, the
// Pairings page shows the leaderboard, and tests/test_arena.mjs checks it.
//
// An arena is { players, games, queue }:
//   players: [{ id, name, rating }]
//   games:   [{ game, white, black, whitePact, blackPact, result }], game numbered in pairing order
//     result: "" while in progress, "1-0", "0-1", "1/2-1/2", or a forfeit, "1F-0F", "0F-1F", "0F-0F"
//     whitePact, blackPact: true if that player took the Blood Pact (15 + 15 against 30 + 30)
//   queue:   [{ id, since }], since "YYYY-MM-DD HH:mm:ss" when the player joined the queue
//
// Scoring: win 2, draw 1, loss 0. After two wins in a row, each further win is 3 until a loss or
// draw (Possessed). A win with the Blood Pact against an opponent without it earns 1 more.

(function (root) {
  "use strict";

  const RESULTS = ["1-0", "0-1", "1/2-1/2", "1F-0F", "0F-1F", "0F-0F"];
  const FORFEIT = (result) => /F/.test(result);
  const OUTCOME = { "1-0": ["win", "loss"], "0-1": ["loss", "win"], "1/2-1/2": ["draw", "draw"],
    "1F-0F": ["win", "loss"], "0F-1F": ["loss", "win"], "0F-0F": ["loss", "loss"] };

  const byNumber = (games) => [...games].sort((a, b) => Number(a.game) - Number(b.game));

  /** Each player's points, played games, current run of wins, and Blood Pact bonuses. */
  function tally(arena) {
    const info = new Map(arena.players.map((p) => [p.id, {
      id: p.id, name: p.name, rating: p.rating == null ? null : Number(p.rating),
      points: 0, games: 0, wins: 0, draws: 0, losses: 0, streak: 0, bonus: 0,
    }]));
    for (const g of byNumber(arena.games)) {
      if (!OUTCOME[g.result]) continue;
      const forfeit = FORFEIT(g.result);
      const sides = [[g.white, g.whitePact, g.blackPact], [g.black, g.blackPact, g.whitePact]];
      sides.forEach(([id, pact, otherPact], i) => {
        const p = info.get(id);
        if (!p) return;
        const outcome = OUTCOME[g.result][i];
        // A forfeit win scores the base 2 but neither extends a run of wins nor earns the
        // Blood Pact bonus; a forfeit loss ends the run like any loss.
        if (forfeit) {
          if (outcome === "win") p.points += 2;
          else p.streak = 0;
          return;
        }
        p.games++;
        if (outcome === "win") {
          p.wins++;
          p.points += p.streak >= 2 ? 3 : 2;
          p.streak++;
          if (pact && !otherPact) {
            p.points++;
            p.bonus++;
          }
        } else {
          p[outcome === "draw" ? "draws" : "losses"]++;
          if (outcome === "draw") p.points++;
          p.streak = 0;
        }
      });
    }
    return info;
  }

  /** The leaderboard, most points first. Players with equal points share a place; the order
   *  among them is by name only, since the published rules break no ties. */
  function standings(arena) {
    const rows = [...tally(arena).values()]
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    return rows.map((r) => ({ ...r, place: 1 + rows.filter((x) => x.points > r.points).length,
      tied: rows.some((x) => x !== r && x.points === r.points) }));
  }

  /** The player's opponent in their latest game, played or not; null before their first. */
  function lastOpponent(games, id) {
    const last = byNumber(games).filter((g) => g.white === id || g.black === id).at(-1);
    return last ? (last.white === id ? last.black : last.white) : null;
  }

  /** The colors of the player's played games, oldest first. */
  function colors(games, id) {
    return byNumber(games).filter((g) => g.result && !FORFEIT(g.result) && (g.white === id || g.black === id))
      .map((g) => (g.white === id ? "W" : "B"));
  }

  /** [white, black] for two players, a having waited longer: fewer whites, then black last time. */
  function assignColors(games, a, b) {
    const ca = colors(games, a), cb = colors(games, b);
    const whites = (c) => c.filter((x) => x === "W").length;
    if (whites(ca) !== whites(cb)) return whites(ca) < whites(cb) ? [a, b] : [b, a];
    const blackLast = (c) => c.at(-1) === "B";
    if (blackLast(ca) !== blackLast(cb)) return blackLast(ca) ? [a, b] : [b, a];
    return [a, b];
  }

  /** The queue in the order players joined it, longest wait first. */
  function waiting(arena) {
    return arena.queue.map((q, i) => ({ ...q, i }))
      .sort((a, b) => String(a.since).localeCompare(String(b.since)) || a.i - b.i)
      .map((q) => q.id);
  }

  /**
   * Pairs whoever can play now: the longest-waiting player with the next-longest-waiting one who
   * wasn't their opponent in either player's latest game, and so on down the queue. Returns
   * { games: [{ white, black }], waiting: [ids left in the queue] }.
   */
  function pair(arena) {
    const left = waiting(arena);
    const games = [];
    for (let i = 0; i < left.length; i++) {
      const a = left[i];
      const j = left.findIndex((b, k) => k > i && lastOpponent(arena.games, a) !== b && lastOpponent(arena.games, b) !== a);
      if (j < 0) continue;
      const [white, black] = assignColors(arena.games, a, left[j]);
      games.push({ white, black });
      left.splice(j, 1);
      left.splice(i--, 1);
    }
    return { games, waiting: left };
  }

  /** "YYYY-MM-DD HH:mm" in Fort Collins at the moment given. */
  function localTime(now) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }

  /** Whether no new games may start: on or after the cutoff ("HH:mm") on the date, or for a
   *  month (a club night's arena), after the cutoff on any day. */
  function pastCutoff(date, cutoff, now) {
    if (!/^\d\d:\d\d$/.test(cutoff || "")) return false;
    const local = localTime(now);
    if (date.length === 7) return local.slice(11) >= cutoff;
    return local >= `${date} ${cutoff}`;
  }

  const Arena = { RESULTS, FORFEIT, tally, standings, lastOpponent, assignColors, waiting, pair, localTime, pastCutoff };
  if (typeof module !== "undefined" && module.exports) module.exports = Arena;
  else root.Arena = Arena;
})(typeof window !== "undefined" ? window : globalThis);
