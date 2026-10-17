// The Pairings page (pairings/) and the Standings page (standings/): each tournament in progress,
// section by section, from the registration script's ?tournaments=current. Pairings shows one
// round at a time, the latest posted unless a reader picks an earlier one; Standings shows the
// standings after a round, the latest with results unless a reader picks an earlier one. An
// arena's games and queue are on Pairings, its leaderboard on Standings. With LIVE_DB set, the
// pages follow the database's public copy of the same tournaments instead, and redraw as it changes.
// ENDPOINT, LIVE_DB, byesText, and the saved players and their list come from register.js, listenLive
// from live.js, Pairing from pairing.js, and Arena from arena.js.

const pairingsStatus = document.querySelector(".pairings-status");
const pairingsAll = document.querySelector(".pairings-all");
const standingsAll = document.querySelector(".standings-all");
const SHOWN = { "1-0": "1–0", "0-1": "0–1", "1/2-1/2": "½–½", "1F-0F": "1F–0F", "0F-1F": "0F–1F", "0F-0F": "0F–0F" };

/** A table in a box that scrolls sideways; a label makes the box a region the keyboard can scroll. */
function tableOf(headings, rows, label) {
  const table = document.createElement("table");
  table.className = "entries";
  const head = table.createTHead().insertRow();
  for (const h of headings) {
    const th = document.createElement("th");
    th.scope = "col";
    th.append(h);
    head.append(th);
  }
  const body = table.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    for (const c of cells) row.insertCell().textContent = c;
  }
  const wrap = document.createElement("div");
  wrap.className = "td-table";
  if (label) {
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", label);
    wrap.tabIndex = 0;
  }
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

// The rounds a reader picked other than the latest, by tournament and section, so a redraw keeps them.
const picked = new Map();

/** A labelled menu of rounds that redraws what follows it, starting at the one picked before or
 *  else the latest. draw gets the round. */
function roundMenu(id, label, section, rounds, memo, draw) {
  const latest = rounds.at(-1)[0];
  const chosen = rounds.some(([value]) => value === picked.get(memo)) ? picked.get(memo) : latest;
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
  const redraw = () => shown.replaceChildren(...draw(Number(select.value)));
  shown.append(...draw(chosen));
  select.addEventListener("change", () => {
    if (Number(select.value) === latest) picked.delete(memo);
    else picked.set(memo, Number(select.value));
    redraw();
  });
  menu.append(name, " ", select);
  return [menu, shown];
}

function namer(t) {
  return (id) => {
    const p = t.players.find((x) => x.id === id);
    return p ? `${p.name} (${p.rating ?? "unrated"})` : id;
  };
}

/** "Byes asked for: Ann (1500), round 3; …", posted with the pairings (22C4): the half-point byes asked
 *  for in rounds not yet posted, since a posted round's are under "Without a game". */
function byesAsked(t, s, name) {
  if (t.format !== "swiss" || t.status !== "running") return [];
  const asked = s.players.map((p) => [p, (p.byes || []).filter((n) => n > s.rounds.length && !(p.out && n >= p.out))])
    .filter(([, later]) => later.length).map(([p, later]) => {
      const nights = later.map((n) => t.roundDates?.[n - 1]);
      return `${name(p.id)}, ${nights.every(Boolean) ? byesText(nights) : byesText(later).replace(/^Round/, "round")}`;
    });
  return asked.length ? [paragraph(`Byes asked for: ${asked.join("; ")}.`)] : [];
}

/** The sections with players, and whether to head each with its name. */
function partsOf(t) {
  const parts = Pairing.sections({ format: t.format, sections: t.sections || [], players: t.players, rounds: t.rounds })
    .filter((s) => s.players.length);
  return { parts, several: parts.length > 1 };
}

// Players report their own games' results on the Pairings page, for the boards of the players
// saved on this device: those the Register form saved (register.js), and any found here by US
// Chess ID, which are saved the same way. Nothing proves who is reporting, so a report counts
// only once the TD confirms it on the desk.
const found = new Set();
const mine = () => new Set([...savedPlayers().map((p) => p.id), ...found]);
const reported = new Map();
const sending = new Set();
// Reports this device sent, until the tournament as loaded shows them: where => [side, result].
const claimed = new Map();
const whereOf = (t, number, g) => `${t.key}|${number}|${g.section || ""}|${g.board}`;
// Redraws every tournament, for a change made here; set once the tournaments load.
let redrawAll = () => {};

function withClaim(t, number, g) {
  const where = whereOf(t, number, g);
  const [side, value] = claimed.get(where) || [];
  if (!side) return g;
  if (g.reports?.[side] === value) {
    claimed.delete(where);
    return g;
  }
  return { ...g, reports: { ...g.reports, [side]: value } };
}

/** The TD's result, or else what the players reported, until the TD confirms it. */
function shownResult(g) {
  if (g.result) return SHOWN[g.result] || "";
  const sent = [g.reports?.white, g.reports?.black].filter(Boolean);
  if (!sent.length) return "";
  return sent.every((r) => r === sent[0]) ? `${SHOWN[sent[0]]}, reported, awaiting the TD` : "Reports differ, awaiting the TD";
}

/** One-tap buttons that report a board's result for the player saved here. */
function reportBox(t, number, g, name) {
  const id = mine().has(g.white) ? g.white : g.black;
  const side = id === g.white ? "white" : "black";
  const where = whereOf(t, number, g);
  const box = document.createElement("div");
  box.className = "report";
  const called = (who) => t.players.find((p) => p.id === who)?.name || who;
  box.append(paragraph(`Board ${g.board}: ${name(g.white)} with white, ${name(g.black)} with black. Report the result:`));
  const buttons = document.createElement("p");
  buttons.className = "td-buttons";
  const status = Object.assign(paragraph(sending.has(where) ? "Sending…" : reported.get(where) || ""), { className: "register-hint" });
  status.setAttribute("role", "status");
  for (const [value, text] of [["1-0", `1–0, ${called(g.white)} won`], ["0-1", `0–1, ${called(g.black)} won`], ["1/2-1/2", "½–½, a draw"]]) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "td-action", textContent: text });
    button.setAttribute("aria-pressed", String(g.reports?.[side] === value));
    button.disabled = sending.has(where);
    button.addEventListener("click", async () => {
      const [event, date] = t.key.split("/");
      for (const b of buttons.children) b.disabled = true;
      status.textContent = "Sending…";
      sending.add(where);
      try {
        const response = await fetch(ENDPOINT, { method: "POST", body: new URLSearchParams({ action: "report", event, date, number,
          board: g.board, section: g.section || "", id, result: value }) });
        const result = await response.json();
        if (result.ok) claimed.set(where, [side, value]);
        reported.set(where, result.message || result.error);
      } catch {
        reported.set(where, "The report didn't go through. Try again, or tell the TD.");
      }
      sending.delete(where);
      redrawAll();
      const again = document.querySelector(`.report[data-where="${CSS.escape(where)}"]`);
      (again?.querySelector('[aria-pressed="true"]') || again?.querySelector("button"))?.focus();
    });
    buttons.append(button);
  }
  box.dataset.where = where;
  box.dataset.players = `${g.white} ${g.black}`;
  box.append(buttons, status);
  return box;
}

/** A form to find a player's board by US Chess ID, which saves the player on this device as the
 * Register form does: the same list, most recent first, with the same Remember choice. */
function findForm(current, render) {
  const form = document.createElement("form");
  form.className = "register-form report-find";
  const status = Object.assign(paragraph(""), { className: "register-hint" });
  status.setAttribute("role", "status");
  const savedBox = newSavedBox();
  const input = Object.assign(document.createElement("input"), { id: "report-id", name: "uschess-id", type: "text",
    inputMode: "numeric", pattern: "[0-9]{8}", maxLength: 8, autocomplete: "on", required: true });
  input.setAttribute("aria-describedby", "report-id-hint");
  const hint = Object.assign(paragraph("To report your game's result, find your board."), { id: "report-id-hint", className: "register-hint" });
  const remember = newRemember("report-remember");
  const choice = remember.querySelector("input");
  const button = Object.assign(document.createElement("button"), { type: "submit", className: "button", textContent: "Find my board" });
  form.append(savedBox, Object.assign(document.createElement("label"), { htmlFor: "report-id", textContent: "Playing? Your US Chess ID" }),
    input, hint, remember, button, status);

  const boxOf = (id) => pairingsAll.querySelector(`.report[data-players~="${CSS.escape(id)}"]`);
  const showSaved = () => showSavedIn(savedBox, (p) => {
    const box = boxOf(p.id);
    status.textContent = box ? `${playerName(p)}: report the result with the buttons below the board.`
      : `${playerName(p)} has no game to report in the round shown.`;
    box?.querySelector("button").focus();
  }, (p) => {
    found.delete(p.id);
    render();
    status.textContent = `${playerName(p)} is no longer saved on this device.`;
  }, input);
  form.showSaved = showSaved;
  // As on the Register form, the most recent player saved here is filled in.
  const [latest] = savedPlayers();
  if (latest) input.value = latest.id;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = input.value.trim();
    if (!/^\d{8}$/.test(id)) return void (status.textContent = "A US Chess ID is eight digits.");
    const player = current().filter((t) => t.status === "running" && t.format !== "arena")
      .flatMap((t) => t.players).find((p) => p.id === id);
    if (!player) return void (status.textContent = "Nobody with that US Chess ID is playing in a tournament in progress.");
    found.add(id);
    const saved = savedPlayers();
    // A player the Register form saved keeps their last name and email.
    const kept = saved.find((p) => p.id === id) || { id, last: "", email: "", name: player.name };
    const stored = choice.checked && storePlayers([kept, ...saved.filter((p) => p.id !== id)]);
    input.value = "";
    render();
    const box = boxOf(id);
    status.textContent = `${stored ? `${player.name} is saved on this device.` : `Found ${player.name}.`} ${box
      ? "Report your game's result with the buttons below its board." : "Once your board is posted, buttons to report its result appear below it."}`;
    (box?.querySelector("button") || input).focus();
  });
  return form;
}

const RECENT = 12;

function arenaPairings(section, t, name) {
  if (t.cutoff && t.status !== "rated") section.append(paragraph(`No new games start after ${clock(t.cutoff)}.`));
  const playing = t.games.filter((g) => !g.result);
  const pact = (g, side) => name(g[side]) + (g[`${side}Pact`] ? ", Blood Pact" : "");
  if (playing.length) {
    section.append(heading(3, "Games in progress"),
      tableOf(["Game", "White", "Black"], playing.map((g) => [g.game, pact(g, "white"), pact(g, "black")])));
  } else if (t.status !== "rated") {
    section.append(paragraph("No games in progress."));
  }
  const waiting = Arena.waiting(t);
  if (waiting.length && t.status !== "rated") section.append(paragraph(`Waiting for a game: ${waiting.map(name).join(", ")}.`));
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
  section.append(heading(3, t.status === "rated" ? "Final leaderboard" : "Leaderboard"),
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
    section.append(paragraph("Round 1 hasn't been posted yet."), ...byesAsked(t, t, name));
    return section;
  }
  const { parts, several } = partsOf(t);
  const kind = (b) => ({ bye: "full-point bye", half: "half-point bye", zero: "zero-point bye", unplayed: "unplayed" })[Pairing.byeKind(b)];
  parts.forEach((s, si) => {
    if (several) section.append(heading(3, s.name));
    // An extra games section numbers its own rounds from 1; the script knows each by the tournament's.
    const planned = s.last ? s.last - s.first + 1 : t.plannedRounds;
    const of = planned ? ` of ${planned}` : "";
    if (!s.rounds.length) return void section.append(paragraph("Round 1 hasn't been posted yet."));
    const rounds = s.rounds.map((_, i) => [i + 1, `${i + 1}${of}`]);
    const draw = (n) => {
      const round = s.rounds[n - 1];
      const number = s.first + n - 1;
      const games = round.games.map((g) => withClaim(t, number, g));
      const shown = [tableOf(["Board", "White", "Black", "Result"],
        games.map((g) => [g.board, name(g.white), name(g.black), shownResult(g)]))];
      if (round.byes.length) shown.push(paragraph(`Without a game: ${round.byes.map((b) => `${name(b.id)}, ${kind(b)}`).join("; ")}.`));
      if (t.status === "running") {
        const ids = mine();
        for (const g of games) if (!g.result && (ids.has(g.white) || ids.has(g.black))) shown.push(reportBox(t, number, g, name));
      }
      return shown;
    };
    section.append(...byesAsked(t, s, name), ...roundMenu(`round-${ti}-${si}`, "Round", several ? s.name : "", rounds, `${t.key}|${s.name}`, draw));
  });
  return section;
}

/** Quad head-to-head counts only between players tied on score and Sonneborn-Berger. */
function headToHead(r, rows) {
  return rows.some((x) => x !== r && x.score === r.score && x.sonnebornBerger === r.sonnebornBerger) ? r.headToHead : "";
}

const ESTIMATE = "Est. rating estimates the regular rating US Chess will give each player for the games played so far, by its "
  + "published formula, from their rating as entered, their floor, and their rated games before the event. Checked against US "
  + "Chess's own ratings of a 63-player section, it was within a point for three players in four and within 10 for most of the "
  + "rest. It is further off for an unrated player, whom US Chess starts from their age or another rating, for a rating that "
  + "changed after the player entered, and for players over 2200 in some time controls. The official rating comes from US Chess "
  + "once the event is rated.";

// The Est. rating heading's ? shows ESTIMATE in a popover, since the table's sideways scrolling would clip a
// tooltip inside it. It shows on hover, focus, or a tap, stays while the pointer is on it, and Escape hides it.
let estimateTip = null;
let tipFor = null;
let tipTimer = 0;

function estimateHeading() {
  if (!estimateTip) {
    estimateTip = Object.assign(document.createElement("div"), { id: "estimate-tip", className: "hint-text hint-pop", textContent: ESTIMATE });
    estimateTip.popover = "manual";
    estimateTip.setAttribute("role", "tooltip");
    estimateTip.addEventListener("pointerenter", () => clearTimeout(tipTimer));
    estimateTip.addEventListener("pointerleave", hideTip);
    document.body.append(estimateTip);
    document.addEventListener("keydown", (event) => event.key === "Escape" && hideTip());
    document.addEventListener("click", (event) => !event.target.closest(".hint-button, .hint-pop") && hideTip());
    addEventListener("scroll", hideTip, { capture: true, passive: true });
  }
  const button = Object.assign(document.createElement("button"), { type: "button", className: "hint-button", textContent: "?" });
  button.setAttribute("aria-label", "About Est. rating");
  button.setAttribute("aria-describedby", estimateTip.id);
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("pointerenter", () => showTip(button));
  button.addEventListener("pointerleave", () => { tipTimer = setTimeout(hideTip, 300); });
  button.addEventListener("focus", () => showTip(button));
  button.addEventListener("blur", hideTip);
  button.addEventListener("click", () => showTip(button));
  const heading = document.createDocumentFragment();
  heading.append("Est. rating ", button);
  return heading;
}

/** Opens the tip under the button, or over it near the bottom of the window, inside the window's edges. */
function showTip(button) {
  clearTimeout(tipTimer);
  if (tipFor && tipFor !== button) tipFor.setAttribute("aria-expanded", "false");
  tipFor = button;
  button.setAttribute("aria-expanded", "true");
  if (!estimateTip.matches(":popover-open")) estimateTip.showPopover();
  const at = button.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = estimateTip;
  estimateTip.style.left = `${Math.max(16, Math.min(at.right - width, innerWidth - width - 16))}px`;
  estimateTip.style.top = `${at.bottom + 6 + height > innerHeight ? Math.max(8, at.top - 6 - height) : at.bottom + 6}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  if (estimateTip?.matches(":popover-open")) estimateTip.hidePopover();
  tipFor?.setAttribute("aria-expanded", "false");
  tipFor = null;
}

/** A player's rounds, each as the result, the opponent's place in the table, and the color: "W4 b". */
function roundCells(t, rows) {
  const place = new Map(rows.map((r, i) => [r.id, r.place ?? i + 1]));
  const rounds = Pairing.roundByRound(t);
  return (id) => rounds.get(id).map((x) => `${x.code}${x.opponent ? place.get(x.opponent) : ""}${x.color ? ` ${x.color}` : ""}`);
}

function standingsSection(t, ti) {
  const section = document.createElement("section");
  section.append(heading(2, t.name));
  if (t.format === "arena") return arenaStandings(section, t);
  const name = namer(t);
  const { parts, several } = partsOf(t);
  const scored = (round) => round.games.some((g) => g.result) || (!round.games.length && round.byes.length);
  if (!parts.some((s) => s.rounds.some(scored))) {
    section.append(paragraph("Standings appear here once round 1 has results."));
    return section;
  }
  // A Swiss's tiebreaks, and an extra games section's, are in the page's opening paragraph.
  if (parts.some((s) => s.format === "quad")) {
    section.append(paragraph("Each quad is ranked by score, then Sonneborn-Berger, then the games between tied players (34F). "
      + "Players tied on all three share a place."));
  }
  parts.forEach((s, si) => {
    if (several) section.append(heading(3, s.name));
    const quad = s.format === "quad";
    const rounds = s.rounds.map((round, i) => [i + 1, round]).filter(([, round]) => scored(round))
      .map(([n, round]) => [n, `${n}${round.games.every((g) => g.result) ? "" : " (in progress)"}`]);
    if (!rounds.length) {
      section.append(paragraph("No results yet."), ...byesAsked(t, s, name));
      return;
    }
    const draw = (n) => {
      const sofar = { players: s.players, rounds: s.rounds.slice(0, n) };
      const heads = sofar.rounds.map((_, i) => `Round ${i + 1}`);
      const label = `${several ? s.name : t.name} standings`;
      if (quad) {
        const rows = Pairing.quadStandings(sofar);
        const cells = roundCells(sofar, rows);
        return [tableOf(["Place", "Name", "Rating", "Score", ...heads, "Sonneborn-Berger", "Head-to-head", "Performance", estimateHeading()],
          rows.map((r) => [r.place, r.name, r.rating ?? "Unrated", r.score, ...cells(r.id), r.sonnebornBerger, headToHead(r, rows),
            r.performance ?? "", r.estimate ?? ""]), label)];
      }
      const rows = Pairing.standings(sofar);
      const cells = roundCells(sofar, rows);
      return [tableOf(["Place", "Name", "Rating", "Score", ...heads, "Median", "Solkoff", "Cumulative", "Opp. cumulative", "Performance",
        estimateHeading()],
        rows.map((r, i) => [i + 1, r.name, r.rating ?? "Unrated", r.score, ...cells(r.id), r.median, r.solkoff, r.cumulative, r.opposition,
          r.performance ?? "", r.estimate ?? ""]), label)];
    };
    section.append(...roundMenu(`after-${ti}-${si}`, "After round", several ? s.name : "", rounds, `${t.key}|${s.name}`, draw),
      ...byesAsked(t, s, name));
  });
  return section;
}

const onStandings = Boolean(standingsAll);
const shownAll = onStandings ? standingsAll : pairingsAll;
const sectionOf = onStandings ? standingsSection : pairingsSection;
let current = [];
let loaded = false;
let finder = null;
// Each tournament's section as last drawn, with the tournament it was drawn from.
const drawn = new Map();

/** A selector for the focused control that finds its counterpart once redrawn. */
function focusKey(control) {
  if (!control || !shownAll.contains(control)) return "";
  if (control.id) return `#${CSS.escape(control.id)}`;
  const box = control.closest(".report");
  if (!box) return "";
  return `.report[data-where="${CSS.escape(box.dataset.where)}"] .td-buttons > :nth-child(${[...control.parentNode.children].indexOf(control) + 1})`;
}

/** Draws the tournaments, only those that changed unless all, keeping the reader's place: the
 *  rounds picked, the scroll, the focus, and the find form as it is, mid-entry or not. */
function drawTournaments(all = false) {
  const message = current.length ? "" : onStandings ? "No tournament is in progress. Standings appear here as results come in."
    : "No tournament is in progress. Pairings appear here as each round is posted.";
  if (pairingsStatus.textContent !== message) pairingsStatus.textContent = message;
  const reporting = !onStandings && current.some((t) => t.status === "running" && t.format !== "arena" && t.rounds.length);
  if (reporting && !finder) {
    finder = findForm(() => current, () => drawTournaments(true));
    all = true;
  }
  const sections = current.map((t, ti) => {
    const source = `${ti} ${JSON.stringify(t)}`;
    const before = drawn.get(t.key);
    if (!all && before?.source === source) return before.section;
    const section = sectionOf(t, ti);
    drawn.set(t.key, { source, section });
    return section;
  });
  const wanted = [...(reporting ? [finder] : []), ...sections];
  const focused = document.activeElement;
  const key = focusKey(focused);
  const y = scrollY;
  for (const child of [...shownAll.children]) if (!wanted.includes(child)) child.remove();
  wanted.forEach((node, i) => {
    if (shownAll.children[i] !== node) shownAll.insertBefore(node, shownAll.children[i] || null);
  });
  if (reporting && all) finder.showSaved();
  if (key && !focused.isConnected) shownAll.querySelector(key)?.focus({ preventScroll: true });
  if (scrollY !== y) scrollTo(scrollX, y);
}

function showTournaments(list) {
  current = list;
  loaded = true;
  drawTournaments();
}

function loadOnce() {
  fetch(`${ENDPOINT}?tournaments=current`)
    .then((response) => response.json())
    .then(({ tournaments = [] }) => showTournaments(tournaments))
    .catch(() => {
      if (!loaded) pairingsStatus.textContent = `The ${onStandings ? "standings" : "pairings"} couldn't be loaded. Try again later.`;
    });
}

redrawAll = () => drawTournaments(true);
if (!ENDPOINT) {
  pairingsStatus.textContent = `${onStandings ? "Standings" : "Pairings"} will be posted here once tournaments are run online.`;
} else if (!LIVE_DB) {
  loadOnce();
} else {
  // Each tournament is a JSON string of what ?tournaments=current gives for it. A stream that
  // can't start, or stops for good, leaves the page as the script last served it.
  let heard = false;
  const stop = listenLive("/public/tournaments", (value) => {
    heard = true;
    showTournaments(Object.values(value || {}).flatMap((text) => {
      try {
        return [JSON.parse(text)];
      } catch {
        return [];
      }
    }));
  }, (final) => {
    if (heard && !final) return;
    stop();
    loadOnce();
  });
}
