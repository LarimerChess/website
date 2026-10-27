// The TD desk's Run the tournament section: start a tournament for the chosen event, check in
// players, pair each round with pairing.js or by hand, review, change, and post it (and change it
// again until it has results), enter results or confirm the ones players report, and follow the
// standings. The script keeps everything in the tournament database. An arena is run by td-arena.js. call, choice, choices, andList, byeDate, and nightsInWords come from td.js.
//
// A tournament's sections play each round together: one check-in, one Pair button that pairs
// every section on its own, one review, and one Post, with each section in its own tables. An
// extra rated games section (28M4) plays only its own rounds, and its players are also in another
// section, so the desk tells their check-ins, games, and byes apart by section. Each section is a
// Swiss, a round robin, or a double round robin, which the TD can change until it has a posted round.

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
const runReport = document.querySelector(".run-report");
const runManage = document.querySelector(".run-manage");
const runPlanned = document.querySelector(".run-planned");
const RESULTS = [["", "No result"], ["1-0", "1–0"], ["0-1", "0–1"], ["1/2-1/2", "½–½"],
  ["1F-0F", "1F–0F (black forfeits)"], ["0F-1F", "0F–1F (white forfeits)"], ["0F-0F", "0F–0F (both forfeit)"]];
let current = null;
let draft = null;
let startEdited = false;

const keyParts = () => choice.value.split("/");
const nameOf = (id) => {
  const p = current?.players.find((x) => x.id === id);
  return p ? `${p.name} (${p.rating ?? "unrated"})` : id;
};

function forEngine(t) {
  return {
    format: t.format, sections: t.sections || [],
    players: t.players.map((p) => ({ id: p.id, name: p.name, rating: p.rating, number: p.number, section: p.section || "",
      games: p.games, floor: p.floor, sweep: p.sweep, ...(p.byes ? { byes: p.byes } : {}),
      ...(p.nights ? { nights: p.nights } : {}) })),
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

const FORMATS = [["swiss", "Swiss"], ["rr", "Round robin"], ["drr", "Double round robin"]];

/** A menu of the formats a section can have. */
function formatMenu(value, attributes) {
  const menu = Object.assign(document.createElement("select"), attributes);
  menu.append(...FORMATS.map(([v, text]) => option(v, text, v === (value || "swiss"))));
  return menu;
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
  const format = document.createElement("div");
  format.append(Object.assign(document.createElement("label"), { htmlFor: `run-section-format-${n}`, textContent: "Format" }),
    formatMenu(section.format, { id: `run-section-format-${n}`, className: "run-section-format" }));
  row.append(field("Section", `run-section-name-${n}`, section.name, { maxLength: 30, className: "run-section-name" }),
    field("Rated under", `run-section-under-${n}`, section.under, { inputMode: "numeric", maxLength: 4, className: "run-section-under" }),
    format, remove);
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
    name: row.querySelector(".run-section-name").value.trim(), under: row.querySelector(".run-section-under").value.trim(),
    format: row.querySelector(".run-section-format").value }));
  if (list.some((s) => !s.name)) return { error: "Name every section, or remove it." };
  if (list.some((s) => s.under && !/^\d{3,4}$/.test(s.under))) return { error: "A section's limit is a rating, such as 1400, or empty for none." };
  return { sections: list.map((s) => ({ name: s.name, ...(s.under ? { under: Number(s.under) } : {}), ...(s.format === "swiss" ? {} : { format: s.format }) })) };
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
  startEdited = false;
  if (!key) return;
  runStatus.textContent = "Loading the tournament…";
  const [event, date] = keyParts();
  try {
    const { tournament } = await call("tournament", { event, date });
    if (choice.value !== key) return;
    current = tournament;
    renderRun();
    syncReport(key, current);
    document.dispatchEvent(new CustomEvent("td-tournament", { detail: current }));
  } catch {
    runStatus.textContent = "The tournament couldn't be loaded. Try again.";
  }
}

function renderRun() {
  showStart(false);
  runRound.hidden = runStandingsWrap.hidden = runArena.hidden = runManage.hidden = true;
  if (current && current.status !== "rated") {
    runManage.hidden = false;
    // A round robin's players set its rounds; a Swiss plays as many as the TD gives it.
    runPlanned.hidden = (current.sections || []).some((d) => d.last) ? !plannedSections().length : current.format !== "swiss";
    fillPlanned();
    renderSectionNames();
    renderExtras();
  }
  const selectedChoice = choices.find((c) => c.key === choice.value);
  if (!current) {
    if (selectedChoice?.kind === "night") {
      runStatus.textContent = "A club night's Swiss runs for the whole month. Choose the month to start or run it.";
      return;
    }
    runStatus.textContent = "Not started.";
    if (selectedChoice?.kind === "month") {
      const nights = choices.filter((c) => c.key.startsWith(`${choice.value}-`)).length;
      runStart.elements.rounds.value = nights || "";
    } else {
      runStart.elements.rounds.value = selectedChoice?.rounds || "";
    }
    // An event whose calendar settings say how it's run starts that way; otherwise the TD chooses.
    const formatMenu = runStart.elements.format;
    const set = document.querySelector(".run-format-set");
    const fixed = Boolean(selectedChoice?.format);
    if (fixed) {
      formatMenu.value = selectedChoice.format;
      set.textContent = `Format: ${formatMenu.selectedOptions[0].textContent}, set by the event.`;
    }
    formatMenu.hidden = document.querySelector('[for="run-format"]').hidden = fixed;
    fillTds(runStart.elements.td, choice.value, "");
    set.hidden = !fixed;
    showFormatFields();
    showStart(true);
    return;
  }
  const t = current;
  const last = t.rounds.at(-1);
  const complete = (r) => r.games.every((g) => g.result);
  if (t.format === "arena") return renderArena();
  const parts = Pairing.sections(forEngine(t));
  runStatus.textContent = `${t.name}: ${t.players.length} players, ${t.rounds.length} of ${t.plannedRounds || "?"} rounds paired.`
    + (parts.length > 1 ? ` Sections: ${parts.map((s) => `${s.name} (${s.players.length})`).join(", ")}.` : "")
    + (t.status === "rated" ? " Rated by US Chess." : "");
  runStandingsWrap.hidden = !t.rounds.length;
  renderStandings();
  if (t.rounds.length) renderByesAll();
  renderGiveBye();
  runReport.hidden = !reportReady(t);
  if (t.status === "rated") return;
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
    runStatus.textContent += " All rounds are played. The rating report is below.";
    return;
  }
  renderCheckin(t, parts, next);
}

function renderCheckin(t, parts, next) {
  const quad = t.format === "quad";
  const active = parts.filter((s) => s.players.length && Pairing.playsIn(s, next));
  runTitle.textContent = `Round ${next}: check in`;
  runCheckin.hidden = false;
  runPairings.hidden = true;
  // A round robin's pairings come from its table, so a player not here loses that game by forfeit.
  runCheckinHint.textContent = active.some(Pairing.roundRobin)
    ? "Everyone starts as Present; change anyone who isn't here. A round robin's table fixes its pairings, so a player not here loses that round's game by forfeit."
      + (active.some((s) => s.extra) ? " In an extra games section, a player not here has the round unplayed." : "")
    : "Everyone starts as Present, or as a half-point bye if they asked for one this round; change anyone who isn't here, or who asked and plays after all. Anyone else's round is unplayed, unless they asked for a half-point bye (22C) or a zero-point bye. A round can be reclassified later, under Standings."
      + (t.players.some((p) => p.nights) ? " A player who entered other nights of the month only starts as not here." : "");
  // Quads are numbered once, at the start, so later entrants can't be added.
  document.querySelector(".run-sync").hidden = quad;
  // Sections are set until round 1 is posted (a player plays in one section), and a late entrant moved until their first game.
  const editable = !quad && next === 1;
  runSectionsEdit.hidden = !editable;
  if (editable && !runSectionsEdit.open) fillSections(runSectionsEdit.querySelector(".run-sections"), t.sections || []);
  const defs = (t.sections || []).filter((d) => !d.extra);
  const several = parts.length > 1;
  runAttendance.replaceChildren(...active.flatMap((s) => {
    const movable = (p) => !quad && !s.extra && defs.length > 1 && !s.rounds.some((r) => r.games.some((g) => g.white === p.id || g.black === p.id)
      || r.byes.some((b) => b.id === p.id && Pairing.byeKind(b) === "bye"));
    const choosing = s.players.some((p) => !p.out && movable(p));
    const table = Pairing.roundRobin(s);
    const scores = new Map(Pairing.standings(s).map((r) => [r.id, r.score]));
    const own = next - s.first + 1;
    // 28P: a player who lost the last round by forfeit is dropped unless the TD accepts their excuse.
    const forfeited = new Set((s.rounds[own - 2]?.games || []).flatMap((g) => [g.result === "0F-1F" || g.result === "0F-0F" ? g.white : null,
      g.result === "1F-0F" || g.result === "0F-0F" ? g.black : null]).filter(Boolean));
    const rows = s.players.filter((p) => !p.out).map((p) => {
      const byes = p.byes || [];
      const noShow = forfeited.has(p.id);
      // A player who entered single nights of a month plays only those.
      const elsewhere = p.nights && !p.nights.includes(next);
      const row = document.createElement("tr");
      row.insertCell().textContent = p.number;
      row.insertCell().textContent = noShow ? `${p.name} (lost round ${own - 1} by forfeit: not here unless excused, 28P)`
        : elsewhere ? `${p.name} (${p.nights.length ? `entered for ${nightsInWords(p.nights.map((n) => t.roundDates[n - 1]))} only` : "not entered for this night"})`
        : p.name;
      row.insertCell().textContent = p.rating ?? "Unrated";
      row.insertCell().textContent = scores.get(p.id) ?? 0;
      // Each round stays on one line, as "2 (October 19)", in the narrow table on a phone.
      if (!table) row.insertCell().textContent = byes.map((n) => (t.roundDates?.[n - 1] ? `${n} (${byeDate(t.roundDates[n - 1])})` : `${n}`)
        .replaceAll(" ", " ")).join(", ");
      if (choosing && !movable(p)) row.insertCell();
      else if (choosing) {
        const move = document.createElement("select");
        move.setAttribute("aria-label", `${p.name}'s section`);
        for (const d of defs) if (Pairing.mayEnter(d, p.rating) || d.name === s.name) move.append(option(d.name, d.name, d.name === s.name));
        move.addEventListener("change", () => moveTo(p, move.value));
        row.insertCell().append(move);
      }
      const asked = !table && byes.includes(own);
      const half = !table && !byeProblemsIn(s, next, [], [{ id: p.id, kind: "half" }]).length;
      const start = noShow || elsewhere ? "absent" : asked && half ? "half" : "play";
      const select = document.createElement("select");
      select.dataset.id = p.id;
      select.dataset.section = s.key;
      select.dataset.start = start;
      select.className = "run-this-round";
      select.setAttribute("aria-label", `${p.name} this round${several ? ` in ${s.name}` : ""}`);
      select.append(option("play", "Present", start === "play"),
        option("absent", table ? "Not here: loses by forfeit" : "Not here: unplayed", start === "absent"),
        ...(table ? [] : [...(half ? [option("half", "Half-point bye (asked for)", start === "half")] : []), option("zero", "Zero-point bye (asked for)", false)]),
        option("withdraw", "Withdraw from the tournament", false));
      const lastRound = s.last ? s.last - s.first + 1 : t.plannedRounds;
      if (asked && own === lastRound) {
        select.addEventListener("change", () => {
          if (select.value === "play") runStatus.textContent = `${p.name} asked for this last-round bye before round 1. Playing after all, a win`
            + " counts as a draw for prizes (22C5); the standings here show the result as played.";
        });
      }
      row.insertCell().append(select);
      return row;
    });
    return sectionTable("run-attendance", ["No.", "Name", "Rating", "Score", ...(table ? [] : ["Byes asked for"]),
      ...(choosing ? ["Section"] : []), "This round"], rows, `${s.name} (${rows.length})`, several);
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
// player for a seat swaps them with whoever had it, so nobody is lost or doubled, except that a
// player displaced by one with a bye has the round unplayed: a bye is the player's own, asked for
// or given by the rules (28L), not the seat's. Removing a board leaves its players not yet paired,
// and Save and Post wait until everyone is placed.

/** A saved or posted round as a draft, copied, so nothing changes until it is saved. */
function draftFrom(number) {
  return { number, sections: playing(number).map((s) => ({
    section: s.key, name: s.name, waiting: [],
    games: s.rounds[number - s.first].games.map((g) => ({ board: g.board, white: g.white, black: g.black, result: g.result || "" })),
    byes: s.rounds[number - s.first].byes.map((b) => ({ id: b.id, points: b.points, kind: b.kind })) })) };
}

/** The sections with players that play the tournament's round number. */
const playing = (number) => Pairing.sections(forEngine(current)).filter((s) => s.players.length && Pairing.playsIn(s, number));
// Tables are headed by section, and controls named by it, when the tournament has several, even in a round only one plays.
const severalSections = () => Pairing.sections(forEngine(current)).filter((s) => s.players.length).length > 1;

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
  else if (bye) Object.assign(bye, { id: old, kind: "unplayed", points: Pairing.BYE_KINDS.unplayed });
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

/** Pairing.byeProblems for a section's round, with the section's last round and the tournament's half-point byes. */
const byeProblemsIn = (part, number, games, byes) => Pairing.byeProblems(part, number, games, byes, part.last ?? current.plannedRounds, current.halfByes);

/** What keeps the draft from being saved, in words for the TD, the rules on byes among them. */
function draftProblems() {
  const problems = [];
  const several = severalSections();
  for (const s of draft.sections) {
    const seen = new Set();
    const where = several ? ` (${s.name})` : "";
    const active = activeIn(s);
    const placed = [...s.games.flatMap((g) => [g.white, g.black]), ...s.byes.map((b) => b.id)];
    for (const id of placed) {
      if (seen.has(id)) problems.push(`${nameOf(id)} is in the pairings twice.`);
      else if (!active.includes(id)) problems.push(`${nameOf(id)}${where} ${isWithdrawn(id) ? "is withdrawn" : "plays in another section"}; take them out of these pairings.`);
      seen.add(id);
    }
    for (const id of active) if (!placed.includes(id)) problems.push(`${nameOf(id)}${where} isn't paired yet: add a board for them, or choose a round without a game.`);
    const part = Pairing.sections(forEngine(current)).find((x) => x.key === s.section && x.name === s.name);
    if (part) problems.push(...byeProblemsIn(part, draft.number, s.games, s.byes).map((text) => (several ? `${s.name}: ${text}` : text)));
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
  runPairingsHint.textContent = "Change any seat with its menu: the player you choose swaps places with the one there, who has the round "
    + "unplayed if the one chosen had a bye. The director is "
    + "responsible for the pairings (29E7). Save keeps them private; Post shows them on the Pairings page"
    + (draft.posted ? ", in place of the round posted, and clears any results players reported for it." : ".");
  const several = severalSections();
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
  const part = Pairing.sections(forEngine(current)).find((x) => x.key === s.section && x.name === s.name);
  const byeNote = part && Pairing.fullByeNote(part, draft.number, s.games, s.byes);
  const notes = [...(s.notes || []), ...(byeNote ? [`${byeNote} Posting gives it as chosen (29E7).`] : [])];
  if (notes.length) {
    const list = document.createElement("ul");
    list.className = "run-notes";
    list.append(...notes.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
    out.push(list);
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
  const parts = playing(number);
  const several = severalSections();
  const round = current.rounds[number - 1];
  agreedNow = [];
  runGames.replaceChildren(...parts.flatMap((s, n) => {
    const here = s.rounds[number - s.first];
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

// The rating report's chief TD and affiliate come from scripts/tds.json; its place, from the event's
// listing in events.json while it's still there. Its time control is kept with the tournament, read
// from the listing when it starts, and a section can have its own. The files are built from the
// tournament as the desk last loaded it and are never stored anywhere but the TD's folder.
const REPORT_FILES = ["THEXPORT.DBF", "TSEXPORT.DBF", "TDEXPORT.DBF"];
let reportSources = null;
// A folder the TD chose for each tournament, kept in IndexedDB so it outlasts a reload.
const folders = {};

// Ready once the planned rounds are all posted with their results; to stop early, the TD lowers the rounds.
const reportReady = (t) => t.format !== "arena" && t.rounds.length > 0 && t.rounds.length >= (t.plannedRounds || 0)
  && t.rounds.every((r) => r.posted && r.games.every((g) => g.result));

function folderStore(mode, work) {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open("lccc-td", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("folders");
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction("folders", mode);
          const request = work(tx.objectStore("folders"));
          tx.oncomplete = () => resolve(request.result);
          tx.onerror = tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

async function folderFor(key) {
  if (!(key in folders)) folders[key] = (await folderStore("readonly", (store) => store.get(key))) || null;
  return folders[key];
}

/** Writes the files to the tournament's folder, or with none deletes them from it: "written",
 *  "removed", "permission" when the folder needs the TD's permission again, or "" without a folder. */
async function syncFolder(key, files) {
  const folder = await folderFor(key);
  if (!folder) return "";
  try {
    if (await folder.queryPermission({ mode: "readwrite" }) !== "granted") return "permission";
    for (const name of REPORT_FILES) {
      if (files) {
        const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
        await writable.write(files[name]);
        await writable.close();
      } else {
        await folder.removeEntry(name).catch(() => {});
      }
    }
    return files ? "written" : "removed";
  } catch {
    return "permission";
  }
}

/** Fills a menu with the club's TDs, choosing the tournament's chief TD when the menu is new to it. */
async function fillTds(menu, key, chosen) {
  const [roster] = await loadSources();
  if (!menu.options.length) {
    for (const td of roster?.tds || []) menu.append(option(td.uschess_id, `${td.name} (${td.uschess_id})`, false));
  }
  if (menu.dataset.key !== key) {
    menu.dataset.key = key;
    if (chosen && [...menu.options].some((o) => o.value === chosen)) menu.value = chosen;
  }
}

/** The time control in an event's listing, as MUIR writes it: "G/30;+30" from
 *  "Time control: 30 minutes + 30 seconds per move." or "Time control: G/30;+30 (30 minutes per player, …)". */
function listedControl(listing) {
  const text = (/^Time control: (.+)$/m.exec(listing?.description || "")?.[1] || "").replace(/\s*\(.*$/, "").replace(/\.$/, "").trim();
  return RatingReport.parseControl(text)?.text || text;
}

const loadSources = () => (reportSources ||= Promise.all(["/scripts/tds.json", "/events.json"]
  .map((url) => fetch(url).then((r) => r.json()).catch(() => null))));
const listingOf = async (t) => ((await loadSources())[1] || []).find((e) => e.page === `/events/${t.event}/`);

/** Each section with players and the time control the report gives it: its own, or the tournament's. */
function reportControls(t) {
  const parts = Pairing.sections(forEngine(t)).filter((s) => s.players.length);
  const own = (s) => (t.sections || []).find((d) => d.name === s.key)?.timeControl || "";
  return parts.map((s) => ({ section: s, own: own(s), control: own(s) || t.timeControl || "" }));
}

/** What keeps the files from being written: each section's time control, as rule 5C and the upload format need it. */
function reportProblems(t) {
  const controls = reportControls(t);
  return [...new Set(controls.map(({ section, control }) => RatingReport.controlProblem(control, controls.length > 1 ? section.name : "")))]
    .filter(Boolean);
}

/** The time control fields: the tournament's, and with several sections each one's own, where it differs. */
function renderControls(t) {
  const main = document.getElementById("run-report-control");
  if (main.dataset.key !== t.key) {
    document.getElementById("run-report-control-error").textContent = "";
    main.removeAttribute("aria-invalid");
  }
  if (main.dataset.key !== t.key || document.activeElement !== main) main.value = t.timeControl || "";
  main.dataset.key = t.key;
  const box = document.querySelector(".run-report-sections");
  const controls = reportControls(t);
  if (controls.length < 2) return void box.replaceChildren();
  box.replaceChildren(...controls.map(({ section, own }, i) => {
    const row = document.createElement("div");
    row.className = "field-row";
    const input = Object.assign(document.createElement("input"), { id: `run-report-control-${i}`, type: "text", autocomplete: "off",
      spellcheck: false, maxLength: 40, value: own, placeholder: "Same as the tournament", className: "run-report-section-control" });
    input.dataset.section = section.key;
    input.setAttribute("aria-describedby", "run-report-control-error");
    input.addEventListener("change", () => checkControl(input, section.key));
    row.append(Object.assign(document.createElement("label"), { htmlFor: input.id, textContent: section.name }), input);
    return row;
  }));
}

/** Saves a time control field as US Chess writes it, G/30;+30 for 30+30, or says what's wrong with it. A
 *  section's may be left empty, for the tournament's. */
function checkControl(input, section) {
  const value = input.value.trim().replace(/\s+/g, " ");
  const error = document.getElementById("run-report-control-error");
  const parsed = RatingReport.parseControl(value);
  const wrong = !value ? (section ? "" : "Enter the tournament's time control.")
    : !parsed ? `${section ? `${section}: ` : ""}"${value}" isn't a time control the desk can read; write it like G/30;+30, G/70;d10, or 40/90 SD/30;d5.` : "";
  input.setAttribute("aria-invalid", String(Boolean(wrong)));
  error.textContent = wrong;
  if (wrong) return;
  input.value = parsed ? parsed.text : "";
  saveControl(section, input.value);
}

async function saveControl(section, value) {
  const t = current;
  const [event, date] = keyParts();
  const result = await call("timeControl", { event, date, value: value.trim(), ...(section ? { section } : {}) });
  if (!result.ok) return void (runStatus.textContent = result.error);
  if (section) {
    const def = t.sections.find((d) => d.name === section);
    if (value.trim()) def.timeControl = value.trim();
    else delete def.timeControl;
  } else {
    t.timeControl = value.trim();
  }
  if (t === current) syncReport(choice.value, t);
}

async function reportFiles(t) {
  const tdMenu = document.getElementById("run-report-td");
  await fillTds(tdMenu, t.key, t.td);
  const [roster] = await reportSources;
  const listing = await listingOf(t);
  const when = t.key.split("/")[1];
  const days = t.rounds.map((r) => (r.postedAt || "").slice(0, 10)).filter(Boolean).sort();
  const [begin, end] = when.length === 10 ? [when, when] : days.length ? [days[0], days.at(-1)] : [`${when}-01`, `${when}-01`];
  return RatingReport.files({ ...forEngine(t), name: t.name }, { td: tdMenu.value, affiliate: roster?.affiliate || "",
    timeControl: t.timeControl || "", timeControls: Object.fromEntries(reportControls(t).filter((c) => c.own).map((c) => [c.section.key, c.own])),
    city: listing?.place?.city || "Fort Collins", state: listing?.place?.region || "CO",
    zip: listing?.place?.zip || "80524", begin, end });
}

/** Keeps the folder, if there is one, the same as the tournament, and says so. A tournament started
 *  before it kept a time control takes its listing's, while the event is listed. */
async function syncReport(key, t) {
  const rated = t && t.format !== "arena";
  if (rated && !t.timeControl) {
    const listed = listedControl(await listingOf(t));
    if (listed) {
      t.timeControl = listed;
      const [event, date] = key.split("/");
      call("timeControl", { event, date, value: listed });
    }
  }
  const problems = rated ? reportProblems(t) : [];
  if (rated && choice.value === key) {
    renderControls(t);
    document.querySelector(".run-report-problems").replaceChildren(...problems.map((text) =>
      Object.assign(document.createElement("li"), { textContent: text[0].toUpperCase() + text.slice(1) })));
  }
  const ready = t && reportReady(t) && !problems.length;
  const done = await syncFolder(key, ready ? await reportFiles(t) : null);
  if (choice.value !== key) return;
  const button = document.querySelector(".run-report-folder");
  button.textContent = done === "permission" ? "Allow the folder again" : done ? "Choose another folder" : "Keep the files in a folder";
  button.hidden = !window.showDirectoryPicker;
  document.querySelector(".run-report-folder-status").textContent =
    done === "written" ? `${REPORT_FILES.join(", ")} are up to date in the folder ${folders[key].name}.`
      : done === "permission" ? "The browser needs permission again to keep the files in the folder."
        : !window.showDirectoryPicker ? "This browser can't keep files in a folder; Chrome or Edge on a computer can." : "";
  const links = document.querySelector(".run-report-files");
  if (!links.children.length) {
    links.append(...REPORT_FILES.flatMap((name, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button-secondary run-report-download";
      button.textContent = `Download ${name}`;
      button.addEventListener("click", () => downloadReport(name));
      return i ? [" ", button] : [button];
    }));
  }
}

/** Downloads one file from the tournament as the script has it now, not as the desk last loaded it. */
async function downloadReport(name) {
  await loadRun();
  if (!current || !reportReady(current)) return;
  const problems = reportProblems(current);
  if (problems.length) return void (runStatus.textContent = `Not yet: ${problems[0]}`);
  const files = await reportFiles(current);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([files[name]], { type: "application/octet-stream" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

document.querySelector(".run-report-folder").addEventListener("click", async () => {
  const key = choice.value;
  try {
    const folder = await folderFor(key);
    if (folder && await folder.queryPermission({ mode: "readwrite" }) !== "granted"
      && await folder.requestPermission({ mode: "readwrite" }) === "granted") return syncReport(key, current);
    folders[key] = await window.showDirectoryPicker({ id: "rating-report", mode: "readwrite" });
    await folderStore("readwrite", (store) => store.put(folders[key], key));
  } catch {
    return;
  }
  syncReport(key, current);
});

document.getElementById("run-report-td").addEventListener("change", () => current && syncReport(choice.value, current));
document.getElementById("run-report-control").addEventListener("change", (e) => current && checkControl(e.target, ""));

/** Every round without a game, each with a menu to reclassify it (saved as soon as it changes), including a
 *  posted round a player has no row in, such as one a late entrant missed that offers no bye (28K). With an extra games
 *  section, a round is the section's own, and its section says which bye of a player's it is. */
function renderByesAll() {
  const box = document.querySelector(".run-byes-all");
  const extra = (current.sections || []).some((d) => d.extra);
  const parts = Pairing.sections(forEngine(current)).filter((s) => s.players.length);
  const missing = (s, r, i) => (current.rounds[s.first + i - 1].posted ? s.players.filter((p) => !(p.out && p.out <= s.first + i)
    && !r.games.some((g) => g.white === p.id || g.black === p.id) && !r.byes.some((b) => b.id === p.id))
    .map((p) => ({ id: p.id, points: 0, kind: "unplayed", missing: r }))
    : []);
  const rows = parts.flatMap((s) => s.rounds.flatMap((r, i) => [...r.byes, ...missing(s, r, i)].map((b) => {
    const row = document.createElement("tr");
    const where = extra ? `${s.name} round ${i + 1}` : `round ${i + 1}`;
    if (extra) row.insertCell().textContent = s.name;
    row.insertCell().textContent = i + 1;
    row.insertCell().textContent = nameOf(b.id);
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${nameOf(b.id)}, ${where}`);
    const kind = Pairing.byeKind(b);
    for (const [value, text] of Object.entries(BYE_LABELS)) select.append(option(value, text, value === kind));
    select.addEventListener("change", async () => {
      const problem = postedByeProblem(s, i, b.id, select.value);
      if (problem) {
        select.value = kind;
        return void (runStatus.textContent = problem);
      }
      const [event, date] = keyParts();
      select.disabled = true;
      const result = await call("byeKind", { event, date, number: s.first + i, id: b.id, kind: select.value, section: s.key });
      select.disabled = false;
      if (!result.ok) {
        select.value = kind;
        return void (runStatus.textContent = result.error);
      }
      b.kind = select.value;
      b.points = Pairing.BYE_KINDS[select.value];
      if (b.missing) {
        current.rounds[s.first + i - 1].byes.push({ id: b.id, points: b.points, kind: b.kind, section: s.key });
        delete b.missing;
      }
      runStatus.textContent = `${nameOf(b.id)}, ${where}: ${BYE_LABELS[select.value]}.`;
      renderStandings();
      renderGiveBye();
    });
    row.insertCell().append(select);
    return row;
  })));
  box.replaceChildren(...(rows.length
    ? sectionTable("run-byes-table", [...(extra ? ["Section"] : []), "Round", "Player", "Kind"], rows, "Byes and unplayed rounds", false)
    : [Object.assign(document.createElement("p"), { textContent: "None yet." })]));
  const asked = current.players.map((p) => [p, (p.byes || []).filter((n) => n > current.rounds.length && !(p.out && n >= p.out))])
    .filter(([, later]) => later.length);
  if (asked.length) {
    box.append(Object.assign(document.createElement("p"), {
      textContent: `Asked for: ${asked.map(([p, later]) => `${nameOf(p.id)}, ${roundsInWords(later)}`).join("; ")}. Change them under Give a bye or in the entries list.` }));
  }
}

/** Why a player's posted round i of section s, which has no game for them, can't be the kind, or "".
 *  Only the change is checked, so a round posted before the rules were held to doesn't block it. */
function postedByeProblem(s, i, id, kind) {
  if (!["bye", "half"].includes(kind)) return "";
  const r = s.rounds[i];
  const others = kind === "bye" ? r.byes.filter((x) => x.id !== id && Pairing.byeKind(x) === "bye") : [];
  return byeProblemsIn(s, s.first + i, kind === "bye" ? r.games : [], [...others, { id, kind }])[0] || "";
}

const giveBye = document.querySelector(".run-give-bye");
const FUTURE_LABELS = { play: "Plays", half: "Half-point bye (½), asked for" };

/** The rounds the player has no game in, which Give a bye can change: each posted one, as byeKind saves it, and,
 *  in a Swiss section, each still to be paired, as the half-point byes they ask for. A round paired but not posted
 *  changes in the draft, and a withdrawn player's rounds from then on stay unplayed. A player who entered single
 *  nights of a month has a night's entry, which takes no byes. */
function byeSlots(p) {
  const parts = Pairing.sections(forEngine(current)).filter((s) => s.players.some((x) => x.id === p.id));
  return parts.flatMap((s) => {
    const last = s.last ?? current.plannedRounds ?? current.rounds.length;
    const swiss = !Pairing.roundRobin(s) && !s.extra && !p.nights;
    return Array.from({ length: Math.max(0, last - s.first + 1) }, (_, i) => s.first + i).flatMap((n) => {
      if (p.out && n >= p.out) return [];
      const r = s.rounds[n - s.first];
      if (!r) return swiss ? [{ s, n, posted: false, kind: (p.byes || []).map(Number).includes(n) ? "half" : "play" }] : [];
      if (!current.rounds[n - 1].posted || r.games.some((g) => g.white === p.id || g.black === p.id)) return [];
      const bye = r.byes.find((b) => b.id === p.id);
      return [{ s, n, posted: true, bye, kind: bye ? Pairing.byeKind(bye) : "unplayed" }];
    });
  });
}

/** Why the slot can't be the kind, or "": a posted round by its section's rules, a round to come as the half-point
 *  bye asked for, which before round 1 is posted may be the last round's (22C4). */
function slotProblem(slot, id, kind) {
  if (kind === slot.kind) return "";
  if (slot.posted) return postedByeProblem(slot.s, slot.n - slot.s.first, id, kind);
  if (kind !== "half") return "";
  const asking = current.rounds[0]?.posted ? slot.s
    : { ...slot.s, players: slot.s.players.map((x) => (x.id === id ? { ...x, byes: [...(x.byes || []), slot.n] } : x)) };
  return byeProblemsIn(asking, slot.n, [], [{ id, kind }])[0] || "";
}

function slotName(slot) {
  const extra = (current.sections || []).some((d) => d.extra);
  const date = current.roundDates?.[slot.n - 1];
  return `${extra ? `${slot.s.name} round` : "Round"} ${slot.n - slot.s.first + 1}${date ? ` (${byeDate(date)})` : ""}`;
}

/** Give a bye's menus: the players with a round they have no game in, that player's rounds, and the kinds the rules
 *  allow for the round, with why the others aren't offered. What the TD chose stays chosen as the tournament changes. */
function renderGiveBye() {
  const { player, round, kind } = giveBye.elements;
  const players = current?.rounds.length && current.status !== "rated"
    ? current.players.filter((p) => byeSlots(p).length).sort((a, b) => a.name.localeCompare(b.name)) : [];
  giveBye.hidden = !players.length;
  if (!players.length) return;
  const chosen = player.value;
  player.replaceChildren(...players.map((p) => option(p.id, nameOf(p.id), p.id === chosen)));
  const p = current.players.find((x) => x.id === player.value);
  const slots = byeSlots(p);
  const was = round.value;
  round.replaceChildren(...slots.map((slot) => option(slotName(slot), `${slotName(slot)}, ${slot.posted
    ? BYE_LABELS[slot.kind].toLowerCase() : slot.kind === "half" ? "half-point bye asked for" : "to come"}`, slotName(slot) === was)));
  const slot = slots.find((x) => slotName(x) === round.value);
  const labels = slot.posted ? BYE_LABELS : FUTURE_LABELS;
  const refused = [];
  kind.replaceChildren(...Object.entries(labels).filter(([value]) => {
    const problem = slotProblem(slot, p.id, value);
    if (problem) refused.push(problem);
    return !problem;
  }).map(([value, text]) => option(value, text, value === slot.kind)));
  document.getElementById("run-bye-why").textContent = refused.length ? `Not offered: ${[...new Set(refused)].join(" ")}` : "";
}

giveBye.elements.player.addEventListener("change", renderGiveBye);
giveBye.elements.round.addEventListener("change", renderGiveBye);

giveBye.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { player, round, kind } = giveBye.elements;
  const p = current.players.find((x) => x.id === player.value);
  const slot = byeSlots(p).find((x) => slotName(x) === round.value);
  const where = `${nameOf(p.id)}, ${slotName(slot).toLowerCase()}`;
  if (kind.value === slot.kind) return void (runStatus.textContent = `${where} is already that.`);
  const problem = slotProblem(slot, p.id, kind.value);
  if (problem) return void (runStatus.textContent = problem);
  const [eventName, date] = keyParts();
  const button = giveBye.querySelector("button");
  button.disabled = true;
  runStatus.textContent = "Saving the bye…";
  try {
    if (slot.posted) {
      const result = await call("byeKind", { event: eventName, date, number: slot.n, id: p.id, kind: kind.value, section: slot.s.key });
      if (!result.ok) return void (runStatus.textContent = result.error);
      const points = Pairing.BYE_KINDS[kind.value];
      if (slot.bye) Object.assign(slot.bye, { kind: kind.value, points });
      else current.rounds[slot.n - 1].byes.push({ id: p.id, points, kind: kind.value, section: slot.s.key });
      runStatus.textContent = `${where}: ${BYE_LABELS[kind.value]}.`;
    } else {
      // The entry keeps the byes asked for, and the script copies them to the player.
      const entry = deskEntries.key === current.key && deskEntries.entries.find((e) => e.id === p.id && e.date === date && e.token);
      if (!entry) return void (runStatus.textContent = `${p.name} has no entry in the entries list below, so the bye can't be saved. Reload the page and try again.`);
      const value = current.roundDates?.[slot.n - 1] || String(slot.n);
      const asked = entry.byes || [];
      const byes = (kind.value === "half" ? [...asked, value] : asked.filter((b) => b !== value))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      const result = await call("byes", { token: entry.token, byes: byes.join(", ") });
      if (!result.ok) return void (runStatus.textContent = result.error);
      entry.byes = byes;
      p.byes = kind.value === "half" ? [...(p.byes || []), slot.n].sort((a, b) => a - b) : (p.byes || []).filter((n) => Number(n) !== slot.n);
      const lastRound = slot.s.last ?? current.plannedRounds;
      runStatus.textContent = `${where}: ${kind.value === "half" ? "half-point bye asked for" : "plays"}.`
        + (kind.value === "play" && slot.n === lastRound && current.rounds[0]?.posted
          ? " They asked for this last-round bye before round 1, so a win counts as a draw for prizes (22C5)." : "");
      pending.add("entries");
      applyChanges();
      if (!runCheckin.hidden && !runBusy()) renderCheckin(current, Pairing.sections(forEngine(current)), current.rounds.length + 1);
    }
    renderStandings();
    renderByesAll();
    renderGiveBye();
  } catch {
    runStatus.textContent = "Couldn't reach the registration service. Try again.";
  } finally {
    button.disabled = false;
  }
});

/** Rounds in words, "round 3" or "rounds 2 and 4", or a month's nights, "October 19 and 26". */
function roundsInWords(numbers) {
  const dates = numbers.map((n) => current.roundDates?.[n - 1]);
  return dates.every(Boolean) ? nightsInWords(dates) : `${numbers.length > 1 ? "rounds" : "round"} ${andList.format(numbers.map(String))}`;
}

const SWISS_HEADINGS = ["Median", "Solkoff", "Cumulative", "Opp. cumulative", "Performance", "Est. rating"];
const QUAD_HEADINGS = ["Sonneborn-Berger", "Head-to-head", "Performance", "Est. rating"];

function renderStandings() {
  if (!current?.rounds.length) return;
  const next = current.rounds.length + 1;
  const parts = Pairing.sections(forEngine(current)).filter((s) => s.players.length);
  const robins = parts.some(Pairing.roundRobin);
  runStandingsHint.textContent = [robins && "Each round robin, a quad too, is ranked by score, then Sonneborn-Berger, then the games between the tied players (34F).",
    parts.some((s) => !Pairing.roundRobin(s)) && `${robins ? "A Swiss's tiebreaks are" : "Tiebreaks"} in the US Chess default order (34E): modified median, Solkoff, cumulative, cumulative of opposition.`]
    .filter(Boolean).join(" ")
    + " Performance is the Elo performance rating over the games played against rated opponents; Est. rating, US Chess's formula"
    + " applied to the games played so far.";
  runStandings.replaceChildren(...parts.flatMap((s) => {
    const quad = Pairing.roundRobin(s);
    const table = quad ? Pairing.roundRobinStandings(s) : Pairing.standings(s);
    const rounds = Pairing.roundCells(s, table);
    const rows = table.map((r) => {
      const row = document.createElement("tr");
      const p = current.players.find((x) => x.id === r.id);
      const name = r.name + (p?.out ? ` (out from round ${p.out})` : "");
      const cells = [r.place, name, r.rating ?? "Unrated", r.score, ...rounds(r.id), ...(quad ? [r.sonnebornBerger, r.headToHead ?? ""]
        : [r.median, r.solkoff, r.cumulative, r.opposition]), r.performance ?? "", r.estimate ?? ""];
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
    const headings = ["Place", "Name", "Rating", "Score", ...s.rounds.map((_, i) => `Round ${i + 1}`), ...(quad ? QUAD_HEADINGS : SWISS_HEADINGS)];
    return sectionTable("run-standings", [...headings, hidden("Withdraw")], rows, s.name, parts.length > 1);
  }));
}

/** Whether reloading the tournament would lose the TD's unsaved work: a changed draft, check-in
 *  choices, sections or a start being filled in, or a field in use. */
function runBusy() {
  const field = document.activeElement?.matches("input, select, textarea") && document.activeElement.closest(".run");
  const edited = draft && (draft.number > current.rounds.length || JSON.stringify(draft) !== JSON.stringify(draftFrom(draft.number)));
  const checkingIn = !runRound.hidden && !runCheckin.hidden
    && [...runAttendance.querySelectorAll(".run-this-round")].some((s) => s.value !== s.dataset.start);
  return Boolean(field || edited || checkingIn || runSectionsEdit.open || namesWrap.open || document.querySelector(".run-arena-sections-wrap").open
    || (!runStart.hidden && startEdited));
}

// The format menu and the hint on starting sit on the status line, outside the form.
function showStart(shown) {
  runStart.hidden = !shown;
  for (const part of document.querySelectorAll(".run-start-only")) part.hidden = !shown;
}

function showFormatFields() {
  for (const field of runStart.querySelectorAll("[data-format]")) field.hidden = field.dataset.format !== runStart.elements.format.value;
}
runStart.elements.format.addEventListener("change", showFormatFields);
runStart.addEventListener("input", () => { startEdited = true; });

runStart.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [eventName, date] = keyParts();
  const fields = Object.fromEntries(new FormData(runStart));
  if (fields.format === "swiss") {
    const defined = readSections(runStart.querySelector(".run-sections"));
    if (defined.error) return void (runStatus.textContent = defined.error);
    // A round robin's players set its rounds, so only a Swiss section needs them.
    if (defined.sections.some((d) => !d.format) && !/^\d+$/.test(fields.rounds)) return void (runStatus.textContent = "How many rounds?");
    fields.sections = JSON.stringify(defined.sections);
  }
  if (fields.format === "quad" && !confirm("Start the quads? Players are grouped by rating and numbered by lot now, so register everyone first.")) return;
  if (fields.format === "arena") {
    if (!/^\d\d:\d\d$/.test(fields.cutoff)) return void (runStatus.textContent = "No new games after what time?");
    const defined = readArenaSections(runStart.querySelector(".run-arena-sections"));
    if (defined.error) return void (runStatus.textContent = defined.error);
    fields.sections = JSON.stringify(defined.sections.map(({ from, ...s }) => s));
  }
  runStatus.textContent = "Starting…";
  fields.timeControl = listedControl(await listingOf({ event: eventName }));
  const result = await call("start", { event: eventName, date, ...fields });
  runStatus.textContent = result.message || result.error;
  if (result.ok) {
    startEdited = false;
    loadRun();
  }
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
  const choicesMade = [...runAttendance.querySelectorAll(".run-this-round")].map((s) => [s.dataset.id, s.value, s.dataset.section]);
  const withdrawn = [...new Set(choicesMade.filter(([, v]) => v === "withdraw").map(([id]) => id))];
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
  const chose = (s, value) => choicesMade.filter(([, v, key]) => v === value && key === s.key).map(([id]) => id);
  const sections = Pairing.pairSections(forEngine(current), (s) => ({
    halfByes: chose(s, "half"),
    zeroByes: chose(s, "zero"),
    absent: chose(s, "absent"),
    out: withdrawn,
    coin: current.coin,
  }));
  // A round robin's table pairs absent players too; their games are forfeits.
  const away = new Set(choicesMade.filter(([, v]) => v === "absent").map(([id]) => id));
  for (const s of sections.filter(Pairing.roundRobin)) {
    for (const g of s.games) {
      if (away.has(g.white) || away.has(g.black)) g.result = away.has(g.white) ? (away.has(g.black) ? "0F-0F" : "0F-1F") : "1F-0F";
    }
  }
  draft = { number, sections: sections.map(({ format, ...s }) => s) };
  if (withdrawn.length) current.players.forEach((p) => { if (withdrawn.includes(p.id)) p.out = number; });
  renderDraft();
});

// By hand, the players marked present start out not yet paired, as does everyone when nobody is
// marked present; the others are unplayed, except in a round robin, where the TD gives them forfeits.
document.querySelector(".run-by-hand").addEventListener("click", async () => {
  const number = current.rounds.length + 1;
  const { choicesMade, withdrawn } = await checkIn(number);
  current.players.forEach((p) => { if (withdrawn.includes(p.id)) p.out = number; });
  const chosen = new Map(choicesMade.map(([id, v, key]) => [`${key}|${id}`, v]));
  const anyone = choicesMade.some(([, v]) => v === "play");
  draft = { number, sections: playing(number).map((s) => {
    const part = { section: s.key, name: s.name, games: [], byes: [], waiting: [] };
    for (const p of s.players) {
      const choice = chosen.get(`${s.key}|${p.id}`);
      if (!choice || withdrawn.includes(p.id)) continue;
      const kind = { half: "half", zero: "zero", absent: anyone && !Pairing.roundRobin(s) ? "unplayed" : "" }[choice];
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

// Once a tournament has an extra games section or a round robin, each section has its own rounds, and a Swiss's change one at a time.
const plannedSection = document.getElementById("run-planned-section");

/** The Swiss sections whose rounds change one at a time, none while the sections share the tournament's. */
function plannedSections() {
  const defs = current.sections || [];
  if (!defs.some((d) => d.last)) return [];
  const swiss = new Set(Pairing.sections(forEngine(current)).filter((s) => !Pairing.roundRobin(s)).map((s) => s.key));
  return defs.filter((d) => swiss.has(d.name));
}

function fillPlanned() {
  const defs = plannedSections();
  plannedSection.hidden = document.querySelector('[for="run-planned-section"]').hidden = !defs.length;
  const chosen = plannedSection.value;
  plannedSection.replaceChildren(...defs.map((d) => option(d.name, d.name, d.name === chosen)));
  const def = defs.find((d) => d.name === plannedSection.value);
  runPlanned.elements.rounds.value = def ? def.last - (def.first || 1) + 1 : current.plannedRounds || "";
}
plannedSection.addEventListener("change", fillPlanned);

// Renaming, ordering, and changing the formats of the sections: each a name field, buttons to move it, and a format
// menu, fixed once the section has a posted round, kept as the TD left them while open.
const namesForm = document.querySelector(".run-names");
const namesWrap = namesForm.closest("details");

function renderSectionNames() {
  const defs = current.sections || [];
  namesWrap.hidden = !defs.length;
  if (namesWrap.open && namesForm.dataset.key === current.key) return;
  namesForm.dataset.key = current.key;
  const list = namesForm.querySelector(".run-names-list");
  const parts = Pairing.sections(forEngine(current));
  list.replaceChildren(...defs.map((d) => {
    const item = document.createElement("li");
    item.dataset.from = d.name;
    const format = formatMenu(parts.find((s) => s.key === d.name)?.format, { className: "run-names-format" });
    format.setAttribute("aria-label", `Format of ${d.name}`);
    format.disabled = current.rounds.some((r) => r.posted && r.games.concat(r.byes).some((x) => x.section === d.name));
    const name = Object.assign(document.createElement("input"), { type: "text", value: d.name, maxLength: 30, autocomplete: "off" });
    name.setAttribute("aria-label", `New name for ${d.name}`);
    const move = (text, step) => editButton(text, ` ${d.name}`, `${d.name}-${text}`, () => {
      const other = step < 0 ? item.previousElementSibling : item.nextElementSibling;
      if (!other) return;
      if (step < 0) other.before(item);
      else other.after(item);
      item.querySelector(`[data-focus="${CSS.escape(`${d.name}-${text}`)}"]`).focus();
      runStatus.textContent = `${d.name} is ${[...list.children].indexOf(item) + 1} of ${list.children.length}.`;
    });
    item.append(name, format, move("Up", -1), move("Down", 1));
    return item;
  }));
}

namesForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const sections = [...namesForm.querySelectorAll(".run-names-list li")].map((li) => ({ from: li.dataset.from, name: li.querySelector("input").value.trim(),
    format: li.querySelector(".run-names-format").value }));
  const changed = sections.filter((x) => x.format !== Pairing.sections(forEngine(current)).find((s) => s.key === x.from)?.format);
  if (changed.length && !confirm(`Change the format of ${changed.map((x) => x.from).join(" and ")}? Any of its pairings saved but not posted are deleted,`
    + " and a round robin draws its players' numbers by lot.")) return;
  const [event, date] = keyParts();
  const result = await call("sectionNames", { event, date, sections: JSON.stringify(sections) });
  if (result.ok) {
    namesWrap.open = false;
    await loadRun();
  }
  runStatus.textContent = result.message || result.error;
});

const extraForm = document.querySelector(".run-extra");

// td.js's entries list for the chosen event, for the entrants who aren't players yet.
let deskEntries = { key: "", entries: [] };
document.addEventListener("td-entries", (event) => {
  deskEntries = event.detail;
  if (current && current.key === deskEntries.key && !runManage.hidden) renderExtras();
});

/** Registered entrants who aren't players, as quads never add late entrants: they may play in an
 *  extra games section only. */
function entrantsNotPlaying() {
  if (deskEntries.key !== current.key) return [];
  const have = new Set(current.players.map((p) => p.id));
  return [...new Map(deskEntries.entries.filter((e) => !e.out && !have.has(e.id)).map((e) => [e.id, e])).values()];
}

const entrantLabel = (e) => `${e.name} (${e.rating || "unrated"}), entered, not in ${current.format === "quad" ? "a quad" : "a section"} yet`;

/** The extra games sections, each with a button to take it off until it's posted and a menu to add
 *  a player, and the form to add one, all its players chosen at first: those not withdrawn, in
 *  number order, then the entrants who aren't players, not chosen. */
function renderExtras() {
  const list = document.querySelector(".run-extra-list");
  const extras = (current.sections || []).filter((d) => d.extra);
  const entrants = entrantsNotPlaying();
  extraForm.closest("details").hidden = !["swiss", "quad"].includes(current.format) || !(current.sections || []).length;
  list.replaceChildren(...extras.map((d) => {
    const item = document.createElement("li");
    const first = d.first, last = d.last;
    const kind = { rr: " a round robin,", drr: " a double round robin," }[d.format] || "";
    item.append(`${d.name}: ${d.players.length} players,${kind} ${first === last ? `round ${first}` : `rounds ${first} to ${last}`}. `);
    const posted = current.rounds.some((r) => r.posted && r.games.concat(r.byes).some((x) => x.section === d.name));
    if (!posted) {
      item.append(editButton("Take off", ` ${d.name}`, `drop-${d.name}`, async () => {
        if (!confirm(`Take off ${d.name}? Any of its pairings saved but not posted are deleted.`)) return;
        const [event, date] = keyParts();
        const result = await call("dropSection", { event, date, section: d.name });
        if (result.ok) await loadRun();
        runStatus.textContent = result.message || result.error;
      }));
    }
    const finished = current.rounds[last - 1]?.games.concat(current.rounds[last - 1].byes).some((x) => x.section === d.name);
    const candidates = [...current.players.filter((p) => !p.out && !d.players.includes(p.id)).map((p) => option(p.id, nameOf(p.id), false)),
      ...entrants.map((e) => option(e.id, entrantLabel(e), false))];
    if (!finished && candidates.length) {
      const menu = Object.assign(document.createElement("select"), { className: "run-extra-add" });
      menu.setAttribute("aria-label", `Player to add to ${d.name}`);
      menu.append(...candidates);
      item.append(" ", menu, " ", editButton("Add a player", ` to ${d.name}`, `add-${d.name}`, async () => {
        const [event, date] = keyParts();
        const result = await call("extraPlayer", { event, date, section: d.name, id: menu.value });
        if (result.ok) await loadRun();
        runStatus.textContent = result.message || result.error;
      }));
    }
    return item;
  }));
  const boxes = extraForm.querySelector(".run-extra-players");
  // Redrawn with each change, keeping the TD's choices.
  const chosen = new Map([...boxes.querySelectorAll("input")].map((box) => [box.value, box.checked]));
  if (extraForm.dataset.key !== current.key) {
    extraForm.dataset.key = current.key;
    chosen.clear();
    const names = new Set((current.sections || []).map((d) => d.name.toLowerCase()));
    let name = "Extra games";
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `Extra games ${n}`;
    extraForm.elements.name.value = name;
    extraForm.elements.rounds.value = "1";
    extraForm.elements.format.value = "swiss";
    showExtraRounds();
  }
  const box = (id, text, checked) => {
    const label = document.createElement("label");
    label.append(Object.assign(document.createElement("input"), { type: "checkbox", value: id, checked: chosen.get(id) ?? checked }), ` ${text}`);
    return label;
  };
  boxes.replaceChildren(...current.players.filter((p) => !p.out).map((p) => box(p.id, nameOf(p.id), true)),
    ...entrants.map((e) => box(e.id, entrantLabel(e), false)));
}

// A round robin's players set its rounds.
function showExtraRounds() {
  const swiss = extraForm.elements.format.value === "swiss";
  extraForm.elements.rounds.hidden = extraForm.querySelector('[for="run-extra-rounds"]').hidden = !swiss;
}
extraForm.elements.format.addEventListener("change", showExtraRounds);

extraForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const players = [...extraForm.querySelectorAll(".run-extra-players input:checked")].map((box) => box.value);
  const [event, date] = keyParts();
  const result = await call("extraSection", { event, date, name: extraForm.elements.name.value.trim(),
    format: extraForm.elements.format.value, rounds: extraForm.elements.rounds.value.trim(), players: JSON.stringify(players) });
  if (result.ok) {
    delete extraForm.dataset.key;
    extraForm.closest("details").open = false;
    await loadRun();
  }
  runStatus.textContent = result.message || result.error;
});

runPlanned.addEventListener("submit", async (e) => {
  e.preventDefault();
  const [event, date] = keyParts();
  const result = await call("rounds", { event, date, rounds: runPlanned.elements.rounds.value.trim(),
    ...(plannedSection.hidden ? {} : { section: plannedSection.value }) });
  if (result.ok) await loadRun();
  runStatus.textContent = `${result.message || result.error} ${result.ok ? runStatus.textContent : ""}`.trim();
});

document.querySelector(".run-restart").addEventListener("click", async () => {
  const typed = prompt(`Restart ${current.name}? This deletes its players, pairings, and results, and the rating report files in its folder. `
    + "Entries stay registered. Type the tournament's name to restart it.", "");
  if (typed === null) return;
  if (typed.trim().toLowerCase() !== current.name.trim().toLowerCase()) {
    runStatus.textContent = `That isn't ${current.name}, so nothing was restarted.`;
    return;
  }
  const [event, date] = keyParts();
  const result = await call("restart", { event, date });
  if (result.ok) {
    draft = null;
    await loadRun();
  }
  runStatus.textContent = result.message || result.error;
});

document.addEventListener("td-choice", loadRun);