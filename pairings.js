// The Pairings page (pairings/): each tournament in progress, with its latest posted round and
// the standings, from the registration script's ?tournaments=current. ENDPOINT comes from
// register.js and Pairing from pairing.js.

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

function tournamentSection(t) {
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = t.name;
  section.append(heading);
  const name = (id) => {
    const p = t.players.find((x) => x.id === id);
    return p ? `${p.name} (${p.rating ?? "unrated"})` : id;
  };
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
  if (t.format === "quad") {
    const rows = Pairing.quadStandings({ players: t.players, rounds: t.rounds });
    section.append(standingsHeading, tableOf(["Quad", "Place", "Name", "Rating", "Score", "Sonneborn-Berger"],
      rows.map((r) => [r.group, r.place, r.name, r.rating ?? "Unrated", r.score, r.sonnebornBerger])));
    return section;
  }
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
