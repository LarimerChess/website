// The Pairings page (pairings/) and the Standings page (standings/): each tournament in progress,
// section by section, from the registration script's ?tournaments=current. Pairings shows one
// round at a time, the latest posted unless a reader picks an earlier one; Standings shows the
// standings after a round, the latest with results unless a reader picks an earlier one. An
// arena's games and queue are on Pairings, its leaderboard on Standings. ENDPOINT comes from
// register.js, Pairing from pairing.js, and Arena from arena.js.

const pairingsStatus = document.querySelector(".pairings-status");
const pairingsAll = document.querySelector(".pairings-all");
const standingsAll = document.querySelector(".standings-all");
const SHOWN = { "1-0": "1–0", "0-1": "0–1", "1/2-1/2": "½–½", "1F-0F": "1F–0F", "0F-1F": "0F–1F", "0F-0F": "0F–0F" };

function tableOf(headings, rows) {
  const table = document.createElement("table");
  table.className = "entries";
  const head = table.createTHead().insertRow();
  for (const h of headings) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = h;
    head.append(th);
  }
  const body = table.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    for (const c of cells) row.insertCell().textContent = c;
  }
  const wrap = document.createElement("div");
  wrap.className = "td-table";
  wrap.append(table);
  return wrap;
}

const paragraph = (text) => Object.assign(document.createElement("p"), { textContent: text });
const heading = (level, text) => Object.assign(document.createElement(`h${level}`), { textContent: text });

const link = (href, text) => Object.assign(document.createElement("a"), { href, textContent: text });

/** "17:30" as "5:30 PM". */
function clock(time) {
  const [h, m] = time.split(":").map(Number);
  return `${(h + 11) % 12 + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** A labelled menu of rounds that redraws what follows it, starting at the chosen one. */
function roundMenu(id, label, section, rounds, chosen, draw) {
  const menu = document.createElement("p");
  menu.className = "round-menu";
  const name = Object.assign(document.createElement("label"), { htmlFor: id, textContent: label });
  if (section) {
    const where = document.createElement("span");
    where.className = "visually-hidden";
    where.textContent = `, ${section}`;
    name.append(where);
  }
  const select = Object.assign(document.createElement("select"), { id });
  for (const [value, text] of rounds) select.append(new Option(text, value, false, value === chosen));
  const shown = document.createElement("div");
  shown.className = "round-shown";
  shown.append(...draw(chosen));
  select.addEventListener("change", () => shown.replaceChildren(...draw(Number(select.value))));
  menu.append(name, " ", select);
  return [menu, shown];
}

function namer(t) {
  return (id) => {
    const p = t.players.find((x) => x.id === id);
    return p ? `${p.name} (${p.rating ?? "unrated"})` : id;
  };
}

/** The sections with players, and whether to head each with its name. */
function partsOf(t) {
  const parts = Pairing.sections({ format: t.format, sections: t.sections || [], players: t.players, rounds: t.rounds })
    .filter((s) => s.players.length);
  return { parts, several: parts.length > 1 };
}

const RECENT = 12;

function arenaPairings(section, t, name) {
  if (t.cutoff && t.status !== "finished") section.append(paragraph(`No new games start after ${clock(t.cutoff)}.`));
  const playing = t.games.filter((g) => !g.result);
  const pact = (g, side) => name(g[side]) + (g[`${side}Pact`] ? ", Blood Pact" : "");
  if (playing.length) {
    section.append(heading(3, "Games in progress"),
      tableOf(["Game", "White", "Black"], playing.map((g) => [g.game, pact(g, "white"), pact(g, "black")])));
  } else if (t.status !== "finished") {
    section.append(paragraph("No games in progress."));
  }
  const waiting = Arena.waiting(t);
  if (waiting.length && t.status !== "finished") section.append(paragraph(`Waiting for a game: ${waiting.map(name).join(", ")}.`));
  const done = t.games.filter((g) => g.result).reverse().slice(0, RECENT);
  if (done.length) {
    section.append(heading(3, "Recent results"),
      tableOf(["Game", "White", "Black", "Result"], done.map((g) => [g.game, pact(g, "white"), pact(g, "black"), SHOWN[g.result] || ""])));
  }
  const more = paragraph("The leaderboard is on the ");
  more.append(link("/standings/", "Standings"), " page.");
  section.append(more);
  return section;
}

function arenaStandings(section, t) {
  const rows = Arena.standings(t);
  section.append(heading(3, t.status === "finished" ? "Final leaderboard" : "Leaderboard"),
    paragraph("Players with equal points share a place."),
    tableOf(["Place", "Name", "Rating", "Points", "Games", "Wins in a row"], rows.map((r) => [
      `${r.place}${r.tied ? " (tied)" : ""}`, r.name, r.rating ?? "Unrated", r.points, r.games,
      `${r.streak}${r.streak >= 2 ? " (Possessed)" : ""}`])));
  const more = paragraph("Games in progress and who is waiting are on the ");
  more.append(link("/pairings/", "Pairings"), " page.");
  section.append(more);
  return section;
}

function pairingsSection(t, ti) {
  const section = document.createElement("section");
  section.append(heading(2, t.name));
  const name = namer(t);
  if (t.format === "arena") return arenaPairings(section, t, name);
  if (!t.rounds.length) {
    section.append(paragraph("Round 1 hasn't been posted yet."));
    return section;
  }
  const { parts, several } = partsOf(t);
  const kind = (points) => points === 1 ? "full-point bye" : points === 0.5 ? "half-point bye" : "not playing";
  const of = t.plannedRounds ? ` of ${t.plannedRounds}` : "";
  parts.forEach((s, si) => {
    if (several) section.append(heading(3, s.name));
    const rounds = s.rounds.map((_, i) => [i + 1, `${i + 1}${of}`]);
    const draw = (n) => {
      const round = s.rounds[n - 1];
      const shown = [tableOf(["Board", "White", "Black", "Result"],
        round.games.map((g) => [g.board, name(g.white), name(g.black), SHOWN[g.result] || ""]))];
      if (round.byes.length) shown.push(paragraph(`Byes: ${round.byes.map((b) => `${name(b.id)}, ${kind(b.points)}`).join("; ")}.`));
      return shown;
    };
    section.append(...roundMenu(`round-${ti}-${si}`, "Round", several ? s.name : "", rounds, rounds.length, draw));
  });
  return section;
}

/** Quad head-to-head counts only between players tied on score and Sonneborn-Berger. */
function headToHead(r, rows) {
  return rows.some((x) => x !== r && x.score === r.score && x.sonnebornBerger === r.sonnebornBerger) ? r.headToHead : "";
}

function standingsSection(t, ti) {
  const section = document.createElement("section");
  section.append(heading(2, t.name));
  if (t.format === "arena") return arenaStandings(section, t);
  const quad = t.format === "quad";
  const { parts, several } = partsOf(t);
  const scored = (round) => round.games.some((g) => g.result) || (!round.games.length && round.byes.length);
  if (!parts.some((s) => s.rounds.some(scored))) {
    section.append(paragraph("Standings appear here once round 1 has results."));
    return section;
  }
  section.append(paragraph(quad
    ? "Each quad is ranked by score, then Sonneborn-Berger, then the games between tied players (34F). Players tied on all three share a place."
    : "Ties are broken in the US Chess default order (34E): modified median, Solkoff, cumulative, and cumulative of opposition."));
  parts.forEach((s, si) => {
    if (several) section.append(heading(3, s.name));
    const rounds = s.rounds.map((round, i) => [i + 1, round]).filter(([, round]) => scored(round))
      .map(([n, round]) => [n, `${n}${round.games.every((g) => g.result) ? "" : " (in progress)"}`]);
    if (!rounds.length) {
      section.append(paragraph("No results yet."));
      return;
    }
    const draw = (n) => {
      const sofar = { players: s.players, rounds: s.rounds.slice(0, n) };
      if (quad) {
        const rows = Pairing.quadStandings(sofar);
        return [tableOf(["Place", "Name", "Rating", "Score", "Sonneborn-Berger", "Head-to-head"],
          rows.map((r) => [r.place, r.name, r.rating ?? "Unrated", r.score, r.sonnebornBerger, headToHead(r, rows)]))];
      }
      return [tableOf(["Place", "Name", "Rating", "Score", "Median", "Solkoff", "Cumulative", "Opp. cumulative"],
        Pairing.standings(sofar).map((r, i) => [i + 1, r.name, r.rating ?? "Unrated", r.score, r.median, r.solkoff, r.cumulative, r.opposition]))];
    };
    section.append(...roundMenu(`after-${ti}-${si}`, "After round", several ? s.name : "", rounds, rounds.at(-1)[0], draw));
  });
  return section;
}

const onStandings = Boolean(standingsAll);
if (!ENDPOINT) {
  pairingsStatus.textContent = `${onStandings ? "Standings" : "Pairings"} will be posted here once tournaments are run online.`;
} else {
  fetch(`${ENDPOINT}?tournaments=current`)
    .then((response) => response.json())
    .then(({ tournaments = [] }) => {
      pairingsStatus.textContent = tournaments.length ? "" : onStandings
        ? "No tournament is in progress. Standings appear here as results come in."
        : "No tournament is in progress. Pairings appear here as each round is posted.";
      (standingsAll || pairingsAll).replaceChildren(...tournaments.map(onStandings ? standingsSection : pairingsSection));
    })
    .catch(() => { pairingsStatus.textContent = `The ${onStandings ? "standings" : "pairings"} couldn't be loaded. Try again later.`; });
}