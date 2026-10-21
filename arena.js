// Arena tournaments: players play as many games as they can before a cutoff, in sections that are
// time controls. A player is available in the sections they choose, anyone free challenges an
// available player, and the TD can pair the players waiting instead. The TD desk (td-arena.js) and
// the Pairings and Standings pages (pairings.js) use it, scripts/build_results.py and
// rating_check.mjs run it in node, and tests/test_arena.mjs checks it.
//
// An arena is { sections, players, games, queue }:
//   sections: [{ name, timeControl, rated }], rated false for one whose games US Chess won't rate;
//             [] or missing for an arena played as one section, named ""
//   players:  [{ id, name, rating }]
//   games:    [{ game, section, white, black, whitePact, blackPact, result, reports }], game numbered in pairing order
//     result:  "" until the TD enters one: "1-0", "0-1", "1/2-1/2", or a forfeit, "1F-0F", "0F-1F", "0F-0F"
//     reports: { white, black }, what each player reported, "1-0", "0-1", or "1/2-1/2", until the TD confirms it
//     whitePact, blackPact: true if that player took the Blood Pact (15 + 15 against 30 + 30)
//   queue:    [{ id, since, sections }], the players available for a game: since "YYYY-MM-DD HH:mm:ss" when
//             they became available, sections the names they play in, every section when missing or empty
//
// A game is in progress until it has a result or a report, and a player in one is busy, available in no
// section. The TD's result counts; until the TD confirms or corrects it, so does what the players reported,
// if they agree or only one has reported.
//
// Scoring: win 2, draw 1, loss 0. After two wins in a row, each further win is 3 until a loss or
// draw (Possessed). A win with the Blood Pact against an opponent without it earns 1 more.

(function (root) {
  "use strict";

  const RESULTS = ["1-0", "0-1", "1/2-1/2", "1F-0F", "0F-1F", "0F-0F"];
  const REPORTS = ["1-0", "0-1", "1/2-1/2"];
  const FORFEIT = (result) => /F/.test(result);
  const OUTCOME = { "1-0": ["win", "loss"], "0-1": ["loss", "win"], "1/2-1/2": ["draw", "draw"],
    "1F-0F": ["win", "loss"], "0F-1F": ["loss", "win"], "0F-0F": ["loss", "loss"] };

  // Rule 5C1: a game where only one player took the Blood Pact has time odds, so US Chess doesn't rate it.
  const timeOdds = (g) => Boolean(g.whitePact) !== Boolean(g.blackPact);

  const byNumber = (games) => [...games].sort((a, b) => Number(a.game) - Number(b.game));

  const reportsOf = (g) => [g.reports?.white, g.reports?.black].filter((r) => REPORTS.includes(r));

  /** Both players reported, and not the same result: the TD settles it. */
  const disputed = (g) => !g.result && reportsOf(g).length === 2 && g.reports.white !== g.reports.black;

  /** The result that counts: the TD's, or else the players' uncontested report; "" for none. */
  function resultOf(g) {
    if (g.result) return g.result;
    const sent = reportsOf(g);
    return sent.length && sent.every((r) => r === sent[0]) ? sent[0] : "";
  }

  const inProgress = (g) => !g.result && !reportsOf(g).length;

  /** The players in a game in progress. */
  const busy = (arena) => new Set(arena.games.filter(inProgress).flatMap((g) => [g.white, g.black]));

  /** The sections, as defined, or the one unnamed section of an arena without any. */
  const sections = (arena) => (arena.sections?.length ? arena.sections : [{ name: "" }]);

  const sectionOf = (arena, name) => sections(arena).find((s) => s.name === (name || "")) || null;

  /** Why US Chess won't rate a played game: its section isn't rated, or it has time odds; "" when it can. */
  function notRated(arena, g) {
    const def = sectionOf(arena, g.section);
    if (def && def.rated === false) return "section not US Chess rated";
    return timeOdds(g) && !FORFEIT(resultOf(g)) ? "time odds" : "";
  }

  /** The arena with only one section's games, for that section's leaderboard. */
  const inSection = (arena, name) => ({ ...arena, games: arena.games.filter((g) => (g.section || "") === (name || "")) });

  /** Each player's points, played games, current run of wins, and Blood Pact bonuses. */
  function tally(arena) {
    const info = new Map(arena.players.map((p) => [p.id, {
      id: p.id, name: p.name, rating: p.rating == null ? null : Number(p.rating),
      points: 0, games: 0, wins: 0, draws: 0, losses: 0, streak: 0, bonus: 0,
    }]));
    for (const g of byNumber(arena.games)) {
      const result = resultOf(g);
      if (!OUTCOME[result]) continue;
      const forfeit = FORFEIT(result);
      const sides = [[g.white, g.whitePact, g.blackPact], [g.black, g.blackPact, g.whitePact]];
      sides.forEach(([id, pact, otherPact], i) => {
        const p = info.get(id);
        if (!p) return;
        const outcome = OUTCOME[result][i];
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
    return byNumber(games).filter((g) => resultOf(g) && !FORFEIT(resultOf(g)) && (g.white === id || g.black === id))
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

  /** The queue in the order players joined it, longest wait first, each entry with its sections. */
  function queued(arena) {
    return arena.queue.map((q, i) => ({ ...q, i }))
      .sort((a, b) => String(a.since).localeCompare(String(b.since)) || a.i - b.i)
      .map(({ i, ...q }) => q);
  }

  /** Whether a queue entry covers a section: every one when it names none. */
  const availableIn = (entry, name) => !entry.sections?.length || entry.sections.includes(name || "");

  /** The players available for a game, longest wait first: in the section named, or in any. */
  function waiting(arena, section) {
    const playing = busy(arena);
    return queued(arena).filter((q) => !playing.has(q.id) && (section === undefined || availableIn(q, section))).map((q) => q.id);
  }

  /** Pairs two players who weren't each other's opponent in their latest game, or either's. */
  const mayMeet = (games, a, b) => a !== b && lastOpponent(games, a) !== b && lastOpponent(games, b) !== a;

  /**
   * Pairs whoever can play now, section by section: the longest-waiting player available in it with the
   * next-longest-waiting one who may meet them, and so on down the queue, each player once. Returns
   * { games: [{ white, black, section }], waiting: [ids left over] }.
   */
  function pair(arena) {
    const games = [];
    const paired = new Set();
    for (const def of sections(arena)) {
      const left = waiting(arena, def.name).filter((id) => !paired.has(id));
      for (let i = 0; i < left.length; i++) {
        const a = left[i];
        const j = left.findIndex((b, k) => k > i && mayMeet(arena.games, a, b));
        if (j < 0) continue;
        const [white, black] = assignColors(arena.games, a, left[j]);
        games.push({ white, black, section: def.name });
        paired.add(white).add(black);
        left.splice(j, 1);
        left.splice(i--, 1);
      }
    }
    return { games, waiting: waiting(arena).filter((id) => !paired.has(id)) };
  }

  /**
   * A challenger's game against a player available in a section: { white, black, section }, the
   * available player having waited, or { error } saying why not.
   */
  function challenge(arena, challenger, opponent, section) {
    const def = sectionOf(arena, section);
    const name = (id) => arena.players.find((p) => p.id === id)?.name || id;
    if (!def) return { error: "No such section." };
    if (!arena.players.some((p) => p.id === challenger)) return { error: "You're not in this arena yet. See the TD." };
    if (!arena.players.some((p) => p.id === opponent)) return { error: "That player isn't in this arena." };
    if (challenger === opponent) return { error: "You can't challenge yourself." };
    const playing = busy(arena);
    if (playing.has(challenger)) return { error: "You're in a game. Report its result first." };
    if (playing.has(opponent)) return { error: `${name(opponent)} is in a game.` };
    const entry = arena.queue.find((q) => q.id === opponent);
    if (!entry || !availableIn(entry, def.name)) return { error: `${name(opponent)} isn't available${def.name ? ` in ${def.name}` : ""} right now.` };
    if (!mayMeet(arena.games, challenger, opponent)) return { error: `You and ${name(opponent)} just played each other. Play someone else first.` };
    const [white, black] = assignColors(arena.games, opponent, challenger);
    return { white, black, section: def.name };
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

  const Arena = { RESULTS, REPORTS, FORFEIT, timeOdds, resultOf, disputed, inProgress, busy, sections, sectionOf, notRated, inSection,
    tally, standings, lastOpponent, assignColors, queued, availableIn, waiting, pair, challenge, localTime, pastCutoff };
  if (typeof module !== "undefined" && module.exports) module.exports = Arena;
  else root.Arena = Arena;
})(typeof window !== "undefined" ? window : globalThis);
