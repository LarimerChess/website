// The Pairings page (pairings/) and the Standings page (standings/): each tournament in progress,
// section by section, from the registration script's ?tournaments=current. Pairings shows one
// round at a time, the latest posted unless a reader picks an earlier one; Standings shows the
// standings after a round, the latest with results unless a reader picks an earlier one. An
// arena's games and queue are on Pairings, its leaderboard on Standings. ENDPOINT, savedPlayers,
// and storePlayers come from register.js, Pairing from pairing.js, and Arena from arena.js.

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

/** A labelled menu of rounds that redraws what follows it, starting at the chosen one. draw gets
 *  the round and a function that draws it again. */
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
  const redraw = () => shown.replaceChildren(...draw(Number(select.value), redraw));
  shown.append(...draw(chosen, redraw));
  select.addEventListener("change", redraw);
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

// Players report their own games' results on the Pairings page, for the boards of the players
// saved on this device: those the Register form saved (register.js), and any found here by US
// Chess ID, which are saved the same way. Nothing proves who is reporting, so a report counts
// only once the TD confirms it on the desk.
const found = new Set();
const mine = () => new Set([...savedPlayers().map((p) => p.id), ...found]);
const reported = new Map();

/** The TD's result, or else what the players reported, until the TD confirms it. */
function shownResult(g) {
  if (g.result) return SHOWN[g.result] || "";
  const sent = [g.reports?.white, g.reports?.black].filter(Boolean);
  if (!sent.length) return "";
  return sent.every((r) => r === sent[0]) ? `${SHOWN[sent[0]]}, reported, awaiting the TD` : "Reports differ, awaiting the TD";
}

/** One-tap buttons that report a board's result for the player saved here. */
function reportBox(t, number, g, name, redraw) {
  const id = mine().has(g.white) ? g.white : g.black;
  const side = id === g.white ? "white" : "black";
  const where = `${t.key}|${number}|${g.section || ""}|${g.board}`;
  const box = document.createElement("div");
  box.className = "report";
  const called = (who) => t.players.find((p) => p.id === who)?.name || who;
  box.append(paragraph(`Board ${g.board}: ${name(g.white)} with white, ${name(g.black)} with black. Report the result:`));
  const buttons = document.createElement("p");
  buttons.className = "td-buttons";
  const status = Object.assign(paragraph(reported.get(where) || ""), { className: "register-hint" });
  status.setAttribute("role", "status");
  for (const [value, text] of [["1-0", `1–0, ${called(g.white)} won`], ["0-1", `0–1, ${called(g.black)} won`], ["1/2-1/2", "½–½, a draw"]]) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "td-action", textContent: text });
    button.setAttribute("aria-pressed", String(g.reports?.[side] === value));
    button.addEventListener("click", async () => {
      const [event, date] = t.key.split("/");
      for (const b of buttons.children) b.disabled = true;
      status.textContent = "Sending…";
      try {
        const response = await fetch(ENDPOINT, { method: "POST", body: new URLSearchParams({ action: "report", event, date, number,
          board: g.board, section: g.section || "", id, result: value }) });
        const result = await response.json();
        if (result.ok) g.reports = { ...g.reports, [side]: value };
        reported.set(where, result.message || result.error);
      } catch {
        reported.set(where, "The report didn't go through. Try again, or tell the TD.");
      }
      redraw();
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
function findForm(tournaments, render) {
  const form = document.createElement("form");
  form.className = "register-form report-find";
  const status = Object.assign(paragraph(""), { className: "register-hint" });
  status.setAttribute("role", "status");
  const savedBox = Object.assign(document.createElement("fieldset"), { className: "register-saved", hidden: true });
  const list = document.createElement("ul");
  savedBox.append(Object.assign(document.createElement("legend"), { textContent: "Players saved on this device" }), list);
  const input = Object.assign(document.createElement("input"), { id: "report-id", name: "uschess-id", type: "text",
    inputMode: "numeric", pattern: "[0-9]{8}", maxLength: 8, autocomplete: "on", required: true });
  input.setAttribute("aria-describedby", "report-id-hint");
  const hint = Object.assign(paragraph("To report your game's result, find your board."), { id: "report-id-hint", className: "register-hint" });
  const remember = Object.assign(document.createElement("div"), { className: "register-remember", hidden: !canStore() });
  const choice = Object.assign(document.createElement("input"), { id: "report-remember", type: "checkbox", checked: true });
  choice.setAttribute("aria-describedby", "report-remember-hint");
  remember.append(choice, Object.assign(document.createElement("label"), { htmlFor: "report-remember", textContent: "Remember this player on this device" }),
    Object.assign(paragraph("Kept only in this browser, for next time. Uncheck it on a shared computer."), { id: "report-remember-hint", className: "register-hint" }));
  const button = Object.assign(document.createElement("button"), { type: "submit", className: "button", textContent: "Find my board" });
  form.append(savedBox, Object.assign(document.createElement("label"), { htmlFor: "report-id", textContent: "Playing? Your US Chess ID" }),
    input, hint, remember, button, status);

  const boxOf = (id) => pairingsAll.querySelector(`.report[data-players~="${CSS.escape(id)}"]`);
  const showSaved = () => {
    const saved = savedPlayers();
    savedBox.hidden = !saved.length;
    list.replaceChildren(...saved.map((p) => {
      const item = document.createElement("li");
      const pick = Object.assign(document.createElement("button"), { type: "button", className: "register-pick", textContent: playerName(p) });
      pick.addEventListener("click", () => {
        const box = boxOf(p.id);
        status.textContent = box ? `${playerName(p)}: report the result with the buttons below the board.`
          : `${playerName(p)} has no game to report in the round shown.`;
        box?.querySelector("button").focus();
      });
      const forget = Object.assign(document.createElement("button"), { type: "button", className: "register-forget", textContent: "Forget" });
      forget.append(Object.assign(document.createElement("span"), { className: "visually-hidden", textContent: ` ${playerName(p)}` }));
      forget.addEventListener("click", () => {
        if (!storePlayers(savedPlayers().filter((q) => q.id !== p.id))) return;
        found.delete(p.id);
        render();
        status.textContent = `${playerName(p)} is no longer saved on this device.`;
        (list.querySelector(".register-pick") || input).focus();
      });
      item.append(pick, " ", forget);
      return item;
    }));
  };
  form.showSaved = showSaved;
  // As on the Register form, the most recent player saved here is filled in.
  const [latest] = savedPlayers();
  if (latest) input.value = latest.id;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = input.value.trim();
    if (!/^\d{8}$/.test(id)) return void (status.textContent = "A US Chess ID is eight digits.");
    const player = tournaments.filter((t) => t.status === "running" && t.format !== "arena")
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
  const kind = (b) => ({ bye: "full-point bye", half: "half-point bye", zero: "zero-point bye", unplayed: "unplayed" })[Pairing.byeKind(b)];
  const of = t.plannedRounds ? ` of ${t.plannedRounds}` : "";
  parts.forEach((s, si) => {
    if (several) section.append(heading(3, s.name));
    const rounds = s.rounds.map((_, i) => [i + 1, `${i + 1}${of}`]);
    const draw = (n, redraw) => {
      const round = s.rounds[n - 1];
      const shown = [tableOf(["Board", "White", "Black", "Result"],
        round.games.map((g) => [g.board, name(g.white), name(g.black), shownResult(g)]))];
      if (round.byes.length) shown.push(paragraph(`Without a game: ${round.byes.map((b) => `${name(b.id)}, ${kind(b)}`).join("; ")}.`));
      if (t.status === "running") {
        const ids = mine();
        for (const g of round.games) if (!g.result && (ids.has(g.white) || ids.has(g.black))) shown.push(reportBox(t, n, g, name, redraw));
      }
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
      if (onStandings) return standingsAll.replaceChildren(...tournaments.map(standingsSection));
      const reporting = tournaments.some((t) => t.status === "running" && t.format !== "arena" && t.rounds.length);
      const render = () => {
        pairingsAll.replaceChildren(...(reporting ? [form] : []), ...tournaments.map(pairingsSection));
        form.showSaved();
      };
      const form = findForm(tournaments, render);
      render();
    })
    .catch(() => { pairingsStatus.textContent = `The ${onStandings ? "standings" : "pairings"} couldn't be loaded. Try again later.`; });
}