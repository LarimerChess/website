// The TD desk's Run the tournament section: start a tournament for the chosen event, check in
// players, pair each round with pairing.js and review and post it, enter results, and follow the
// standings. The script keeps everything in the Tournaments in progress spreadsheet. An arena is
// run by td-arena.js. call, choice, and choices come from td.js.
//
// A tournament's sections play each round together: one check-in, one Pair button that pairs
// every section on its own, one review, and one Post, with each section in its own tables.

const runStatus = document.querySelector(".run-status");
const runStart = document.querySelector(".run-start");
const runRound = document.querySelector(".run-round");
const runTitle = document.querySelector(".run-round-title");
const runCheckin = document.querySelector(".run-checkin");
const runCheckinHint = document.querySelector(".run-checkin-hint");
const runAttendance = document.querySelector(".run-attendance-all");
const runSectionsEdit = document.querySelector(".run-sections-edit");
const runPairings = document.querySelector(".run-pairings");
const runGames = document.querySelector(".run-games-all");
const runEditButtons = document.querySelector(".run-edit-buttons");
const runStandingsWrap = document.querySelector(".run-standings-wrap");
const runStandingsHint = document.querySelector(".run-standings-hint");
const runStandings = document.querySelector(".run-standings-all");
const runArena = document.querySelector(".run-arena");
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
    format: t.format, sections: t.sections || [],
    players: t.players.map((p) => ({ id: p.id, name: p.name, rating: p.rating, number: p.number, section: p.section || "" })),
    rounds: t.rounds.map((r) => ({ games: r.games, byes: r.byes, out: r.out })),
  };
}

function option(value, text, selected) {
  const o = new Option(text, value);
  o.selected = selected;
  return o;
}

/** A table for a section, under the section's name when there is more than one. */
function sectionTable(className, headings, rows, name, several) {
  const table = document.createElement("table");
  table.className = `entries ${className}`;
  const head = table.createTHead().insertRow();
  for (const h of headings) {
    const th = document.createElement("th");
    th.scope = "col";
    if (h instanceof Node) th.append(h);
    else th.textContent = h;
    head.append(th);
  }
  table.createTBody().append(...rows);
  const wrap = document.createElement("div");
  wrap.className = "td-table";
  wrap.append(table);
  return several ? [Object.assign(document.createElement("h4"), { textContent: name }), wrap] : [wrap];
}

// The sections editor, in the start form and before round 1.
let sectionRow = 0;
function addSectionRow(rows, section = {}) {
  const n = ++sectionRow;
  const row = document.createElement("div");
  row.className = "run-section-row";
  const field = (label, id, value, attributes) => {
    const box = document.createElement("div");
    const input = Object.assign(document.createElement("input"), { id, type: "text", value: value ?? "", autocomplete: "off", ...attributes });
    box.append(Object.assign(document.createElement("label"), { htmlFor: id, textContent: label }), input);
    return box;
  };
  const remove = Object.assign(document.createElement("button"), { type: "button", className: "td-action", textContent: "Remove" });
  remove.append(hidden(` section ${rows.children.length + 1}`));
  remove.addEventListener("click", () => {
    if (rows.children.length > 1) row.remove();
  });
  row.append(field("Section", `run-section-name-${n}`, section.name, { maxLength: 30, className: "run-section-name" }),
    field("Rated under", `run-section-under-${n}`, section.under, { inputMode: "numeric", maxLength: 4, className: "run-section-under" }),
    remove);
  rows.append(row);
}

function fillSections(fieldset, defs) {
  const rows = fieldset.querySelector(".run-section-rows");
  rows.replaceChildren();
  for (const s of defs.length ? defs : [{ name: "Open" }]) addSectionRow(rows, s);
}

/** The sections typed in, or an error. */
function readSections(fieldset) {
  const list = [...fieldset.querySelectorAll(".run-section-row")].map((row) => ({
    name: row.querySelector(".run-section-name").value.trim(), under: row.querySelector(".run-section-under").value.trim() }));
  if (list.some((s) => !s.name)) return { error: "Name every section, or remove it." };
  if (list.some((s) => s.under && !/^\d{3,4}$/.test(s.under))) return { error: "A section's limit is a rating, such as 1400, or empty for none." };
  return { sections: list.map((s) => (s.under ? { name: s.name, under: Number(s.under) } : { name: s.name })) };
}

for (const fieldset of document.querySelectorAll(".run-sections")) {
  fillSections(fieldset, []);
  fieldset.querySelector(".run-section-add").addEventListener("click", () => {
    addSectionRow(fieldset.querySelector(".run-section-rows"));
    fieldset.querySelector(".run-section-row:last-child input").focus();
  });
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
  runStart.hidden = runRound.hidden = runStandingsWrap.hidden = runArena.hidden = true;
  const selectedChoice = choices.find((c) => c.key === choice.value);
  if (!current) {
    if (selectedChoice?.kind === "night") {
      runStatus.textContent = "A club night's Swiss runs for the whole month. Choose the month to start or run it.";
      return;
    }
    runStatus.textContent = "Not started. Starting adds everyone registered; later entrants can be added before any round.";
    if (selectedChoice?.kind === "month") {
      const nights = choices.filter((c) => c.key.startsWith(`${choice.value}-`)).length;
      runStart.elements.rounds.value = nights || "";
    } else {
      runStart.elements.rounds.value = selectedChoice?.rounds || "";
    }
    // An event whose calendar settings say how it's run starts that way; otherwise the TD chooses.
    const formatMenu = runStart.elements.format;
    const set = runStart.querySelector(".run-format-set");
    const fixed = Boolean(selectedChoice?.format);
    if (fixed) {
      formatMenu.value = selectedChoice.format;
      set.textContent = `Format: ${formatMenu.selectedOptions[0].textContent}, set by the event.`;
    }
    formatMenu.hidden = runStart.querySelector('[for="run-format"]').hidden = fixed;
    set.hidden = !fixed;
    showFormatFields();
    runStart.hidden = false;
    return;
  }
  const t = current;
  const last = t.rounds.at(-1);
  const complete = (r) => r.games.every((g) => g.result);
  if (t.format === "arena") return renderArena();
  const parts = Pairing.sections(forEngine(t));
  runStatus.textContent = `${t.name}: ${t.players.length} players, ${t.rounds.length} of ${t.plannedRounds || "?"} rounds paired.`
    + (parts.length > 1 ? ` Sections: ${parts.map((s) => `${s.name} (${s.players.length})`).join(", ")}.` : "")
    + (t.status === "finished" ? " Finished." : "");
  runStandingsWrap.hidden = !t.rounds.length;
  renderStandings();
  if (t.rounds.length) renderByesAll();
  if (t.status === "finished") return;
  runRound.hidden = false;
  if (last && !last.posted) {
    draft = draft || { number: t.rounds.length, sections: parts.map((s) => ({ section: s.key, name: s.name,
      games: s.rounds.at(-1).games, byes: s.rounds.at(-1).byes, notes: [] })).filter((s) => s.games.length || s.byes.length) };
    return renderDraft();
  }
  if (last && !complete(last)) {
    runTitle.textContent = `Round ${t.rounds.length}: results`;
    runCheckin.hidden = true;
    return renderResults(t.rounds.length);
  }
  if (draft) return renderDraft();
  const next = t.rounds.length + 1;
  if (t.plannedRounds && next > t.plannedRounds) {
    runRound.hidden = true;
    runStatus.textContent += " All rounds are played; finish the tournament when prizes are settled.";
    return;
  }
  renderCheckin(t, parts, next);
}

function renderCheckin(t, parts, next) {
  const quad = t.format === "quad";
  runTitle.textContent = `Round ${next}: check in`;
  runCheckin.hidden = false;
  runPairings.hidden = true;
  // A quad's pairings come from the table, so a player not here loses that game by forfeit.
  runCheckinHint.textContent = quad
    ? "Everyone starts as Present; change anyone who isn't here. The quad table fixes the pairings, so a player not here loses that round's game by forfeit."
    : "Everyone starts as Present; change anyone who isn't here. Anyone else's round is unplayed, unless they asked for a half-point bye (22C) or a zero-point bye. A round can be reclassified later, under Standings.";
  // Quads are numbered once, at the start, so later entrants can't be added.
  document.querySelector(".run-sync").hidden = quad;
  // Sections are set until round 1 is posted (a player plays in one section).
  const editable = !quad && next === 1;
  runSectionsEdit.hidden = !editable;
  if (editable && !runSectionsEdit.open) fillSections(runSectionsEdit.querySelector(".run-sections"), t.sections || []);
  const defs = t.sections || [];
  const choosing = editable && defs.length > 1;
  const several = parts.length > 1;
  const scores = new Map(parts.flatMap((s) => Pairing.standings(s).map((r) => [r.id, r.score])));
  runAttendance.replaceChildren(...parts.filter((s) => s.players.length).flatMap((s) => {
    const rows = s.players.filter((p) => !p.out).map((p) => {
      const row = document.createElement("tr");
      row.insertCell().textContent = p.number;
      row.insertCell().textContent = p.name;
      row.insertCell().textContent = p.rating ?? "Unrated";
      row.insertCell().textContent = scores.get(p.id) ?? 0;
      if (choosing) {
        const move = document.createElement("select");
        move.setAttribute("aria-label", `${p.name}'s section`);
        for (const d of defs) if (Pairing.mayEnter(d, p.rating) || d.name === s.name) move.append(option(d.name, d.name, d.name === s.name));
        move.addEventListener("change", () => moveTo(p, move.value));
        row.insertCell().append(move);
      }
      const select = document.createElement("select");
      select.dataset.id = p.id;
      select.className = "run-this-round";
      select.setAttribute("aria-label", `${p.name} this round`);
      select.append(option("play", "Present", true),
        option("absent", quad ? "Not here: loses by forfeit" : "Not here: unplayed", false),
        ...(quad ? [] : [option("half", "Half-point bye (asked for)", false), option("zero", "Zero-point bye (asked for)", false)]),
        option("withdraw", "Withdraw from the tournament", false));
      row.insertCell().append(select);
      return row;
    });
    return sectionTable("run-attendance", ["No.", "Name", "Rating", "Score", ...(choosing ? ["Section"] : []), "This round"],
      rows, `${s.name} (${rows.length})`, several);
  }));
}

async function moveTo(p, section) {
  const [event, date] = keyParts();
  runStatus.textContent = `Moving ${p.name}…`;
  const result = await call("section", { event, date, id: p.id, section });
  runStatus.textContent = result.message || result.error;
  draft = null;
  loadRun();
}

function renderDraft() {
  runTitle.textContent = `Round ${draft.number}: pairings to review`;
  runCheckin.hidden = true;
  runPairings.hidden = false;
  runEditButtons.hidden = false;
  const several = draft.sections.length > 1;
  runGames.replaceChildren(...draft.sections.flatMap((s) => {
    const ids = [...s.games.flatMap((g) => [g.white, g.black]), ...s.byes.map((b) => b.id)];
    const playerSelect = (value, label) => {
      const select = document.createElement("select");
      select.setAttribute("aria-label", label);
      for (const id of ids) select.append(option(id, nameOf(id), id === value));
      return select;
    };
    const where = several ? `${s.name} board` : "Board";
    const rows = s.games.map((g) => {
      const row = document.createElement("tr");
      row.insertCell().textContent = g.board;
      const white = playerSelect(g.white, `${where} ${g.board} white`);
      const black = playerSelect(g.black, `${where} ${g.board} black`);
      white.addEventListener("change", () => { g.white = white.value; });
      black.addEventListener("change", () => { g.black = black.value; });
      row.insertCell().append(white);
      row.insertCell().append(black);
      row.insertCell().textContent = (RESULTS.find(([v]) => v === g.result) || ["", ""])[1].replace("No result", "");
      return row;
    });
    const label = (b) => `${nameOf(b.id)}, ${BYE_LABELS[Pairing.byeKind(b)].toLowerCase()}`;
    const byes = Object.assign(document.createElement("p"), { textContent: s.byes.length
      ? `Without a game: ${s.byes.map(label).join("; ")}.` : "Everyone has a game." });
    const notes = document.createElement("ul");
    notes.append(...(s.notes || []).map((n) => Object.assign(document.createElement("li"), { textContent: n })));
    return [...sectionTable("run-games", ["Board", "White", "Black", "Result"], rows, s.name, several), byes, ...(notes.children.length ? [notes] : [])];
  }));
}

function renderResults(number) {
  runPairings.hidden = false;
  runEditButtons.hidden = true;
  const parts = Pairing.sections(forEngine(current));
  const several = parts.length > 1;
  const round = current.rounds[number - 1];
  runGames.replaceChildren(...parts.filter((s) => s.players.length).flatMap((s) => {
    const here = s.rounds[number - 1];
    const rows = here.games.map((g) => {
      const row = document.createElement("tr");
      row.insertCell().textContent = g.board;
      row.insertCell().textContent = nameOf(g.white);
      row.insertCell().textContent = nameOf(g.black);
      const select = document.createElement("select");
      select.setAttribute("aria-label", `${several ? `${s.name} board` : "Board"} ${g.board} result`);
      for (const [value, text] of RESULTS) select.append(option(value, text, value === (g.result || "")));
      select.addEventListener("change", async () => {
        const [event, date] = keyParts();
        select.disabled = true;
        const result = await call("result", { event, date, number, board: g.board, section: g.section ?? s.key, result: select.value });
        select.disabled = false;
        if (!result.ok) return void (runStatus.textContent = result.error);
        g.result = select.value;
        renderStandings();
        if (round.games.every((x) => x.result)) renderRun();
      });
      row.insertCell().append(select);
      return row;
    });
    const byes = Object.assign(document.createElement("p"), { textContent: here.byes.length
      ? `Without a game: ${here.byes.map((b) => `${nameOf(b.id)}, ${BYE_LABELS[Pairing.byeKind(b)].toLowerCase()}`).join("; ")}.`
      : "Everyone has a game." });
    return [...sectionTable("run-games", ["Board", "White", "Black", "Result"], rows, s.name, several), byes];
  }));
}

const BYE_LABELS = { bye: "Full-point bye (1)", half: "Half-point bye (½)", zero: "Zero-point bye (0)", unplayed: "Unplayed (0)" };

/** Every round without a game, each with a menu to reclassify it (saved as soon as it changes). */
function renderByesAll() {
  const box = document.querySelector(".run-byes-all");
  const rows = current.rounds.flatMap((r, i) => r.byes.map((b) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = i + 1;
    row.insertCell().textContent = nameOf(b.id);
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${nameOf(b.id)}, round ${i + 1}`);
    const kind = Pairing.byeKind(b);
    for (const [value, text] of Object.entries(BYE_LABELS)) select.append(option(value, text, value === kind));
    select.addEventListener("change", async () => {
      const [event, date] = keyParts();
      select.disabled = true;
      const result = await call("byeKind", { event, date, number: i + 1, id: b.id, kind: select.value });
      select.disabled = false;
      if (!result.ok) {
        select.value = kind;
        return void (runStatus.textContent = result.error);
      }
      b.kind = select.value;
      b.points = Pairing.BYE_KINDS[select.value];
      runStatus.textContent = `${nameOf(b.id)}, round ${i + 1}: ${BYE_LABELS[select.value]}.`;
      renderStandings();
    });
    row.insertCell().append(select);
    return row;
  }));
  box.replaceChildren(...(rows.length ? sectionTable("run-byes-table", ["Round", "Player", "Kind"], rows, "Byes and unplayed rounds", false)
    : [Object.assign(document.createElement("p"), { textContent: "None yet." })]));
}

const SWISS_HEADINGS = ["Place", "Name", "Rating", "Score", "Median", "Solkoff", "Cumulative", "Opp. cumulative"];
const QUAD_HEADINGS = ["Place", "Name", "Rating", "Score", "Sonneborn-Berger"];

function renderStandings() {
  if (!current?.rounds.length) return;
  const quad = current.format === "quad";
  runStandingsHint.textContent = quad
    ? "Each quad is ranked by score, then Sonneborn-Berger, then the games between the tied players (34F)."
    : "Tiebreaks in the US Chess default order (34E): modified median, Solkoff, cumulative, cumulative of opposition.";
  const next = current.rounds.length + 1;
  const parts = Pairing.sections(forEngine(current)).filter((s) => s.players.length);
  runStandings.replaceChildren(...parts.flatMap((s) => {
    const rows = (quad ? Pairing.quadStandings(s) : Pairing.standings(s)).map((r, i) => {
      const row = document.createElement("tr");
      const p = current.players.find((x) => x.id === r.id);
      const name = r.name + (p?.out ? ` (out from round ${p.out})` : "");
      const cells = quad ? [r.place, name, r.rating ?? "Unrated", r.score, r.sonnebornBerger]
        : [i + 1, name, r.rating ?? "Unrated", r.score, r.median, r.solkoff, r.cumulative, r.opposition];
      for (const text of cells) row.insertCell().textContent = text;
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
    });
    return sectionTable("run-standings", [...(quad ? QUAD_HEADINGS : SWISS_HEADINGS), hidden("Withdraw")], rows, s.name, parts.length > 1);
  }));
}

function showFormatFields() {
  for (const field of runStart.querySelectorAll("[data-format]")) field.hidden = field.dataset.format !== runStart.elements.format.value;
}
runStart.elements.format.addEventListener("change", showFormatFields);

runStart.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [eventName, date] = keyParts();
  const fields = Object.fromEntries(new FormData(runStart));
  if (fields.format === "swiss" && !/^\d+$/.test(fields.rounds)) return void (runStatus.textContent = "How many rounds?");
  if (fields.format === "swiss") {
    const defined = readSections(runStart.querySelector(".run-sections"));
    if (defined.error) return void (runStatus.textContent = defined.error);
    fields.sections = JSON.stringify(defined.sections);
  }
  if (fields.format === "quad" && !confirm("Start the quads? Players are grouped by rating and numbered by lot now, so register everyone first.")) return;
  if (fields.format === "arena" && !/^\d\d:\d\d$/.test(fields.cutoff)) return void (runStatus.textContent = "No new games after what time?");
  runStatus.textContent = "Starting…";
  const result = await call("start", { event: eventName, date, ...fields });
  runStatus.textContent = result.message || result.error;
  if (result.ok) loadRun();
});

document.querySelector(".run-sections-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const defined = readSections(event.target.querySelector(".run-sections"));
  if (defined.error) return void (runStatus.textContent = defined.error);
  if (!confirm("Save the sections? Everyone is placed by rating again, undoing any moves.")) return;
  const [eventName, date] = keyParts();
  const result = await call("sections", { event: eventName, date, sections: JSON.stringify(defined.sections) });
  runStatus.textContent = result.message || result.error;
  if (result.ok) {
    runSectionsEdit.open = false;
    loadRun();
  }
});

document.querySelector(".run-sync").addEventListener("click", async () => {
  const [event, date] = keyParts();
  const result = await call("sync", { event, date });
  runStatus.textContent = result.message || result.error;
  loadRun();
});

document.querySelector(".run-pair").addEventListener("click", async () => {
  const number = current.rounds.length + 1;
  const choicesMade = [...runAttendance.querySelectorAll(".run-this-round")].map((s) => [s.dataset.id, s.value]);
  if (!choicesMade.some(([, v]) => v === "play")) return void (runStatus.textContent = "Nobody is present to pair.");
  const withdrawn = choicesMade.filter(([, v]) => v === "withdraw").map(([id]) => id);
  const [event, date] = keyParts();
  for (const id of withdrawn) await call("out", { event, date, id, from: number });
  const sections = Pairing.pairSections(forEngine(current), {
    halfByes: choicesMade.filter(([, v]) => v === "half").map(([id]) => id),
    zeroByes: choicesMade.filter(([, v]) => v === "zero").map(([id]) => id),
    absent: choicesMade.filter(([, v]) => v === "absent").map(([id]) => id),
    out: withdrawn,
    coin: current.coin,
  });
  // A quad's table pairs absent players too; their games are forfeits.
  const away = new Set(choicesMade.filter(([, v]) => v === "absent").map(([id]) => id));
  if (current.format === "quad") {
    for (const s of sections) {
      for (const g of s.games) {
        if (away.has(g.white) || away.has(g.black)) g.result = away.has(g.white) ? (away.has(g.black) ? "0F-0F" : "0F-1F") : "1F-0F";
      }
      s.byes = s.byes.filter((b) => !away.has(b.id));
    }
  }
  draft = { number, sections };
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
  for (const s of draft.sections) {
    for (const id of [...s.games.flatMap((g) => [g.white, g.black]), ...s.byes.map((b) => b.id)]) {
      if (seen.has(id)) return void (runStatus.textContent = `${nameOf(id)} is in the pairings twice.`);
      seen.add(id);
    }
  }
  const games = draft.sections.flatMap((s) => s.games.map((g) => ({ board: g.board, white: g.white, black: g.black, section: s.section,
    result: g.result || "" })));
  const byes = draft.sections.flatMap((s) => s.byes.map((b) => ({ id: b.id, points: b.points, kind: Pairing.byeKind(b),
    section: s.section })));
  const [event, date] = keyParts();
  const result = await call("round", { event, date, number: draft.number, post: post ? "yes" : "no",
    games: JSON.stringify(games), byes: JSON.stringify(byes) });
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