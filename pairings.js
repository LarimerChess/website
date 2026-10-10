// The Pairings page (pairings/): each tournament in progress, with its latest posted round and
// the standings, or for an arena its games and leaderboard, from the registration script's
// ?tournaments=current. ENDPOINT comes from register.js, Pairing from pairing.js, and Arena from arena.js.

const pairingsStatus = document.querySelector(".pairings-status");
const pairingsAll = document.querySelector(".pairings-all");
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
const subheading = (text) => Object.assign(document.createElement("h3"), { textContent: text });

/** "17:30" as "5:30 PM". */
function clock(time) {
  const [h, m] = time.split(":").map(Number);
  return `${(h + 11) % 12 + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const RECENT = 12;

function arenaSection(section, t, name) {
  if (t.cutoff && t.status !== "finished") section.append(paragraph(`No new games start after ${clock(t.cutoff)}.`));
  const playing = t.games.filter((g) => !g.result);
  const pact = (g, side) => name(g[side]) + (g[`${side}Pact`] ? ", Blood Pact" : "");
  if (playing.length) {
    section.append(subheading("Games in progress"),
      tableOf(["Game", "White", "Black"], playing.map((g) => [g.game, pact(g, "white"), pact(g, "black")])));
  } else if (t.status !== "finished") {
    section.append(paragraph("No games in progress."));
  }
  const waiting = Arena.waiting(t);
  if (waiting.length && t.status !== "finished") section.append(paragraph(`Waiting for a game: ${waiting.map(name).join(", ")}.`));
  const rows = Arena.standings(t);
  section.append(subheading(t.status === "finished" ? "Final leaderboard" : "Leaderboard"),
    paragraph("Players with equal points share a place."),
    tableOf(["Place", "Name", "Rating", "Points", "Games", "Wins in a row"], rows.map((r) => [
      `${r.place}${r.tied ? " (tied)" : ""}`, r.name, r.rating ?? "Unrated", r.points, r.games,
      `${r.streak}${r.streak >= 2 ? " (Possessed)" : ""}`])));
  const done = t.games.filter((g) => g.result).reverse().slice(0, RECENT);
  if (done.length) {
    section.append(subheading("Recent results"),
      tableOf(["Game", "White", "Black", "Result"], done.map((g) => [g.game, pact(g, "white"), pact(g, "black"), SHOWN[g.result] || ""])));
  }
  return section;
}

function tournamentSection(t) {
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = t.name;
  section.append(heading);
  const name = (id) => {
    const p = t.players.find((x) => x.id === id);
    return p ? `${p.name} (${p.rating ?? "unrated"})` : id;
  };
  if (t.format === "arena") return arenaSection(section, t, name);
  const last = t.rounds.at(-1);
  if (!last) {
    section.append(Object.assign(document.createElement("p"), { textContent: "Round 1 hasn't been posted yet." }));
    return section;
  }
  const roundHeading = document.createElement("h3");
  roundHeading.textContent = `Round ${t.rounds.length}${t.plannedRounds ? ` of ${t.plannedRounds}` : ""}`;
  section.append(roundHeading,
    tableOf(["Board", "White", "Black", "Result"], last.games.map((g) => [g.board, name(g.white), name(g.black), SHOWN[g.result] || ""])));
  if (last.byes.length) {
    const kind = (points) => points === 1 ? "full-point bye" : points === 0.5 ? "half-point bye" : "not playing";
    section.append(Object.assign(document.createElement("p"), {
      textContent: `Byes: ${last.byes.map((b) => `${name(b.id)}, ${kind(b.points)}`).join("; ")}.` }));
  }
  const standingsHeading = document.createElement("h3");
  standingsHeading.textContent = t.status === "finished" ? "Final standings" : "Standings";
  const rows = Pairing.standings({ players: t.players, rounds: t.rounds });
  section.append(standingsHeading, tableOf(["Place", "Name", "Rating", "Score", "Median", "Solkoff", "Cumulative"],
    rows.map((r, i) => [i + 1, r.name, r.rating ?? "Unrated", r.score, r.median, r.solkoff, r.cumulative])));
  return section;
}

if (!ENDPOINT) {
  pairingsStatus.textContent = "Pairings will be posted here once tournaments are run online.";
} else {
  fetch(`${ENDPOINT}?tournaments=current`)
    .then((response) => response.json())
    .then(({ tournaments = [] }) => {
      pairingsStatus.textContent = tournaments.length ? "" : "No tournament is in progress. Pairings appear here as each round is posted.";
      pairingsAll.replaceChildren(...tournaments.map(tournamentSection));
    })
    .catch(() => { pairingsStatus.textContent = "The pairings couldn't be loaded. Try again later."; });
}
