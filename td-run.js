// The TD desk's Run the tournament section: start a tournament for the chosen event, check in
// players, pair each round with pairing.js or by hand, review, change, and post it (and change it
// again until it has results), enter results or confirm the ones players report, and follow the
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
const runPairingsHint = document.querySelector(".run-pairings-hint");
const runProblems = document.querySelector(".run-problems");
const runCancel = document.querySelector(".run-cancel");
const runResultButtons = document.querySelector(".run-result-buttons");
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
  if (last && !last.posted) draft = draft || draftFrom(t.rounds.length);
  if (draft) return renderDraft();
  if (last && !complete(last)) {
    runTitle.textContent = `Round ${t.rounds.length}: results`;
    runCheckin.hidden = true;
    return renderResults(t.rounds.length);
  }
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

// The draft editor. A draft is { number, posted, sections: [{ section, name, games, byes, waiting }] }:
// posted when it re-pairs a posted round, and waiting the players not yet paired. Choosing a
// player for a seat swaps them with whoever had it, so nobody is lost or doubled; removing a
// board leaves its players not yet paired, and Save and Post wait until everyone is placed.

/** A saved or posted round as a draft, copied, so nothing changes until it is saved. */
function draftFrom(number) {
  return { number, sections: Pairing.sections(forEngine(current)).filter((s) => s.players.length).map((s) => ({
    section: s.key, name: s.name, waiting: [],
    games: s.rounds[number - 1].games.map((g) => ({ board: g.board, white: g.white, black: g.black, result: g.result || "" })),
    byes: s.rounds[number - 1].byes.map((b) => ({ id: b.id, points: b.points, kind: b.kind })) })) };
}

const numberOf = (id) => current.players.find((p) => p.id === id)?.number ?? Infinity;
const isWithdrawn = (id) => {
  const out = current.players.find((p) => p.id === id)?.out;
  return Boolean(out && out <= draft.number);
};

/** The players of a draft's section who play this round, in number order. */
function activeIn(s) {
  const part = Pairing.sections(forEngine(current)).find((x) => x.name === s.name);
  return (part?.players || []).map((p) => p.id).filter((id) => !isWithdrawn(id));
}

function seat(s, id, g, side) {
  const old = g[side];
  if (id === old) return;
  const game = s.games.find((x) => x.white === id || x.black === id);
  const bye = s.byes.find((b) => b.id === id);
  const at = s.waiting.indexOf(id);
  if (game) game[game.white === id ? "white" : "black"] = old;
  else if (bye) bye.id = old;
  else if (at >= 0) s.waiting[at] = old;
  else s.waiting.push(old);
  g[side] = id;
}

function setKind(s, id, kind) {
  const bye = s.byes.find((b) => b.id === id);
  if (kind === "waiting") {
    s.byes = s.byes.filter((b) => b.id !== id);
    if (!s.waiting.includes(id)) s.waiting.push(id);
  } else if (bye) {
    Object.assign(bye, { kind, points: Pairing.BYE_KINDS[kind] });
  } else {
    s.waiting = s.waiting.filter((x) => x !== id);
    s.byes.push({ id, kind, points: Pairing.BYE_KINDS[kind] });
  }
}

/** Boards from 1 in each section; a tournament started before sections numbers on through its quads. */
function renumber() {
  let board = 0;
  for (const s of draft.sections) {
    const offset = s.section ? 0 : board;
    s.games.forEach((g, i) => { g.board = offset + i + 1; });
    board += s.games.length;
  }
}

/** What keeps the draft from being saved, in words for the TD. */
function draftProblems() {
  const problems = [];
  const seen = new Set();
  const several = draft.sections.length > 1;
  for (const s of draft.sections) {
    const where = several ? ` (${s.name})` : "";
    const active = activeIn(s);
    const placed = [...s.games.flatMap((g) => [g.white, g.black]), ...s.byes.map((b) => b.id)];
    for (const id of placed) {
      if (seen.has(id)) problems.push(`${nameOf(id)} is in the pairings twice.`);
      else if (!active.includes(id)) problems.push(`${nameOf(id)}${where} ${isWithdrawn(id) ? "is withdrawn" : "plays in another section"}; take them out of these pairings.`);
      seen.add(id);
    }
    for (const id of active) if (!placed.includes(id)) problems.push(`${nameOf(id)}${where} isn't paired yet: add a board for them, or choose a round without a game.`);
  }
  return [...new Set(problems)];
}

function editButton(text, hint, focus, onClick) {
  const button = Object.assign(document.createElement("button"), { type: "button", className: "td-action", textContent: text });
  button.append(hidden(hint));
  button.dataset.focus = focus;
  button.addEventListener("click", onClick);
  return button;
}

function labelled(text, control) {
  const field = document.createElement("span");
  field.className = "run-field";
  field.append(Object.assign(document.createElement("label"), { htmlFor: control.id, textContent: text }), control);
  return field;
}

/** Redraws, keeping the keyboard where it was: on the control with the same data-focus, else its
 *  data-focus-after (a Confirm button goes once its result is in), or on focus if given. */
function keepFocus(render, focus) {
  const { focus: key, focusAfter } = focus ? { focus } : document.activeElement?.dataset || {};
  render();
  const find = (k) => k && runGames.querySelector(`[data-focus="${CSS.escape(k)}"]`);
  (find(key) || find(focusAfter))?.focus();
}

function renderDraft() {
  runTitle.textContent = draft.posted ? `Round ${draft.number}: change the posted pairings` : `Round ${draft.number}: pairings to review`;
  runCheckin.hidden = true;
  runPairings.hidden = false;
  runEditButtons.hidden = false;
  runResultButtons.hidden = true;
  runCancel.hidden = !draft.posted;
  runPairingsHint.textContent = "Change any seat with its menu: the player you choose swaps places with the one there. The director is "
    + "responsible for the pairings (29E7). Save keeps them private; Post shows them on the Pairings page"
    + (draft.posted ? ", in place of the round posted, and clears any results players reported for it." : ".");
  const several = draft.sections.length > 1;
  runGames.replaceChildren(...draft.sections.flatMap((s, n) => editSection(s, n, several)));
  const problems = draftProblems();
  runProblems.hidden = !problems.length;
  runProblems.querySelector("ul").replaceChildren(...problems.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
}

function editSection(s, n, several) {
  s.waiting = s.waiting || [];
  const active = activeIn(s);
  const placed = new Set([...s.games.flatMap((g) => [g.white, g.black]), ...s.byes.map((b) => b.id), ...s.waiting]);
  for (const id of active) if (!placed.has(id)) s.waiting.push(id);
  const where = several ? `${s.name} board` : "Board";
  const key = (what) => `${n}|${what}`;
  const redraw = (focus) => keepFocus(renderDraft, focus);

  const seatMenu = (g, side) => {
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${where} ${g.board} ${side}`);
    select.dataset.focus = key(`${g.board}-${side}`);
    for (const id of new Set([g[side], ...active])) select.append(option(id, nameOf(id), id === g[side]));
    select.addEventListener("change", () => {
      seat(s, select.value, g, side);
      redraw();
    });
    return select;
  };
  const rows = s.games.map((g) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = g.board;
    row.insertCell().append(seatMenu(g, "white"));
    row.insertCell().append(seatMenu(g, "black"));
    const forfeit = document.createElement("select");
    forfeit.setAttribute("aria-label", `${where} ${g.board} forfeit`);
    forfeit.dataset.focus = key(`${g.board}-forfeit`);
    for (const [value, text] of RESULTS.filter(([v]) => !v || v.includes("F"))) forfeit.append(option(value, value ? text : "None", value === g.result));
    forfeit.addEventListener("change", () => { g.result = forfeit.value; });
    row.insertCell().append(forfeit);
    const buttons = document.createElement("div");
    buttons.className = "td-buttons";
    const which = ` on ${several ? `${s.name} board` : "board"} ${g.board}`;
    buttons.append(editButton("Swap colors", which, key(`${g.board}-swap`), () => {
      [g.white, g.black] = [g.black, g.white];
      g.result = { "1F-0F": "0F-1F", "0F-1F": "1F-0F" }[g.result] || g.result;
      redraw();
    }), editButton("Remove", ` ${several ? `${s.name} board` : "board"} ${g.board}`, key(`${g.board}-remove`), () => {
      s.games.splice(s.games.indexOf(g), 1);
      s.waiting.push(g.white, g.black);
      renumber();
      runStatus.textContent = `${where} ${g.board} is removed; ${nameOf(g.white)} and ${nameOf(g.black)} are not yet paired.`;
      redraw(key("add-white"));
    }));
    row.insertCell().append(buttons);
    return row;
  });
  const out = rows.length ? sectionTable("run-games", ["Board", "White", "Black", "Forfeit", hidden("Change")], rows, s.name, several)
    : [...(several ? [Object.assign(document.createElement("h4"), { textContent: s.name })] : []),
      Object.assign(document.createElement("p"), { textContent: "No boards yet." })];

  const off = [...s.byes.map((b) => b.id), ...s.waiting].sort((a, b) => numberOf(a) - numberOf(b));
  if (off.length) {
    const offRows = off.map((id) => {
      const row = document.createElement("tr");
      row.insertCell().textContent = nameOf(id);
      const bye = s.byes.find((b) => b.id === id);
      const now = bye ? Pairing.byeKind(bye) : "waiting";
      const kind = document.createElement("select");
      kind.setAttribute("aria-label", `${nameOf(id)} this round`);
      kind.dataset.focus = key(`kind-${id}`);
      kind.append(option("waiting", "Not yet paired", now === "waiting"),
        ...Object.entries(BYE_LABELS).map(([value, text]) => option(value, text, value === now)));
      kind.addEventListener("change", () => {
        setKind(s, id, kind.value);
        redraw();
      });
      row.insertCell().append(kind);
      if (!bye) row.className = "run-unpaired";
      return row;
    });
    out.push(Object.assign(document.createElement("p"), { className: "run-label", textContent: several ? `Without a game in ${s.name}` : "Without a game" }),
      ...sectionTable("run-off", ["Player", "This round"], offRows, "", false));
  } else {
    out.push(Object.assign(document.createElement("p"), { textContent: "Everyone has a game." }));
  }
  if (s.notes?.length) {
    const notes = document.createElement("ul");
    notes.append(...s.notes.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
    out.push(notes);
  }

  const tools = document.createElement("div");
  tools.className = "run-tools";
  const menu = (id, ids, label) => {
    const select = Object.assign(document.createElement("select"), { id });
    select.dataset.focus = key(label);
    for (const x of ids) select.append(option(x, nameOf(x), false));
    return select;
  };
  if (off.length >= 2) {
    const white = menu(`run-add-white-${n}`, off, "add-white");
    const black = menu(`run-add-black-${n}`, off, "add-black");
    black.selectedIndex = 1;
    const add = editButton("Add the board", several ? ` in ${s.name}` : "", key("add"), () => {
      if (white.value === black.value) return void (runStatus.textContent = "Choose two different players for the board.");
      for (const id of [white.value, black.value]) {
        s.byes = s.byes.filter((b) => b.id !== id);
        s.waiting = s.waiting.filter((x) => x !== id);
      }
      s.games.push({ board: 0, white: white.value, black: black.value, result: "" });
      renumber();
      runStatus.textContent = `${where} ${s.games.length}: ${nameOf(white.value)} has white against ${nameOf(black.value)}.`;
      redraw(key("add"));
    });
    const line = document.createElement("p");
    line.append(Object.assign(document.createElement("strong"), { textContent: "Add a board" }), " ",
      labelled("White", white), " ", labelled("Black", black), " ", add);
    tools.append(line);
  }
  if (s.games.length) {
    const inGames = s.games.flatMap((g) => [g.white, g.black]);
    const who = menu(`run-move-${n}`, inGames, "move-who");
    const kind = Object.assign(document.createElement("select"), { id: `run-move-kind-${n}` });
    for (const [value, text] of Object.entries(BYE_LABELS)) kind.append(option(value, text, value === "unplayed"));
    const move = editButton("Move", several ? ` out of a game in ${s.name}` : " out of a game", key("move"), () => {
      const g = s.games.find((x) => x.white === who.value || x.black === who.value);
      const other = g.white === who.value ? g.black : g.white;
      s.games.splice(s.games.indexOf(g), 1);
      s.waiting.push(other);
      setKind(s, who.value, kind.value);
      renumber();
      runStatus.textContent = `${nameOf(who.value)}: ${BYE_LABELS[kind.value].toLowerCase()}. ${nameOf(other)} is not yet paired.`;
      redraw(s.games.length ? key("move") : key("add"));
    });
    const line = document.createElement("p");
    line.append(Object.assign(document.createElement("strong"), { textContent: "Take a player out of a game" }), " ",
      labelled("Player", who), " ", labelled("This round", kind), " ", move);
    tools.append(line);
  }
  out.push(tools);
  return out;
}

const SHORT = { "1-0": "1–0", "0-1": "0–1", "1/2-1/2": "½–½" };

/** What a board's players reported on the Pairings page: value when one reported or both agree. */
function reportOf(g) {
  const white = g.reports?.white || "", black = g.reports?.black || "";
  if (!white && !black) return null;
  if (white && black && white !== black) return { conflict: true, text: `Conflict: White reported ${SHORT[white]}, Black ${SHORT[black]}` };
  const value = white || black;
  return { value, agreed: Boolean(white && black), text: `${SHORT[value]}, ${white && black ? "both reported" : white ? "White reported" : "Black reported"}` };
}

let agreedNow = [];

/** After a result is entered: the standings, and the next round's check-in once every board has one. */
function afterResults(number) {
  renderStandings();
  if (current.rounds[number - 1].games.every((g) => g.result)) renderRun();
  else keepFocus(() => renderResults(number));
}

async function enterResult(g, s, number, value, control) {
  const [event, date] = keyParts();
  control.disabled = true;
  const result = await call("result", { event, date, number, board: g.board, section: g.section ?? s.key, result: value });
  control.disabled = false;
  if (!result.ok) {
    runStatus.textContent = result.error;
    return;
  }
  g.result = value;
  afterResults(number);
}

function renderResults(number) {
  runPairings.hidden = false;
  runEditButtons.hidden = runProblems.hidden = true;
  runResultButtons.hidden = false;
  runPairingsHint.textContent = "Enter each board's result with its menu, which overrides anything reported. Players can report their "
    + "results on the Pairings page; a report counts once you confirm it. Check for reports to see new ones.";
  const parts = Pairing.sections(forEngine(current));
  const several = parts.length > 1;
  const round = current.rounds[number - 1];
  agreedNow = [];
  runGames.replaceChildren(...parts.filter((s) => s.players.length).flatMap((s, n) => {
    const here = s.rounds[number - 1];
    const where = several ? `${s.name} board` : "Board";
    const rows = here.games.map((g) => {
      const row = document.createElement("tr");
      row.insertCell().textContent = g.board;
      row.insertCell().textContent = nameOf(g.white);
      row.insertCell().textContent = nameOf(g.black);
      const reported = row.insertCell();
      const report = reportOf(g);
      if (report) {
        reported.append(report.text);
        if (report.conflict) reported.className = "run-conflict";
        if (report.value && report.value !== g.result) {
          const confirmIt = editButton("Confirm", ` ${SHORT[report.value]} on ${several ? `${s.name} board` : "board"} ${g.board}`, `${n}|${g.board}-confirm`,
            () => enterResult(g, s, number, report.value, confirmIt));
          confirmIt.dataset.focusAfter = `${n}|${g.board}-result`;
          reported.append(" ", confirmIt);
        }
        if (report.agreed && !g.result) agreedNow.push({ g, s, value: report.value });
      }
      const select = document.createElement("select");
      select.setAttribute("aria-label", `${where} ${g.board} result`);
      select.dataset.focus = `${n}|${g.board}-result`;
      for (const [value, text] of RESULTS) select.append(option(value, text, value === (g.result || "")));
      select.addEventListener("change", () => enterResult(g, s, number, select.value, select));
      row.insertCell().append(select);
      return row;
    });
    const byes = Object.assign(document.createElement("p"), { textContent: here.byes.length
      ? `Without a game: ${here.byes.map((b) => `${nameOf(b.id)}, ${BYE_LABELS[Pairing.byeKind(b)].toLowerCase()}`).join("; ")}.`
      : "Everyone has a game." });
    return [...sectionTable("run-games", ["Board", "White", "Black", "Reported", "Result"], rows, s.name, several), byes];
  }));
  const agreed = runResultButtons.querySelector(".run-confirm-agreed");
  agreed.hidden = !agreedNow.length;
  agreed.textContent = `Confirm agreed results (${agreedNow.length})`;
  runResultButtons.querySelector(".run-edit").hidden = round.games.some((g) => g.result);
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

/** The check-in's choice for each player, after taking out those withdrawn from this round on. */
async function checkIn(number) {
  const choicesMade = [...runAttendance.querySelectorAll(".run-this-round")].map((s) => [s.dataset.id, s.value]);
  const withdrawn = choicesMade.filter(([, v]) => v === "withdraw").map(([id]) => id);
  const [event, date] = keyParts();
  for (const id of withdrawn) await call("out", { event, date, id, from: number });
  return { choicesMade, withdrawn };
}

document.querySelector(".run-pair").addEventListener("click", async () => {
  const number = current.rounds.length + 1;
  if (![...runAttendance.querySelectorAll(".run-this-round")].some((s) => s.value === "play")) {
    return void (runStatus.textContent = "Nobody is present to pair.");
  }
  const { choicesMade, withdrawn } = await checkIn(number);
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

// By hand, the players marked present start out not yet paired, as does everyone when nobody is
// marked present; the others are unplayed, except in a quad, where the TD gives them forfeits.
document.querySelector(".run-by-hand").addEventListener("click", async () => {
  const number = current.rounds.length + 1;
  const { choicesMade, withdrawn } = await checkIn(number);
  current.players.forEach((p) => { if (withdrawn.includes(p.id)) p.out = number; });
  const chosen = new Map(choicesMade);
  const anyone = choicesMade.some(([, v]) => v === "play");
  draft = { number, sections: Pairing.sections(forEngine(current)).filter((s) => s.players.length).map((s) => {
    const part = { section: s.key, name: s.name, games: [], byes: [], waiting: [] };
    for (const p of s.players) {
      if (!chosen.has(p.id) || withdrawn.includes(p.id)) continue;
      const kind = { half: "half", zero: "zero", absent: anyone && current.format !== "quad" ? "unplayed" : "" }[chosen.get(p.id)];
      if (kind) part.byes.push({ id: p.id, kind, points: Pairing.BYE_KINDS[kind] });
      else part.waiting.push(p.id);
    }
    return part;
  }) };
  renderDraft();
  runStatus.textContent = `Round ${number}: add each board from the players not yet paired.`;
});

document.querySelector(".run-repair").addEventListener("click", () => {
  const last = current.rounds.at(-1);
  if (last && (!last.posted || draft?.posted)) current.rounds.pop();
  draft = null;
  renderRun();
});

document.querySelector(".run-cancel").addEventListener("click", () => {
  draft = null;
  renderRun();
});

document.querySelector(".run-edit").addEventListener("click", () => {
  const number = current.rounds.length;
  const reported = current.rounds[number - 1].games.some((g) => g.reports);
  if (reported && !confirm("Players have reported results for this round. Changing its pairings clears their reports. Change them?")) return;
  draft = { ...draftFrom(number), posted: true };
  renderDraft();
  runStatus.textContent = `Change round ${number}'s pairings, then post them again.`;
});

document.querySelector(".run-refresh").addEventListener("click", loadRun);

document.querySelector(".run-confirm-agreed").addEventListener("click", async (event) => {
  const number = current.rounds.length;
  const agreed = agreedNow;
  const [eventName, date] = keyParts();
  event.target.disabled = true;
  const result = await call("results", { event: eventName, date, number,
    results: JSON.stringify(agreed.map(({ g, s, value }) => ({ board: g.board, section: g.section ?? s.key, result: value }))) });
  event.target.disabled = false;
  if (!result.ok) return void (runStatus.textContent = result.error);
  for (const { g, value } of agreed) g.result = value;
  runStatus.textContent = `${agreed.length} agreed ${agreed.length === 1 ? "result is" : "results are"} confirmed.`;
  afterResults(number);
});

async function saveDraft(post) {
  const problems = draftProblems();
  if (problems.length) {
    runStatus.textContent = `Not saved yet. ${problems[0]}${problems.length > 1 ? ` The other ${problems.length - 1} are listed above the buttons.` : ""}`;
    return;
  }
  if (draft.posted && !post && !confirm(`Saving without posting takes round ${draft.number} off the Pairings page until you post it. Save?`)) return;
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