// The TD desk's Run the tournament section: start a tournament for the chosen event, check in
// players, pair each round with pairing.js, review and post it, enter results, and follow the
// standings. The script keeps everything in the Tournaments in progress spreadsheet.
// call, choice, and choices come from td.js.

const runStatus = document.querySelector(".run-status");
const runStart = document.querySelector(".run-start");
const runRound = document.querySelector(".run-round");
const runTitle = document.querySelector(".run-round-title");
const runCheckin = document.querySelector(".run-checkin");
const runAttendance = document.querySelector(".run-attendance");
const runPairings = document.querySelector(".run-pairings");
const runGames = document.querySelector(".run-games");
const runByes = document.querySelector(".run-byes");
const runNotes = document.querySelector(".run-notes");
const runEditButtons = document.querySelector(".run-edit-buttons");
const runStandingsWrap = document.querySelector(".run-standings-wrap");
const runStandings = document.querySelector(".run-standings");
const RESULTS = [["", "No result"], ["1-0", "1–0"], ["0-1", "0–1"], ["1/2-1/2", "½–½"],
  ["1F-0F", "1F–0F (black forfeits)"], ["0F-1F", "0F–1F (white forfeits)"], ["0F-0F", "0F–0F (both forfeit)"]];
let current = null;
let draft = null;

const keyParts = () => choice.value.split("/");
const nameOf = (id) => {
  const p = current?.players.find((x) => x.id === id);
  return p ? `${p.name} (${p.rating ?? "unrated"})` : id;
};

function forEngine(t) {
  return {
    players: t.players.map((p) => ({ id: p.id, name: p.name, rating: p.rating, number: p.number })),
    rounds: t.rounds.map((r) => ({ games: r.games, byes: r.byes, out: r.out })),
  };
}

function option(value, text, selected) {
  const o = new Option(text, value);
  o.selected = selected;
  return o;
}

async function loadRun() {
  const key = choice.value;
  current = null;
  draft = null;
  if (!key) return;
  runStatus.textContent = "Loading the tournament…";
  const [event, date] = keyParts();
  try {
    const { tournament } = await call("tournament", { event, date });
    if (choice.value !== key) return;
    current = tournament;
    renderRun();
  } catch {
    runStatus.textContent = "The tournament couldn't be loaded. Try again.";
  }
}

function renderRun() {
  runStart.hidden = runRound.hidden = runStandingsWrap.hidden = true;
  if (!current) {
    const selectedChoice = choices.find((c) => c.key === choice.value);
    if (selectedChoice?.kind === "night") {
      runStatus.textContent = "A club night's Swiss runs for the whole month. Choose the month to start or run it.";
      return;
    }
    runStatus.textContent = "Not started. Starting adds everyone registered; later entrants can be added before any round.";
    if (selectedChoice?.kind === "month") {
      const nights = choices.filter((c) => c.key.startsWith(`${choice.value}-`)).length;
      runStart.elements.rounds.value = nights || "";
    }
    if (selectedChoice?.format) runStart.elements.format.value = selectedChoice.format;
    showRoundsField();
    runStart.hidden = false;
    return;
  }
  const t = current;
  const active = t.players.filter((p) => !p.out);
  const last = t.rounds.at(-1);
  const complete = (r) => r.games.every((g) => g.result);
  runStatus.textContent = `${t.name}: ${t.players.length} players, ${t.rounds.length} of ${t.plannedRounds || "?"} rounds paired.`
    + (t.status === "finished" ? " Finished." : "");
  if (t.format === "arena") {
    runStatus.textContent += " Arena pairing isn't on the desk yet.";
    return;
  }
  runStandingsWrap.hidden = !t.rounds.length;
  renderStandings();
  if (t.status === "finished") return;
  runRound.hidden = false;
  if (last && !last.posted) {
    draft = draft || { number: t.rounds.length, games: last.games, byes: last.byes, notes: [] };
    return renderDraft();
  }
  if (last && !complete(last)) {
    runTitle.textContent = `Round ${t.rounds.length}: results`;
    runCheckin.hidden = true;
    return renderResults(last, t.rounds.length);
  }
  if (draft) return renderDraft();
  const next = t.rounds.length + 1;
  if (t.plannedRounds && next > t.plannedRounds) {
    runRound.hidden = true;
    runStatus.textContent += " All rounds are played; finish the tournament when prizes are settled.";
    return;
  }
  runTitle.textContent = t.format === "quad" ? `Round ${next}` : `Round ${next}: check in`;
  runCheckin.hidden = false;
  runPairings.hidden = true;
  // A quad's pairings come from the table, so there is no one to check in; a no-show is a forfeit.
  runAttendance.closest(".td-table").hidden = runCheckin.querySelector("p").hidden = t.format === "quad";
  // Quads are numbered once, at the start, so later entrants can't be added.
  document.querySelector(".run-sync").hidden = t.format === "quad";
  const scores = new Map(Pairing.standings(forEngine(t)).map((r) => [r.id, r.score]));
  runAttendance.tBodies[0].replaceChildren(...active.map((p) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = p.number;
    row.insertCell().textContent = p.name;
    row.insertCell().textContent = p.rating ?? "Unrated";
    row.insertCell().textContent = scores.get(p.id) ?? 0;
    const select = document.createElement("select");
    select.dataset.id = p.id;
    select.setAttribute("aria-label", `${p.name} this round`);
    select.append(option("play", "Playing", true), option("half", "Half-point bye", false),
      option("absent", "Absent, zero-point bye", false), option("withdraw", "Withdraw from the tournament", false));
    row.insertCell().append(select);
    return row;
  }));
}

function renderDraft() {
  runTitle.textContent = `Round ${draft.number}: pairings to review`;
  runCheckin.hidden = true;
  runPairings.hidden = false;
  runEditButtons.hidden = false;
  const ids = [...draft.games.flatMap((g) => [g.white, g.black]), ...draft.byes.map((b) => b.id)];
  const playerSelect = (value, label) => {
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    for (const id of ids) select.append(option(id, nameOf(id), id === value));
    return select;
  };
  runGames.tBodies[0].replaceChildren(...draft.games.map((g, i) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = g.board;
    const white = playerSelect(g.white, `Board ${g.board} white`);
    const black = playerSelect(g.black, `Board ${g.board} black`);
    white.addEventListener("change", () => { draft.games[i].white = white.value; });
    black.addEventListener("change", () => { draft.games[i].black = black.value; });
    row.insertCell().append(white);
    row.insertCell().append(black);
    row.insertCell().textContent = "";
    return row;
  }));
  const label = (b) => `${nameOf(b.id)}, ${b.points === 1 ? "full-point bye" : b.points === 0.5 ? "half-point bye" : "zero-point bye"}`;
  runByes.textContent = draft.byes.length ? `Byes: ${draft.byes.map(label).join("; ")}.` : "No byes.";
  runNotes.replaceChildren(...(draft.notes || []).map((n) => Object.assign(document.createElement("li"), { textContent: n })));
}

function renderResults(round, number) {
  runPairings.hidden = false;
  runEditButtons.hidden = true;
  runGames.tBodies[0].replaceChildren(...round.games.map((g) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = g.board;
    row.insertCell().textContent = nameOf(g.white);
    row.insertCell().textContent = nameOf(g.black);
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Board ${g.board} result`);
    for (const [value, text] of RESULTS) select.append(option(value, text, value === (g.result || "")));
    select.addEventListener("change", async () => {
      const [event, date] = keyParts();
      select.disabled = true;
      const result = await call("result", { event, date, number, board: g.board, result: select.value });
      select.disabled = false;
      if (!result.ok) return void (runStatus.textContent = result.error);
      g.result = select.value;
      renderStandings();
      if (round.games.every((x) => x.result)) renderRun();
    });
    row.insertCell().append(select);
    return row;
  }));
  runByes.textContent = round.byes.length
    ? `Byes: ${round.byes.map((b) => `${nameOf(b.id)} (${b.points})`).join("; ")}.` : "No byes.";
  runNotes.replaceChildren();
}

const SWISS_HEADINGS = ["Place", "Name", "Rating", "Score", "Median", "Solkoff", "Cumulative", "Opp. cumulative"];
const QUAD_HEADINGS = ["Quad", "Place", "Name", "Rating", "Score", "Sonneborn-Berger"];

function renderStandings() {
  if (!current?.rounds.length) return;
  const quad = current.format === "quad";
  const headings = quad ? QUAD_HEADINGS : SWISS_HEADINGS;
  const head = runStandings.tHead.rows[0];
  [...head.cells].slice(0, -1).forEach((c) => c.remove());
  head.prepend(...headings.map((h) => Object.assign(document.createElement("th"), { scope: "col", textContent: h })));
  runStandingsWrap.querySelector(".register-hint").textContent = quad
    ? "Each quad is ranked by score, then Sonneborn-Berger, then the games between the tied players (34F)."
    : "Tiebreaks in the US Chess default order (34E): modified median, Solkoff, cumulative, cumulative of opposition.";
  const rows = quad ? Pairing.quadStandings(forEngine(current)) : Pairing.standings(forEngine(current));
  const next = current.rounds.length + 1;
  runStandings.tBodies[0].replaceChildren(...rows.map((r, i) => {
    const row = document.createElement("tr");
    const p = current.players.find((x) => x.id === r.id);
    const name = r.name + (p?.out ? ` (out from round ${p.out})` : "");
    const cells = quad ? [r.group, r.place, name, r.rating ?? "Unrated", r.score, r.sonnebornBerger]
      : [i + 1, name, r.rating ?? "Unrated", r.score, r.median, r.solkoff, r.cumulative, r.opposition];
    for (const text of cells) {
      row.insertCell().textContent = text;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "td-action";
    button.textContent = p?.out ? "Bring back" : "Withdraw";
    button.append(hidden(` ${r.name}`));
    button.addEventListener("click", async () => {
      if (!p?.out && !confirm(`Withdraw ${r.name} from round ${next} on? Their remaining rounds score zero (28P).`)) return;
      const [event, date] = keyParts();
      const result = await call("out", { event, date, id: r.id, from: p?.out ? "" : next });
      runStatus.textContent = result.message || result.error;
      loadRun();
    });
    row.insertCell().append(button);
    return row;
  }));
}

function showRoundsField() {
  const quad = runStart.elements.format.value === "quad";
  for (const el of [runStart.elements.rounds, runStart.querySelector('[for="run-rounds"]'), runStart.querySelector("#run-rounds-hint"),
    runStart.elements.coin, runStart.querySelector('[for="run-coin"]')]) el.hidden = quad;
}
runStart.elements.format.addEventListener("change", showRoundsField);

runStart.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [eventName, date] = keyParts();
  const fields = Object.fromEntries(new FormData(runStart));
  if (fields.format === "swiss" && !/^\d+$/.test(fields.rounds)) return void (runStatus.textContent = "How many rounds?");
  if (fields.format === "quad" && !confirm("Start the quads? Players are grouped by rating and numbered by lot now, so register everyone first.")) return;
  runStatus.textContent = "Starting…";
  const result = await call("start", { event: eventName, date, ...fields });
  runStatus.textContent = result.message || result.error;
  if (result.ok) loadRun();
});

document.querySelector(".run-sync").addEventListener("click", async () => {
  const [event, date] = keyParts();
  const result = await call("sync", { event, date });
  runStatus.textContent = result.message || result.error;
  loadRun();
});

document.querySelector(".run-pair").addEventListener("click", async () => {
  const number = current.rounds.length + 1;
  const choicesMade = [...runAttendance.querySelectorAll("select")].map((s) => [s.dataset.id, s.value]);
  const withdrawn = choicesMade.filter(([, v]) => v === "withdraw").map(([id]) => id);
  const [event, date] = keyParts();
  for (const id of withdrawn) await call("out", { event, date, id, from: number });
  const result = current.format === "quad" ? Pairing.pairQuadRound(forEngine(current).players, number)
    : Pairing.pairRound(forEngine(current), {
      halfByes: choicesMade.filter(([, v]) => v === "half").map(([id]) => id),
      absent: choicesMade.filter(([, v]) => v === "absent").map(([id]) => id),
      out: withdrawn,
      coin: current.coin,
    });
  draft = { number, ...result };
  if (withdrawn.length) current.players.forEach((p) => { if (withdrawn.includes(p.id)) p.out = number; });
  renderDraft();
});

document.querySelector(".run-repair").addEventListener("click", () => {
  draft = null;
  if (current.rounds.at(-1) && !current.rounds.at(-1).posted) current.rounds.pop();
  renderRun();
});

async function saveDraft(post) {
  const seen = new Set();
  for (const id of [...draft.games.flatMap((g) => [g.white, g.black]), ...draft.byes.map((b) => b.id)]) {
    if (seen.has(id)) return void (runStatus.textContent = `${nameOf(id)} is in the pairings twice.`);
    seen.add(id);
  }
  const [event, date] = keyParts();
  const result = await call("round", { event, date, number: draft.number, post: post ? "yes" : "no",
    games: JSON.stringify(draft.games), byes: JSON.stringify(draft.byes) });
  runStatus.textContent = result.message || result.error;
  if (result.ok) {
    draft = null;
    loadRun();
  }
}

document.querySelector(".run-post").addEventListener("click", () => saveDraft(true));
document.querySelector(".run-save").addEventListener("click", () => saveDraft(false));

document.querySelector(".run-finish").addEventListener("click", async () => {
  if (!confirm("Finish the tournament? Results can't be changed on the desk afterward.")) return;
  const [event, date] = keyParts();
  const result = await call("finish", { event, date });
  runStatus.textContent = result.message || result.error;
  loadRun();
});

document.addEventListener("td-choice", loadRun);
