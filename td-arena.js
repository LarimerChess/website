// The TD desk's arena: its sections (time controls, each US Chess rated or not), the players and
// where each is available, pairing the players waiting with arena.js or starting a game by hand,
// the games in progress with the results players reported, their Blood Pacts and results, and
// the leaderboard. td-run.js loads the tournament and calls renderArena, and reads the start form's
// sections with readArenaSections; current, nameOf, keyParts, option, and loadRun come from it, and
// call and hidden from td.js.

const runPlayers = document.querySelector(".run-players");
const arenaGames = document.querySelector(".run-arena-games");
const arenaNone = document.querySelector(".run-arena-none");
const arenaConfirm = document.querySelector(".run-arena-confirm");
const arenaStartForm = document.querySelector(".run-arena-start");
const arenaSectionsWrap = document.querySelector(".run-arena-sections-wrap");
const arenaSectionsForm = document.querySelector(".run-arena-sections-form");
const leaderboard = document.querySelector(".run-leaderboard");
const arenaBoards = document.querySelector(".run-arena-boards");
const arenaDone = document.querySelector(".run-arena-done");
const arenaPairButton = document.querySelector(".run-arena-pair");
const ARENA_RESULTS = [["1-0", "1–0", ""], ["0-1", "0–1", ""], ["1/2-1/2", "½–½", ""],
  ["1F-0F", "1F–0F", "black forfeits"], ["0F-1F", "0F–1F", "white forfeits"], ["0F-0F", "0F–0F", "both forfeit"]];
const SHOWN_RESULT = Object.fromEntries(ARENA_RESULTS.map(([value, text]) => [value, text]));
// The sections a Knightmare arena starts with; the TD changes them before starting.
const KNIGHTMARE = [{ name: "Classical", timeControl: "G/30;+30", rated: true },
  { name: "Blood Pact", timeControl: "G/15;+15 against G/30;+30", rated: false, pact: true }, { name: "Rapid", timeControl: "G/15;+15", rated: true }];

const forArena = (t) => ({ sections: t.sections || [], players: t.players, games: t.games, queue: t.queue });

function actionButton(text, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "td-action";
  button.textContent = text;
  if (label) button.append(hidden(label));
  button.addEventListener("click", onClick);
  return button;
}

async function arenaCall(action, fields, button) {
  const [event, date] = keyParts();
  if (button) button.disabled = true;
  const result = await call(action, { event, date, ...fields });
  if (result.ok) {
    await loadRun();
    if (result.message) runStatus.textContent = `${result.message} ${runStatus.textContent}`;
  } else {
    runStatus.textContent = result.error;
    if (button) button.disabled = false;
  }
  return result;
}

// The sections editor: rows of name, time control, US Chess rated, and Blood Pact, in the start form
// and under Sections while the arena runs.
let arenaSectionRow = 0;
function addArenaSectionRow(rows, section = {}) {
  const n = ++arenaSectionRow;
  const row = document.createElement("div");
  row.className = "run-arena-section-row";
  row.dataset.from = section.from ?? "";
  const field = (label, id, value, attributes) => {
    const box = document.createElement("div");
    const input = Object.assign(document.createElement("input"), { id, type: "text", value: value ?? "", autocomplete: "off", ...attributes });
    box.append(Object.assign(document.createElement("label"), { htmlFor: id, textContent: label }), input);
    return box;
  };
  const check = (className, id, text, checked) => {
    const wrap = document.createElement("div");
    wrap.className = "run-arena-section-check";
    const box = Object.assign(document.createElement("input"), { id, type: "checkbox", checked, className });
    wrap.append(box, Object.assign(document.createElement("label"), { htmlFor: id, textContent: text }));
    return [wrap, box];
  };
  const [rated, ratedBox] = check("run-arena-section-rated-box", `run-arena-rated-${n}`, "US Chess rated", section.rated !== false && !section.pact);
  const [pact, pactBox] = check("run-arena-section-pact-box", `run-arena-section-pact-${n}`, "Blood Pact", Boolean(section.pact));
  // A Blood Pact section's games are time odds, which US Chess can't rate.
  const timeOdds = () => {
    ratedBox.disabled = pactBox.checked;
    if (pactBox.checked) ratedBox.checked = false;
  };
  pactBox.addEventListener("change", timeOdds);
  timeOdds();
  const checks = document.createElement("div");
  checks.className = "run-arena-section-checks";
  checks.append(rated, pact);
  const remove = Object.assign(document.createElement("button"), { type: "button", className: "td-action", textContent: "Remove" });
  remove.append(hidden(` section ${rows.children.length + 1}`));
  remove.addEventListener("click", () => row.remove());
  row.append(field("Section", `run-arena-name-${n}`, section.name, { maxLength: 30, className: "run-arena-section-name" }),
    field("Time control", `run-arena-control-${n}`, section.timeControl, { maxLength: 40, spellcheck: false, className: "run-arena-section-control" }),
    checks, remove);
  rows.append(row);
}

function fillArenaSections(fieldset, defs) {
  const rows = fieldset.querySelector(".run-arena-section-rows");
  rows.replaceChildren();
  for (const s of defs) addArenaSectionRow(rows, s);
}

/** The sections typed in, [{ from, name, timeControl, rated, pact }], or an error; none is an arena in one section. */
function readArenaSections(fieldset) {
  const list = [...fieldset.querySelectorAll(".run-arena-section-row")].map((row) => ({ from: row.dataset.from,
    name: row.querySelector(".run-arena-section-name").value.trim(), timeControl: row.querySelector(".run-arena-section-control").value.trim(),
    rated: row.querySelector(".run-arena-section-rated-box").checked, pact: row.querySelector(".run-arena-section-pact-box").checked }));
  if (list.some((s) => !s.name)) return { error: "Name every section, or remove it." };
  const twice = list.find((s, i) => list.findIndex((x) => x.name.toLowerCase() === s.name.toLowerCase()) !== i);
  if (twice) return { error: `Two sections are named ${twice.name}.` };
  return { sections: list };
}

for (const fieldset of document.querySelectorAll(".run-arena-sections")) {
  fieldset.querySelector(".run-arena-section-add").addEventListener("click", () => {
    addArenaSectionRow(fieldset.querySelector(".run-arena-section-rows"));
    fieldset.querySelector(".run-arena-section-row:last-child input").focus();
  });
}
fillArenaSections(document.querySelector(".run-start .run-arena-sections"), KNIGHTMARE);

/** A player's name; in a Blood Pact section, with a radio button saying whether they halved their clock,
 *  which saves as soon as it changes. */
function pactCell(row, g, side, inPact) {
  const cell = row.insertCell();
  cell.append(nameOf(g[side]));
  if (!inPact) {
    if (g[`${side}Pact`]) cell.append(" (Blood Pact)");
    return;
  }
  const label = document.createElement("label");
  label.className = "td-pact";
  const box = document.createElement("input");
  box.type = "radio";
  box.name = `run-arena-halves-${g.game}`;
  box.checked = g[`${side}Pact`];
  box.disabled = current.status === "rated";
  box.addEventListener("change", async () => {
    const result = await arenaCall("arenaPact", { game: g.game, who: side }, box);
    if (!result.ok) loadRun();
  });
  label.append(box, " Blood Pact", hidden(`, game ${g.game}, ${side}`));
  cell.append(label);
}

/** What the players reported for a game: "1–0 by both", "1–0 by White", or both sides' differing reports. */
function reportedText(g) {
  const w = SHOWN_RESULT[g.reports?.white], b = SHOWN_RESULT[g.reports?.black];
  if (w && b) return w === b ? `${w} by both` : `White ${w}, Black ${b}: see them`;
  return w ? `${w} by White` : b ? `${b} by Black` : "";
}

/** The editor under Sections, left as it is while open. */
function renderArenaSections(t) {
  arenaSectionsWrap.hidden = t.status === "rated";
  if (arenaSectionsWrap.open && arenaSectionsForm.dataset.key === t.key) return;
  arenaSectionsForm.dataset.key = t.key;
  fillArenaSections(arenaSectionsForm.querySelector(".run-arena-sections"), (t.sections || []).map((s) => ({ ...s, from: s.name })));
}

function renderArena() {
  const t = current;
  const [, date] = keyParts();
  const arena = forArena(t);
  const defs = Arena.sections(arena);
  const several = Boolean(t.sections?.length);
  const busy = Arena.busy(arena);
  const playing = t.games.filter((g) => !g.result);
  const closed = Arena.pastCutoff(date, t.cutoff, new Date());
  const running = t.status !== "rated";
  const inProgress = playing.filter(Arena.inProgress).length;
  runStatus.textContent = `${t.name}: ${t.players.length} players, ${t.games.length} games started, ${inProgress} in progress.`
    + (several ? ` Sections: ${defs.map((d) => `${d.name} (${t.games.filter((g) => g.section === d.name).length})`).join(", ")}.` : "")
    + (t.status === "rated" ? " Rated by US Chess."
      : closed && !inProgress ? ` It's past ${t.cutoff} and every game is in. Enter the games in MUIR, US Chess's ratings portal, except those marked`
        + " not rated: in a section that isn't US Chess rated, or at time odds (5C1), as a Blood Pact section's games are."
        + " The arena is complete once US Chess shows it rated with these results."
      : closed ? ` It's past ${t.cutoff}: no new games start. Games in progress finish and count.`
        : t.cutoff ? ` No new games after ${t.cutoff}.` : "");
  runArena.hidden = false;
  for (const el of runArena.querySelectorAll(".run-arena-pair, .run-arena-sync, .run-arena-start, .run-arena-confirm")) el.hidden = !running;
  arenaPairButton.disabled = closed;
  arenaStartForm.hidden = !running || closed;
  renderArenaSections(t);

  // Players: those waiting first, longest wait first, then those in a game, then everyone else.
  const entry = new Map(t.queue.map((q) => [q.id, q]));
  const waiting = Arena.waiting(arena);
  const rank = (p) => (waiting.includes(p.id) ? waiting.indexOf(p.id) : busy.has(p.id) ? 1000 : 2000);
  const players = [...t.players].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const sectionHead = runPlayers.tHead.rows[0].cells[2];
  sectionHead.textContent = several ? "Available in" : "Available";
  runPlayers.tBodies[0].replaceChildren(...players.map((p) => {
    const row = document.createElement("tr");
    const q = entry.get(p.id);
    const game = busy.has(p.id) ? t.games.find((g) => Arena.inProgress(g) && (g.white === p.id || g.black === p.id)) : null;
    row.insertCell().textContent = p.name;
    row.insertCell().textContent = p.rating ?? "Unrated";
    const toggles = document.createElement("div");
    toggles.className = "td-buttons";
    for (const def of defs) {
      const on = Boolean(q && Arena.availableIn(q, def.name));
      const toggle = actionButton(several ? def.name : "Available", ` ${p.name}${on ? ", available" : ", not available"}`, async (e) => {
        const names = defs.map((d) => d.name).filter((n) => (n === def.name ? !on : q && Arena.availableIn(q, n)));
        if (!names.length) return void arenaCall("arenaLeave", { id: p.id }, e.currentTarget);
        arenaCall("arenaJoin", { id: p.id, sections: JSON.stringify(several ? names : [""]) }, e.currentTarget);
      });
      toggle.setAttribute("aria-pressed", String(on));
      toggle.disabled = !running;
      toggles.append(toggle);
    }
    row.insertCell().append(toggles);
    row.insertCell().textContent = game ? `Game ${game.game}` : q ? `Waiting since ${String(q.since || "").slice(11, 16)}` : "Not available";
    const actions = row.insertCell();
    if (running && q) actions.append(actionButton("Take out", ` ${p.name}`, (e) => arenaCall("arenaLeave", { id: p.id }, e.currentTarget)));
    return row;
  }));

  // Start a game by hand: anyone not in a game, and the section.
  const free = players.filter((p) => !busy.has(p.id));
  for (const side of ["white", "black"]) {
    const menu = arenaStartForm.elements[side];
    const chosen = menu.value;
    menu.replaceChildren(...free.map((p) => option(p.id, `${p.name} (${p.rating ?? "unrated"})`, p.id === chosen)));
  }
  const sectionMenu = arenaStartForm.elements.section;
  const chosenSection = sectionMenu.value;
  sectionMenu.replaceChildren(...defs.map((d) => option(d.name, d.name, d.name === chosenSection)));
  sectionMenu.hidden = sectionMenu.previousElementSibling.hidden = !several;
  showHalvesMenu();

  // Games without the TD's result: in progress, or as the players reported them.
  const cells = (row, g) => {
    row.insertCell().textContent = g.game;
    const section = row.insertCell();
    section.textContent = g.section || "";
    section.hidden = !several;
    const inPact = Boolean(Arena.sectionOf(arena, g.section)?.pact);
    pactCell(row, g, "white", inPact);
    pactCell(row, g, "black", inPact);
  };
  for (const table of [arenaGames, arenaDone]) table.tHead.rows[0].cells[1].hidden = !several;
  arenaGames.tBodies[0].replaceChildren(...playing.map((g) => {
    const row = document.createElement("tr");
    cells(row, g);
    const reported = row.insertCell();
    reported.textContent = reportedText(g);
    if (Arena.disputed(g)) reported.className = "run-conflict";
    const buttons = document.createElement("div");
    buttons.className = "td-buttons";
    const agreed = Arena.resultOf(g);
    if (agreed) {
      buttons.append(actionButton(`Confirm ${SHOWN_RESULT[agreed]}`, `, game ${g.game}`, (e) => arenaCall("arenaResult", { game: g.game, result: agreed }, e.currentTarget)));
    }
    for (const [value, text, note] of ARENA_RESULTS) {
      buttons.append(actionButton(text, `${note ? ` (${note})` : ""}, game ${g.game}`, (e) => {
        if (note && !confirm(`Game ${g.game}: ${text}, ${note}? A player who forfeits is taken out of the queue.`)) return;
        arenaCall("arenaResult", { game: g.game, result: value }, e.currentTarget);
      }));
    }
    buttons.append(actionButton("Take back", `, game ${g.game}`, (e) => {
      if (confirm(`Take back game ${g.game}? It's deleted, and both players can play again.`)) arenaCall("arenaCancel", { game: g.game }, e.currentTarget);
    }));
    row.insertCell().append(buttons);
    return row;
  }));
  arenaGames.hidden = !playing.length;
  arenaNone.hidden = !!playing.length;
  arenaConfirm.hidden = !running || !playing.some((g) => Arena.resultOf(g));

  const boardRows = (a) => Arena.standings(a).map((r) => {
    const row = document.createElement("tr");
    for (const text of [`${r.place}${r.tied ? " (tied)" : ""}`, r.name, r.rating ?? "Unrated", r.points, r.games,
      `${r.streak}${r.streak >= 2 ? " (Possessed)" : ""}`]) {
      row.insertCell().textContent = text;
    }
    return row;
  });
  leaderboard.tBodies[0].replaceChildren(...boardRows(arena));
  arenaBoards.replaceChildren(...(several ? defs.flatMap((d) => {
    const table = leaderboard.cloneNode(true);
    table.className = "entries";
    table.tBodies[0].replaceChildren(...boardRows(Arena.inSection(arena, d.name)));
    const wrap = document.createElement("div");
    wrap.className = "td-table";
    wrap.append(table);
    return [Object.assign(document.createElement("h4"), { textContent: `${d.name}${d.timeControl ? `, ${d.timeControl}` : ""}${d.rated === false ? " (not US Chess rated)" : ""}` }), wrap];
  }) : []));

  arenaDone.tBodies[0].replaceChildren(...t.games.filter((g) => g.result).reverse().map((g) => {
    const row = document.createElement("tr");
    cells(row, g);
    const why = Arena.notRated(arena, g);
    if (why) row.cells[0].textContent += ` (not rated: ${why})`;
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Game ${g.game} result`);
    for (const [value, text, note] of ARENA_RESULTS) select.append(option(value, note ? `${text} (${note})` : text, value === g.result));
    select.disabled = !running;
    select.addEventListener("change", () => arenaCall("arenaResult", { game: g.game, result: select.value }, select));
    row.insertCell().append(select);
    return row;
  }));
  arenaDone.hidden = !t.games.some((g) => g.result);
}

arenaPairButton.addEventListener("click", async () => {
  const [, date] = keyParts();
  if (Arena.pastCutoff(date, current.cutoff, new Date())) {
    runStatus.textContent = `It's past ${current.cutoff}: no new games start.`;
    return;
  }
  const arena = forArena(current);
  const { games, waiting } = Arena.pair(arena);
  const pacts = Arena.sections(arena).filter((d) => d.pact && Arena.waiting(arena, d.name).length > 1).map((d) => d.name);
  const byHand = pacts.length ? ` ${pacts.join(" and ")} games start by challenge or by hand, since one player chooses to halve their clock.` : "";
  if (!games.length) {
    runStatus.textContent = (waiting.length > 1 ? "Nobody to pair: the players waiting just played each other, or share no section."
      : waiting.length ? "Only one player is waiting." : "Nobody is waiting.") + byHand;
    return;
  }
  const result = await arenaCall("arenaPair", { games: JSON.stringify(games) }, arenaPairButton);
  if (result.ok) runStatus.textContent += byHand;
});

/** The by-hand form asks who halves their clock only for a Blood Pact section. */
function showHalvesMenu() {
  const menu = arenaStartForm.elements.halves;
  const def = Arena.sectionOf(forArena(current), arenaStartForm.elements.section.value);
  menu.hidden = menu.previousElementSibling.hidden = !def?.pact;
}
arenaStartForm.elements.section.addEventListener("change", showHalvesMenu);

arenaStartForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const { white, black, section, halves } = Object.fromEntries(new FormData(arenaStartForm));
  if (!white || !black) return void (runStatus.textContent = "Choose both players.");
  if (white === black) return void (runStatus.textContent = "Choose two different players.");
  const pact = Boolean(Arena.sectionOf(forArena(current), section)?.pact);
  if (pact && halves !== "white" && halves !== "black") return void (runStatus.textContent = "Who halves their clock?");
  const game = { white, black, section: section || "", whitePact: pact && halves === "white", blackPact: pact && halves === "black" };
  arenaCall("arenaPair", { games: JSON.stringify([game]) }, arenaStartForm.querySelector("button"));
});

arenaConfirm.addEventListener("click", async (event) => {
  const agreed = current.games.filter((g) => !g.result && Arena.resultOf(g));
  event.currentTarget.disabled = true;
  for (const g of agreed) {
    const [eventName, date] = keyParts();
    const result = await call("arenaResult", { event: eventName, date, game: g.game, result: Arena.resultOf(g) });
    if (!result.ok) {
      runStatus.textContent = result.error;
      break;
    }
  }
  await loadRun();
  runStatus.textContent = `${agreed.length} ${agreed.length === 1 ? "result is" : "results are"} confirmed. ${runStatus.textContent}`;
});

arenaSectionsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const defined = readArenaSections(arenaSectionsForm.querySelector(".run-arena-sections"));
  if (defined.error) return void (runStatus.textContent = defined.error);
  arenaCall("arenaSections", { sections: JSON.stringify(defined.sections) }, arenaSectionsForm.querySelector("button[type=submit]"))
    .then((result) => { if (result.ok) arenaSectionsWrap.open = false; });
});

document.querySelector(".run-arena-refresh").addEventListener("click", loadRun);

document.querySelector(".run-arena-sync").addEventListener("click", (e) => arenaCall("sync", {}, e.currentTarget));
