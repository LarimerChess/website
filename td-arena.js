// The TD desk's arena: the queue of players waiting for a game, pairing them with arena.js, the
// games in progress with their Blood Pacts and results, and the leaderboard. td-run.js loads the
// tournament and calls renderArena; current, nameOf, keyParts, and option come from it, and
// call and hidden from td.js.

const queueTable = document.querySelector(".run-queue");
const queueEmpty = document.querySelector(".run-queue-empty");
const arenaGames = document.querySelector(".run-arena-games");
const arenaNone = document.querySelector(".run-arena-none");
const awayTable = document.querySelector(".run-away");
const leaderboard = document.querySelector(".run-leaderboard");
const arenaDone = document.querySelector(".run-arena-done");
const arenaPairButton = document.querySelector(".run-arena-pair");
const ARENA_RESULTS = [["1-0", "1–0", ""], ["0-1", "0–1", ""], ["1/2-1/2", "½–½", ""],
  ["1F-0F", "1F–0F", "black forfeits"], ["0F-1F", "0F–1F", "white forfeits"], ["0F-0F", "0F–0F", "both forfeit"]];

const forArena = (t) => ({ players: t.players, games: t.games, queue: t.queue });

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

/** A player's name with a Blood Pact checkbox, which saves as soon as it changes. */
function pactCell(row, g, side) {
  const cell = row.insertCell();
  cell.append(nameOf(g[side]));
  const label = document.createElement("label");
  label.className = "td-pact";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = g[`${side}Pact`];
  box.disabled = current.status === "finished";
  box.addEventListener("change", async () => {
    box.disabled = true;
    const result = await arenaCall("arenaPact", { game: g.game, side, on: box.checked ? "yes" : "no" });
    if (!result.ok) box.checked = !box.checked;
    box.disabled = false;
  });
  label.append(box, " Blood Pact", hidden(`, game ${g.game}, ${side}`));
  cell.append(label);
}

function renderArena() {
  const t = current;
  const [, date] = keyParts();
  const arena = forArena(t);
  const playing = t.games.filter((g) => !g.result);
  const busy = new Set([...t.queue.map((q) => q.id), ...playing.flatMap((g) => [g.white, g.black])]);
  const closed = Arena.pastCutoff(date, t.cutoff, new Date());
  runStatus.textContent = `${t.name}: ${t.players.length} players, ${t.games.length} games paired, ${playing.length} in progress.`
    + (t.status === "finished" ? " Finished."
      : closed ? ` It's past ${t.cutoff}: no new games start. Games in progress finish and count.`
        : t.cutoff ? ` No new games after ${t.cutoff}.` : "");
  runArena.hidden = false;
  const running = t.status !== "finished";
  for (const el of runArena.querySelectorAll(".run-arena-pair, .run-arena-sync, .run-arena-finish")) el.hidden = !running;
  arenaPairButton.disabled = closed;

  const order = Arena.waiting(arena);
  const since = new Map(t.queue.map((q) => [q.id, q.since]));
  queueTable.tBodies[0].replaceChildren(...order.map((id) => {
    const p = t.players.find((x) => x.id === id);
    const row = document.createElement("tr");
    for (const text of [p?.name ?? id, p?.rating ?? "Unrated", (since.get(id) || "").slice(11, 16)]) row.insertCell().textContent = text;
    row.insertCell().append(actionButton("Take out", ` ${p?.name ?? id}`, (e) => arenaCall("arenaLeave", { id }, e.currentTarget)));
    return row;
  }));
  queueTable.hidden = !order.length;
  queueEmpty.hidden = !!order.length;

  arenaGames.tBodies[0].replaceChildren(...playing.map((g) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = g.game;
    pactCell(row, g, "white");
    pactCell(row, g, "black");
    const buttons = document.createElement("div");
    buttons.className = "td-buttons";
    for (const [value, text, note] of ARENA_RESULTS) {
      buttons.append(actionButton(text, `${note ? ` (${note})` : ""}, game ${g.game}`, (e) => {
        if (note && !confirm(`Game ${g.game}: ${text}, ${note}? A player who forfeits doesn't go back in the queue.`)) return;
        arenaCall("arenaResult", { game: g.game, result: value }, e.currentTarget);
      }));
    }
    buttons.append(actionButton("Take back", `, game ${g.game}`, (e) => {
      if (confirm(`Take back game ${g.game}? Both players wait again.`)) arenaCall("arenaCancel", { game: g.game }, e.currentTarget);
    }));
    row.insertCell().append(buttons);
    return row;
  }));
  arenaGames.hidden = !playing.length;
  arenaNone.hidden = !!playing.length;

  const away = t.players.filter((p) => !busy.has(p.id));
  awayTable.tBodies[0].replaceChildren(...away.map((p) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = p.name;
    row.insertCell().textContent = p.rating ?? "Unrated";
    const cell = row.insertCell();
    if (running) cell.append(actionButton("Put in the queue", ` ${p.name}`, (e) => arenaCall("arenaJoin", { id: p.id }, e.currentTarget)));
    return row;
  }));
  awayTable.hidden = !away.length;

  leaderboard.tBodies[0].replaceChildren(...Arena.standings(arena).map((r) => {
    const row = document.createElement("tr");
    for (const text of [`${r.place}${r.tied ? " (tied)" : ""}`, r.name, r.rating ?? "Unrated", r.points, r.games,
      `${r.streak}${r.streak >= 2 ? " (Possessed)" : ""}`]) {
      row.insertCell().textContent = text;
    }
    return row;
  }));

  arenaDone.tBodies[0].replaceChildren(...t.games.filter((g) => g.result).reverse().map((g) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = g.game;
    pactCell(row, g, "white");
    pactCell(row, g, "black");
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
  const { games, waiting } = Arena.pair(forArena(current));
  if (!games.length) {
    runStatus.textContent = waiting.length > 1 ? "Nobody to pair: the players waiting just played each other."
      : waiting.length ? "Only one player is waiting." : "Nobody is waiting.";
    return;
  }
  arenaCall("arenaPair", { games: JSON.stringify(games) }, arenaPairButton);
});

document.querySelector(".run-arena-refresh").addEventListener("click", loadRun);

document.querySelector(".run-arena-sync").addEventListener("click", (e) => arenaCall("sync", {}, e.currentTarget));

document.querySelector(".run-arena-finish").addEventListener("click", (e) => {
  if (!confirm("Finish the arena? No more games can be paired or results entered on the desk.")) return;
  arenaCall("finish", {}, e.currentTarget);
});
