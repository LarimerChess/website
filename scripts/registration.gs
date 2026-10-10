/**
 * Online registration for club events: the Apps Script behind the Register form on each
 * club event's page (register.js) and the TD desk (td/). It lives in the registration
 * Sheet's Extensions → Apps Script; this file is its source. See README.md, Registration.
 *
 * What players register for, by key "<page name>/<date>":
 *   a tournament date (2026-11-07), a club night (2026-10-12), or a club night's whole month (2026-10).
 *
 * GET  ?entries=<key>     the public entry list, as JSON
 * GET  ?entries=all       every upcoming tournament date's and club night's list, for /entries/
 * GET  ?tournaments=current  the tournaments in progress, with posted pairings and results, for /pairings/
 * GET  ?withdraw=<token>  a page with a button that withdraws one entry
 * POST event, date, id, last, email (and the trap field website)
 *                         registers a player, then emails the amount due and a withdraw link
 * POST action=..., password=...  the TD desk: login, choices, search, register, entries, remove, paid,
 *                               incident, incidents, and for running tournaments: tournament, start,
 *                               sync, round, result, out, finish, and for arenas: arenaJoin, arenaLeave,
 *                               arenaPair, arenaResult, arenaPact, arenaCancel
 *
 * The Incidents tab logs TD actions under the Safe Play policy, §8. Expelled or removed from
 * the venue takes a player off that date's entries, so they aren't paired again; barred keeps
 * them from registering for any club event until the date in Until, or until the row is
 * deleted. Those three email the President, who needs a written account within two days.
 *
 * Deploy as a web app that executes as the club account, with access for anyone. Script
 * properties (Project Settings → Script properties): TD_PASSWORD for the TD desk, and
 * TOURNAMENT_SHEET_ID, the "Tournaments in progress" spreadsheet that running tournaments
 * keep their players, pairings, and results in until the archive Action clears it; and
 * USCHESS_API_KEY, the club's US Chess API key, which tells whether a player is under 18 or
 * 65 or older on the event's date. Fees for each come from the website's prices.json. Players
 * pay when they arrive.
 */

const SITE = "https://larimerchess.org";
const MEMBERS = "https://ratings-api.uschess.org/api/v1/members";
const MEMBERS_KEYED = "https://ratings-api.uschess.org/api/v2/members";
const TZ = "America/Denver";
const HEADER = ["Registered", "Event", "Date", "US Chess ID", "Name", "Category", "Amount", "Paid", "Paid on", "Regular rating",
  "Quick rating", "Membership expires", "Email", "Status", "Added by", "Token"];
const CATEGORIES = ["Adult", "Senior (65+)", "Under 18"];
const INCIDENT_HEADER = ["Logged", "Event", "Date", "US Chess ID", "Name", "Action", "Round", "Reason", "TD", "Until"];
const ACTIONS = ["Warning", "Time penalty", "Game loss", "Expelled from the tournament", "Removed from the venue",
  "Barred from club events"];
const OUT_FOR_THE_DATE = ["Expelled from the tournament", "Removed from the venue"];
const ARENA_RESULTS = ["1-0", "0-1", "1/2-1/2", "1F-0F", "0F-1F", "0F-0F"];
// Tabs and headings the script adds to the tournament spreadsheet when they're missing.
const TOURNAMENT_HEADERS = {
  Tournaments: ["Key", "Event", "Name", "Format", "Rounds", "Status", "Started", "Coin", "Finished", "Cutoff"],
  Arena: ["Key", "Game", "White", "Black", "White pact", "Black pact", "Result", "Started", "Ended"],
  Queue: ["Key", "US Chess ID", "Since"],
};
const POSTS_PER_MINUTE = 20;
const FAILED_LOGINS = 10;

function doGet(e) {
  if (e.parameter.tournaments === "current") return json({ tournaments: currentTournaments() });
  if (e.parameter.entries === "all") return json({ events: allEntries() });
  if (e.parameter.entries) return json({ entries: entries(e.parameter.entries, false) });
  if (e.parameter.withdraw) return withdrawPage(e.parameter.withdraw);
  return ContentService.createTextOutput("Larimer County Chess Club registration. See " + SITE + "/events/");
}

function doPost(e) {
  try {
    const p = e.parameter;
    if (!p.action) return json(register(p, false));
    const denied = checkPassword(p.password);
    if (denied) return json({ error: denied, login: true });
    switch (p.action) {
      case "login": return json({ ok: true });
      case "choices": return json({ choices: choices() });
      case "search": return json({ players: search(p.q) });
      case "register": return json(register(p, true));
      case "entries": return json({ entries: entries(`${p.event}/${p.date}`, true) });
      case "remove": return json({ message: withdraw(p.token) });
      case "paid": return json(markPaid(p.token, p.amount));
      case "incident": return json(logIncident(p));
      case "incidents": return json({ incidents: incidentsFor(p.event, p.date) });
      case "tournament": return json({ tournament: tournament(`${p.event}/${p.date}`, true) });
      case "start": return json(startTournament(p));
      case "sync": return json(syncPlayers(`${p.event}/${p.date}`));
      case "round": return json(saveRound(p));
      case "result": return json(saveResult(p));
      case "out": return json(setOut(p));
      case "finish": return json(finishTournament(`${p.event}/${p.date}`));
      case "arenaJoin": return json(arenaJoin(p));
      case "arenaLeave": return json(arenaLeave(p));
      case "arenaPair": return json(arenaPair(p));
      case "arenaResult": return json(arenaResult(p));
      case "arenaPact": return json(arenaPact(p));
      case "arenaCancel": return json(arenaCancel(p));
      default: return json({ error: "Unknown action." });
    }
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong. Try again later, or email president@larimerchess.org." });
  }
}

/** Registers a player. From the TD desk (td), the ID was picked from a search, so no last
 *  name is checked, email is optional, registration stays open through the event, and the
 *  TD may set the category instead of taking it from US Chess. */
function register(p, td) {
  // Bots fill in every field; people never see this one.
  if (!td && p.website) return { ok: true, message: "Thanks." };
  if (!td && !underLimit()) return { error: "Too many registrations right now. Try again in a minute." };

  const key = `${p.event}/${p.date}`;
  const event = clubEvents()[key];
  if (!event) return { error: "That event isn't open for registration." };
  if (!td && new Date(event.closes) <= new Date()) return { error: "Online registration for this has closed." };
  const id = String(p.id || "").trim();
  if (!/^\d{8}$/.test(id)) return { error: "A US Chess ID is eight digits." };
  const email = String(p.email || "").trim();
  // A leading = + - or @ would make the Sheet read the cell as a formula.
  if ((email || !td) && (email.length > 254 || !/^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email))) {
    return { error: "Check the email address." };
  }

  const member = lookup(id);
  if (member === null) return { error: "US Chess has no member with that ID." };
  if (!member) return { error: "US Chess didn't answer. Try again in a few minutes." };
  if (!td && letters(member.lastName) !== letters(p.last)) {
    return { error: "That last name doesn't match the US Chess ID." };
  }
  const name = displayName(member);
  const bar = barred(id, event.first);
  if (bar) {
    return { error: td ? `${name} is barred from club events${bar.until ? " until " + bar.until : ""}. See the Incidents tab.`
      : "Online registration isn't available for this player. Questions: president@larimerchess.org" };
  }
  const category = td && CATEGORIES.includes(p.category) ? p.category : ageCategory(id, event.first);
  const amount = category ? price(event, category) : null;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let token;
  try {
    const { sheet, col, rows } = readEntries();
    const mine = rows.filter((r) => r[col.Event] === p.event && r[col["US Chess ID"]] === id && r[col.Status] !== "withdrawn");
    if (mine.some((r) => r[col.Date] === p.date)) return { error: `${name} is already registered for ${event.label}.` };
    const month = mine.find((r) => r[col.Date] === p.date.slice(0, 7) && event.kind === "night");
    if (month) return { error: `${name} is already registered for the whole month.` };
    token = Utilities.getUuid();
    const row = {
      Registered: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"), Event: p.event, Date: p.date,
      "US Chess ID": id, Name: name, Category: category || "", Amount: amount === null ? "" : String(amount),
      "Regular rating": rating(member, "R"), "Quick rating": rating(member, "Q"),
      "Membership expires": member.expirationDate || "", Email: email, Status: "registered",
      "Added by": td ? "TD" : "online", Token: token,
    };
    appendText(sheet, col, row);
    clearEntriesCache(p.event, p.date);
  } finally {
    lock.releaseLock();
  }

  const due = amount === null ? "The TD will confirm the fee when you arrive."
    : amount === 0 ? `No fee (${category.toLowerCase()}).` : `Due when you arrive: $${amount} (${category.toLowerCase()}).`;
  const lapsed = member.expirationDate && member.expirationDate < event.first
    ? `The US Chess membership expires ${member.expirationDate}, before this event. Renew it before you play.`
    : "";
  if (email) {
    MailApp.sendEmail({
      to: email,
      replyTo: "president@larimerchess.org",
      name: "Larimer County Chess Club",
      subject: `Registered: ${event.name}, ${event.label}`,
      body: [
        `${name} (US Chess ID ${id}) is registered for ${event.name}, ${event.label}.`,
        due,
        lapsed && lapsed + " https://new.uschess.org/join-us-chess",
        `Details and entries: ${SITE}${event.page}`,
        `Can't come? Withdraw here: ${ScriptApp.getService().getUrl()}?withdraw=${token}`,
        "Questions: president@larimerchess.org",
      ].filter(Boolean).join("\n\n"),
    });
  }
  const sent = email ? ` A confirmation is on its way to ${email}.` : "";
  return { ok: true, message: `${name} is registered for ${event.label}. ${due}${sent}${lapsed ? " " + lapsed : ""}` };
}

/** The entry list for a key. A club night's list includes the month's registrations; a month's
 *  includes each night's. The TD desk also gets what only the Sheet should show. */
function entries(key, td, read) {
  const cache = CacheService.getScriptCache();
  const cached = !td && cache.get("entries:" + key);
  if (cached) return JSON.parse(cached);
  const [event, date] = String(key).split("/");
  const { col, rows } = read || readEntries();
  const logged = read ? read.logged : readIncidents().rows;
  const outReason = (id) => {
    const out = logged.find((i) => i.event === event && i.date === date && i["us chess id"] === id
      && OUT_FOR_THE_DATE.includes(i.action));
    if (out) return out.action;
    const bar = barred(id, date.length === 7 ? date + "-01" : date, logged);
    return bar ? "Barred from club events" : "";
  };
  const list = rows
    .filter((r) => r[col.Event] === event && r[col.Status] !== "withdrawn" && (r[col.Date] === date
      || (date.length === 7 && r[col.Date].startsWith(date + "-"))
      || (date.length === 10 && r[col.Date] === date.slice(0, 7))))
    .map((r) => ({ r, out: outReason(r[col["US Chess ID"]]) }))
    .filter(({ out }) => td || !out)
    .map(({ r, out }) => {
      const entry = { name: r[col.Name], id: r[col["US Chess ID"]], rating: r[col["Regular rating"]],
        for: r[col.Date].length === 7 ? "Whole month" : nightLabel(r[col.Date]) };
      if (td) {
        Object.assign(entry, { out, category: r[col.Category], amount: r[col.Amount], paid: r[col.Paid],
          paidOn: r[col["Paid on"]], email: r[col.Email],
          expires: r[col["Membership expires"]], addedBy: r[col["Added by"]], token: r[col.Token] });
      }
      return entry;
    })
    .sort((a, b) => (parseInt(b.rating) || 0) - (parseInt(a.rating) || 0) || a.name.localeCompare(b.name));
  if (!td) cache.put("entries:" + key, JSON.stringify(list), 60);
  return list;
}

/** The public lists for every tournament date and club night still to come, in date order. */
function allEntries() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("entries:all");
  if (cached) return JSON.parse(cached);
  const read = { ...readEntries(), logged: readIncidents().rows };
  const today = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  const list = Object.entries(clubEvents())
    .filter(([, e]) => e.kind !== "month" && e.first >= today)
    .sort(([, a], [, b]) => a.closes.localeCompare(b.closes))
    .map(([key, e]) => ({ key, name: e.name, label: e.label, page: e.page, start: e.closes,
      entries: entries(key, false, read) }));
  cache.put("entries:all", JSON.stringify(list), 60);
  return list;
}

/** What the TD desk can register for: every club event key whose date hasn't passed. */
function choices() {
  const today = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  return Object.entries(clubEvents())
    .filter(([, e]) => e.last >= today)
    .map(([key, e]) => ({ key, name: e.name, label: e.label, kind: e.kind, first: e.first }))
    .sort((a, b) => a.first.localeCompare(b.first) || (a.kind === "month" ? -1 : 1));
}

/** US Chess members by ID or name, Colorado first, for the TD desk's search. */
function search(q) {
  q = String(q || "").trim().replace(/\s+/g, " ");
  if (q.length < 2) return [];
  const cache = CacheService.getScriptCache();
  const cached = cache.get("search:" + q.toLowerCase());
  if (cached) return JSON.parse(cached);
  let found = [];
  if (/^\d{8}$/.test(q)) {
    const member = lookup(q);
    found = member ? [member] : [];
  } else {
    const query = (state) => {
      const url = `${MEMBERS}?Fuzzy=${encodeURIComponent(q)}&Size=12${state ? "&StateRep=" + state : ""}`;
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      return response.getResponseCode() === 200 ? JSON.parse(response.getContentText()).items || [] : [];
    };
    found = query("CO");
    if (found.length < 5) found = found.concat(query("").filter((m) => !found.some((f) => f.id === m.id)));
  }
  const players = found.slice(0, 12).map((m) => ({
    id: m.id, name: displayName(m), state: m.stateRep || "", rating: rating(m, "R"),
    expires: m.expirationDate || "",
  }));
  cache.put("search:" + q.toLowerCase(), JSON.stringify(players), 600);
  return players;
}

function withdrawPage(token) {
  const row = findToken(token);
  const page = HtmlService.createTemplate(`<!DOCTYPE html>
<html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { font: 17px/1.6 system-ui, sans-serif; max-width: 36em; margin: 32px auto; padding: 0 16px; }
button { font: inherit; padding: 10px 20px; }</style></head><body>
<? if (!row) { ?><p>No registration matches this link. Questions: president@larimerchess.org</p>
<? } else if (row.status === "withdrawn") { ?><p><?= row.name ?> is already withdrawn from <?= what ?>.</p>
<? } else { ?><p>Withdraw <?= row.name ?> from <?= what ?>?</p>
<button id="go" data-token="<?= token ?>">Withdraw</button><p id="done" role="status"></p>
<script>
  // A button, not the link itself, so mail scanners that open links can't withdraw anyone.
  document.getElementById("go").onclick = (e) => {
    e.target.disabled = true;
    google.script.run.withSuccessHandler((m) => { document.getElementById("done").textContent = m; })
      .withdraw(e.target.dataset.token);
  };
</script><? } ?></body></html>`);
  const event = row && clubEvents()[`${row.event}/${row.date}`];
  page.row = row;
  page.what = event ? `${event.name}, ${event.label}` : row && `${row.event}, ${row.date}`;
  page.token = token;
  return page.evaluate().setTitle("Withdraw | Larimer County Chess Club");
}

function withdraw(token) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const row = findToken(token);
    if (!row) return "No registration matches this.";
    const { sheet, col } = readEntries();
    sheet.getRange(row.index + 2, col.Status + 1).setValue("withdrawn");
    clearEntriesCache(row.event, row.date);
    return `${row.name} is withdrawn.`;
  } finally {
    lock.releaseLock();
  }
}

/** Logs a TD action from the desk. Taking a player off a date needs that date, not a whole month. */
function logIncident(p) {
  const key = `${p.event}/${p.date}`;
  const event = clubEvents()[key];
  if (!event) return { error: "That event isn't open." };
  if (!ACTIONS.includes(p.action_taken)) return { error: "Choose what happened." };
  if (event.kind === "month" && p.action_taken !== "Barred from club events") {
    return { error: "Choose the night it happened, not the whole month." };
  }
  const reason = String(p.reason || "").trim();
  const tdName = String(p.td || "").trim();
  if (!reason || !tdName) return { error: "Say what happened and who you are." };
  const until = String(p.until || "").trim();
  if (until && !/^\d{4}-\d\d-\d\d$/.test(until)) return { error: "Until is a date, such as 2027-01-31." };
  const id = String(p.id || "").trim();
  const member = /^\d{8}$/.test(id) && lookup(id);
  if (!member) return { error: "Pick the player from the entries." };
  const name = displayName(member);
  const row = { Logged: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"), Event: p.event, Date: p.date,
    "US Chess ID": id, Name: name, Action: p.action_taken, Round: String(p.round || "").trim(), Reason: reason,
    TD: tdName, Until: p.action_taken === "Barred from club events" ? until : "" };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { sheet, col } = readIncidents();
    appendText(sheet, col, row);
    clearEntriesCache(p.event, p.date);
  } finally {
    lock.releaseLock();
  }
  if (OUT_FOR_THE_DATE.includes(row.Action) || row.Action === "Barred from club events") {
    MailApp.sendEmail({
      to: "president@larimerchess.org",
      name: "Larimer County Chess Club",
      subject: `${row.Action}: ${name}, ${event.name}, ${event.label}`,
      body: [
        `${tdName} logged on the TD desk: ${row.Action}.`,
        `Player: ${name}, US Chess ID ${id}`,
        `Event: ${event.name}, ${event.label}${row.Round ? ", round " + row.Round : ""}`,
        row.Until ? `Until: ${row.Until}` : "",
        `What happened: ${reason}`,
        "The Safe Play policy, §8, needs the Senior Authority's written account within two days, and conduct the "
          + "US Chess Safe Play Policy prohibits must also be reported to US Chess (§7). A bar from club events is "
          + "the President's to impose, pending Board review.",
      ].filter(Boolean).join("\n\n"),
    });
  }
  return { ok: true, message: `Logged: ${row.Action}, ${name}.` };
}

/** The TD desk's list of what was logged for a key, newest first; a night's includes bars in force. */
function incidentsFor(event, date) {
  return readIncidents().rows
    .filter((i) => (i.event === event && (i.date === date || i.date.startsWith(date + "-")))
      || (i.action === "Barred from club events" && (!i.until || i.until >= (date.length === 7 ? date + "-01" : date))))
    .map((i) => ({ logged: i.logged, name: i.name, id: i["us chess id"], action: i.action, round: i.round,
      reason: i.reason, td: i.td, until: i.until, date: i.date }))
    .reverse();
}

/** The bar in force on the date for a player, if any. */
function barred(id, date, logged) {
  return (logged || readIncidents().rows).find((i) => i["us chess id"] === id
    && i.action === "Barred from club events" && (!i.until || i.until >= date)) || null;
}

/** The Incidents tab, with each row as an object keyed by its lowercased headings. */
function readIncidents() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName("Incidents");
  if (!sheet) {
    sheet = book.insertSheet("Incidents");
    sheet.getRange(1, 1, 1, INCIDENT_HEADER.length).setNumberFormat("@").setValues([INCIDENT_HEADER]);
    sheet.setFrozenRows(1);
  }
  const [header, ...rows] = sheet.getDataRange().getDisplayValues();
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  return { sheet, col, rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), r[i] || ""]))) };
}

// Running tournaments. A tournament's key is a registration key: a tournament date, or a club
// night's month, whose Mondays are one Swiss with a round a night. Its players are the
// registered entrants when it starts, and later ones added with sync. The TD desk pairs each
// round with pairing.js and posts it here; results are entered board by board. An arena has no
// rounds: the desk pairs its games (Arena tab) with arena.js from the players waiting (Queue
// tab), and they're public as soon as they're paired.

function tournamentBook() {
  const id = PropertiesService.getScriptProperties().getProperty("TOURNAMENT_SHEET_ID");
  if (!id) throw new Error("The script property TOURNAMENT_SHEET_ID isn't set.");
  return SpreadsheetApp.openById(id);
}

/** A tab of the tournament spreadsheet as rows keyed by heading, with each row's sheet row number. */
function table(name) {
  const book = tournamentBook();
  const sheet = book.getSheetByName(name) || (TOURNAMENT_HEADERS[name] && book.insertSheet(name));
  let [header, ...rows] = sheet.getDataRange().getDisplayValues();
  const missing = (TOURNAMENT_HEADERS[name] || []).filter((h) => !header.map((x) => x.trim()).includes(h));
  if (missing.length) {
    header = header.filter((h) => h.trim());
    sheet.getRange(1, header.length + 1, 1, missing.length).setNumberFormat("@").setValues([missing]);
    sheet.setFrozenRows(1);
    header = header.concat(missing);
  }
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  return { sheet, col, rows: rows.map((r, i) => ({ ...Object.fromEntries(header.map((h, j) => [h.trim(), r[j] || ""])), row: i + 2 })) };
}

function setCell(t, row, heading, value) {
  t.sheet.getRange(row, t.col[heading] + 1).setNumberFormat("@").setValue(value);
}

/** Everything about a tournament, in pairing.js's shape. Without td, only posted rounds. */
function tournament(key, td) {
  const info = table("Tournaments").rows.find((r) => r.Key === key);
  if (!info) return null;
  const players = table("Players").rows.filter((r) => r.Key === key)
    .sort((a, b) => Number(a["No."]) - Number(b["No."]))
    .map((r) => ({ id: r["US Chess ID"], number: Number(r["No."]), name: r.Name,
      rating: /^\d+/.test(r.Rating) ? parseInt(r.Rating) : null, out: r["Out from round"] ? Number(r["Out from round"]) : null }));
  const lines = table("Rounds").rows.filter((r) => r.Key === key && (td || r.Posted));
  const count = lines.reduce((m, r) => Math.max(m, Number(r.Round)), 0);
  const rounds = [...Array(count)].map((_, i) => {
    const n = i + 1;
    const here = lines.filter((r) => Number(r.Round) === n);
    return {
      games: here.filter((r) => r.Black).sort((a, b) => Number(a.Board) - Number(b.Board))
        .map((r) => ({ board: Number(r.Board), white: r.White, black: r.Black, result: r.Result })),
      byes: here.filter((r) => !r.Black).map((r) => ({ id: r.White, points: Number(r["Bye points"]) || 0 })),
      out: players.filter((p) => p.out && p.out <= n).map((p) => p.id),
      posted: here.some((r) => r.Posted),
    };
  });
  const result = { key, event: info.Event, name: info.Name, format: info.Format, rounds: rounds,
    plannedRounds: Number(info.Rounds) || null, status: info.Status, coin: info.Coin, players };
  if (info.Format === "arena") {
    result.cutoff = info.Cutoff;
    result.games = table("Arena").rows.filter((r) => r.Key === key)
      .sort((a, b) => Number(a.Game) - Number(b.Game))
      .map((r) => ({ game: Number(r.Game), white: r.White, black: r.Black, whitePact: r["White pact"] === "yes",
        blackPact: r["Black pact"] === "yes", result: r.Result, started: r.Started, ended: r.Ended }));
    result.queue = table("Queue").rows.filter((r) => r.Key === key).map((r) => ({ id: r["US Chess ID"], since: r.Since }));
  }
  return result;
}

function startTournament(p) {
  const key = `${p.event}/${p.date}`;
  const event = clubEvents()[key];
  if (!event) return { error: "That event isn't open." };
  if (event.kind === "night") return { error: "A club night's Swiss runs for the month; choose the month." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = table("Tournaments");
    if (t.rows.some((r) => r.Key === key)) return { error: "That tournament has already started." };
    const format = p.format === "arena" ? "arena" : "swiss";
    const rounds = format === "arena" ? "" : String(p.rounds || "").trim();
    const cutoff = format === "arena" ? String(p.cutoff || "").trim() : "";
    if (format === "arena" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) return { error: "No new games after what time? Such as 17:30." };
    appendText(t.sheet, t.col, { Key: key, Event: event.event, Name: `${event.name}, ${event.label}`, Format: format,
      Rounds: rounds, Status: "running", Started: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"),
      Coin: p.coin === "black" ? "black" : "white", Finished: "", Cutoff: cutoff });
  } finally {
    lock.releaseLock();
  }
  return syncPlayers(key);
}

/** Adds registered entrants who aren't players yet, numbered after the others (28B). */
function syncPlayers(key) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = table("Players");
    const have = new Set(t.rows.filter((r) => r.Key === key).map((r) => r["US Chess ID"]));
    let number = t.rows.filter((r) => r.Key === key).reduce((m, r) => Math.max(m, Number(r["No."]) || 0), 0);
    // A month's entrants include each night's; entries() already leaves out the expelled and barred.
    const entrants = entries(key, true).filter((e) => !e.out && !have.has(e.id));
    entrants.sort((a, b) => (parseInt(b.rating) || 0) - (parseInt(a.rating) || 0));
    for (const e of entrants) {
      appendText(t.sheet, t.col, { Key: key, "No.": String(++number), "US Chess ID": e.id, Name: e.name,
        Rating: e.rating || "", "Out from round": "" });
    }
    clearTournamentCache();
    return { ok: true, added: entrants.length, message: entrants.length ? `Added ${entrants.length} player(s).` : "No new entrants." };
  } finally {
    lock.releaseLock();
  }
}

/** Saves a round's pairings and byes; posted makes them public. Replaces the round if it was saved before. */
function saveRound(p) {
  const key = `${p.event}/${p.date}`;
  const round = Number(p.number);
  const games = JSON.parse(p.games || "[]");
  const byes = JSON.parse(p.byes || "[]");
  if (!round) return { error: "Which round?" };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = table("Rounds");
    const old = t.rows.filter((r) => r.Key === key && Number(r.Round) === round);
    if (old.some((r) => r.Result)) return { error: "This round has results; clear them before re-pairing (29G)." };
    for (const r of old.reverse()) t.sheet.deleteRow(r.row);
    const posted = p.post === "yes" ? Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm") : "";
    const fresh = table("Rounds");
    for (const g of games) {
      appendText(fresh.sheet, fresh.col, { Key: key, Round: String(round), Board: String(g.board), White: g.white,
        Black: g.black, Result: "", "Bye points": "", Posted: posted });
    }
    for (const b of byes) {
      appendText(fresh.sheet, fresh.col, { Key: key, Round: String(round), Board: "", White: b.id, Black: "",
        Result: "", "Bye points": String(b.points), Posted: posted });
    }
    clearTournamentCache();
    return { ok: true, message: posted ? `Round ${round} is posted.` : `Round ${round} is saved, not posted.` };
  } finally {
    lock.releaseLock();
  }
}

function saveResult(p) {
  const key = `${p.event}/${p.date}`;
  const allowed = ["", "1-0", "0-1", "1/2-1/2", "1F-0F", "0F-1F", "0F-0F"];
  if (!allowed.includes(p.result)) return { error: "Not a result." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = table("Rounds");
    const line = t.rows.find((r) => r.Key === key && Number(r.Round) === Number(p.number) && Number(r.Board) === Number(p.board));
    if (!line) return { error: "No such board." };
    setCell(t, line.row, "Result", p.result);
    clearTournamentCache();
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Withdraws or expels a player from a round on (28P), or brings them back with an empty round. */
function setOut(p) {
  const key = `${p.event}/${p.date}`;
  const t = table("Players");
  const line = t.rows.find((r) => r.Key === key && r["US Chess ID"] === p.id);
  if (!line) return { error: "Not a player in this tournament." };
  setCell(t, line.row, "Out from round", String(p.from || ""));
  clearTournamentCache();
  return { ok: true, message: p.from ? `${line.Name} is out from round ${p.from}.` : `${line.Name} is back in.` };
}

function finishTournament(key) {
  const t = table("Tournaments");
  const line = t.rows.find((r) => r.Key === key);
  if (!line) return { error: "No such tournament." };
  setCell(t, line.row, "Status", "finished");
  setCell(t, line.row, "Finished", Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"));
  clearTournamentCache();
  return { ok: true, message: "Finished. The archive Action saves it and clears it from the spreadsheet." };
}

// Arenas. Every write rereads the tabs under the lock, so two desks can't put a player in two games.

const stamp = (pattern) => Utilities.formatDate(new Date(), TZ, pattern || "yyyy-MM-dd HH:mm:ss");

function runningArena(key) {
  const info = table("Tournaments").rows.find((r) => r.Key === key);
  if (!info || info.Format !== "arena") return { error: "No arena is running for this." };
  if (info.Status !== "running") return { error: "This arena is finished." };
  return { info };
}

function arenaJoin(p) {
  const key = `${p.event}/${p.date}`;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { error } = runningArena(key);
    if (error) return { error };
    const player = table("Players").rows.find((r) => r.Key === key && r["US Chess ID"] === p.id);
    if (!player) return { error: "Not a player in this arena. Add new entrants first." };
    const queue = table("Queue");
    if (queue.rows.some((r) => r.Key === key && r["US Chess ID"] === p.id)) return { error: `${player.Name} is already waiting.` };
    const playing = table("Arena").rows.some((r) => r.Key === key && !r.Result && (r.White === p.id || r.Black === p.id));
    if (playing) return { error: `${player.Name} is in a game.` };
    appendText(queue.sheet, queue.col, { Key: key, "US Chess ID": p.id, Since: stamp() });
    clearTournamentCache();
    return { ok: true, message: `${player.Name} is waiting for a game.` };
  } finally {
    lock.releaseLock();
  }
}

function arenaLeave(p) {
  const key = `${p.event}/${p.date}`;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const queue = table("Queue");
    for (const r of queue.rows.filter((x) => x.Key === key && x["US Chess ID"] === p.id).reverse()) queue.sheet.deleteRow(r.row);
    clearTournamentCache();
    const player = table("Players").rows.find((r) => r.Key === key && r["US Chess ID"] === p.id);
    return { ok: true, message: `${player ? player.Name : p.id} is out of the queue.` };
  } finally {
    lock.releaseLock();
  }
}

/** Starts the games the desk paired, [{ white, black }], skipping any whose players are no longer
 *  waiting because another desk paired them first. */
function arenaPair(p) {
  const key = `${p.event}/${p.date}`;
  const games = JSON.parse(p.games || "[]");
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { info, error } = runningArena(key);
    if (error) return { error };
    const local = stamp("yyyy-MM-dd HH:mm");
    if (info.Cutoff && (p.date.length === 7 ? local.slice(11) >= info.Cutoff : local >= `${p.date} ${info.Cutoff}`)) {
      return { error: `No new games start after ${info.Cutoff}.` };
    }
    const queue = table("Queue");
    const waiting = new Set(queue.rows.filter((r) => r.Key === key).map((r) => r["US Chess ID"]));
    const arena = table("Arena");
    let number = arena.rows.filter((r) => r.Key === key).reduce((m, r) => Math.max(m, Number(r.Game) || 0), 0);
    const started = [];
    for (const g of games) {
      if (g.white === g.black || !waiting.has(g.white) || !waiting.has(g.black)) continue;
      waiting.delete(g.white);
      waiting.delete(g.black);
      appendText(arena.sheet, arena.col, { Key: key, Game: String(++number), White: g.white, Black: g.black,
        "White pact": "", "Black pact": "", Result: "", Started: stamp(), Ended: "" });
      started.push(g.white, g.black);
    }
    const leaving = queue.rows.filter((r) => r.Key === key && started.includes(r["US Chess ID"]));
    for (const r of leaving.reverse()) queue.sheet.deleteRow(r.row);
    clearTournamentCache();
    const count = started.length / 2;
    return { ok: true, message: count === games.length ? `Started ${count} game(s).`
      : `Started ${count} of ${games.length} game(s); the others' players were no longer waiting.` };
  } finally {
    lock.releaseLock();
  }
}

/** Records a game's result. The first result puts both players back in the queue, except one who
 *  forfeited; a later one only corrects it. */
function arenaResult(p) {
  const key = `${p.event}/${p.date}`;
  if (!ARENA_RESULTS.includes(p.result)) return { error: "Not a result." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const arena = table("Arena");
    const line = arena.rows.find((r) => r.Key === key && Number(r.Game) === Number(p.game));
    if (!line) return { error: "No such game." };
    setCell(arena, line.row, "Result", p.result);
    clearTournamentCache();
    if (line.Result) return { ok: true, message: `Game ${p.game} is corrected.` };
    setCell(arena, line.row, "Ended", stamp());
    const back = [];
    if (!/^0F/.test(p.result)) back.push(line.White);
    if (!/0F$/.test(p.result)) back.push(line.Black);
    const queue = table("Queue");
    for (const id of back) appendText(queue.sheet, queue.col, { Key: key, "US Chess ID": id, Since: stamp() });
    return { ok: true, message: `Game ${p.game} is recorded.` };
  } finally {
    lock.releaseLock();
  }
}

/** Sets or clears one side's Blood Pact for a game. */
function arenaPact(p) {
  const key = `${p.event}/${p.date}`;
  const heading = { white: "White pact", black: "Black pact" }[p.side];
  if (!heading) return { error: "Which side?" };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const arena = table("Arena");
    const line = arena.rows.find((r) => r.Key === key && Number(r.Game) === Number(p.game));
    if (!line) return { error: "No such game." };
    setCell(arena, line.row, heading, p.on === "yes" ? "yes" : "");
    clearTournamentCache();
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Takes back a pairing made by mistake, before it has a result; both players wait again. */
function arenaCancel(p) {
  const key = `${p.event}/${p.date}`;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const arena = table("Arena");
    const line = arena.rows.find((r) => r.Key === key && Number(r.Game) === Number(p.game));
    if (!line) return { error: "No such game." };
    if (line.Result) return { error: "That game has a result." };
    arena.sheet.deleteRow(line.row);
    const queue = table("Queue");
    for (const id of [line.White, line.Black]) appendText(queue.sheet, queue.col, { Key: key, "US Chess ID": id, Since: stamp() });
    clearTournamentCache();
    return { ok: true, message: `Game ${p.game} is taken back.` };
  } finally {
    lock.releaseLock();
  }
}

/** Every tournament in the spreadsheet, with only posted rounds, for the public Pairings page. */
function currentTournaments() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("tournaments");
  if (cached) return JSON.parse(cached);
  const list = table("Tournaments").rows.map((r) => tournament(r.Key, false)).filter(Boolean);
  cache.put("tournaments", JSON.stringify(list), 30);
  return list;
}

function clearTournamentCache() {
  CacheService.getScriptCache().remove("tournaments");
}

/** Records what a player paid at the door, or clears it when amount is empty. */
function markPaid(token, amount) {
  amount = String(amount || "").trim().replace(/^\$/, "");
  if (amount && !/^\d+(\.\d\d)?$/.test(amount)) return { error: "Enter the amount paid, such as 15." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const row = findToken(token);
    if (!row) return { error: "No registration matches this." };
    const { sheet, col } = readEntries();
    const when = amount ? Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm") : "";
    sheet.getRange(row.index + 2, col.Paid + 1).setNumberFormat("@").setValue(amount);
    sheet.getRange(row.index + 2, col["Paid on"] + 1).setNumberFormat("@").setValue(when);
    return { ok: true, message: amount ? `${row.name} paid $${amount}.` : `${row.name} is marked unpaid.` };
  } finally {
    lock.releaseLock();
  }
}

function findToken(token) {
  const { col, rows } = readEntries();
  const index = token ? rows.findIndex((r) => r[col.Token] === token) : -1;
  if (index < 0) return null;
  const r = rows[index];
  return { index, name: r[col.Name], event: r[col.Event], date: r[col.Date], status: r[col.Status] };
}

/**
 * Everything players can register for, by key, from the website's events.json, cached ten
 * minutes. A tournament date is kind "entry"; a club night is "night", and its month "month".
 * closes: when the last date starts. first and last: the dates it covers, for the membership
 * check and the TD desk.
 */
function clubEvents() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("clubEvents");
  if (cached) return JSON.parse(cached);
  const events = JSON.parse(UrlFetchApp.fetch(SITE + "/events.json").getContentText());
  const out = {};
  const add = (key, e, kind, label) => {
    out[key] = {
      event: key.split("/")[0], name: e.title.replace(/^Larimer County Chess Club\s*/, ""), page: e.page, kind,
      label, closes: e.start, first: out[key] ? out[key].first : e.start.slice(0, 10), last: e.start.slice(0, 10),
    };
  };
  for (const e of events.sort((a, b) => a.start.localeCompare(b.start))) {
    if (!e.page) continue;
    const name = e.page.split("/").filter(Boolean).pop();
    const start = new Date(e.start);
    const day = Utilities.formatDate(start, TZ, "EEEE, MMMM d, yyyy");
    if (e.tags.includes("tournament")) {
      add(`${name}/${e.start.slice(0, 10)}`, e, "entry", day);
    } else {
      add(`${name}/${e.start.slice(0, 10)}`, e, "night", day);
      add(`${name}/${e.start.slice(0, 7)}`, e, "month",
        `all ${Utilities.formatDate(start, TZ, "EEEE")}s in ${Utilities.formatDate(start, TZ, "MMMM yyyy")}`);
    }
  }
  cache.put("clubEvents", JSON.stringify(out), 600);
  return out;
}

/** The fee from the website's prices.json, cached ten minutes: the row for the event and kind
 *  whose "applies" is the most specific match (the date, its month, or all). null when none applies. */
function price(event, category) {
  const cache = CacheService.getScriptCache();
  let prices = cache.get("prices");
  if (!prices) {
    prices = UrlFetchApp.fetch(SITE + "/prices.json").getContentText();
    cache.put("prices", prices, 600);
  }
  const date = event.kind === "month" ? event.first.slice(0, 7) : event.first;
  const rank = (applies) => applies === date ? 3 : applies === date.slice(0, 7) ? 2 : applies === "all" ? 1 : 0;
  const best = (JSON.parse(prices)[event.event] || [])
    .filter((r) => r.kind === event.kind && rank(r.applies))
    .sort((a, b) => rank(b.applies) - rank(a.applies))[0];
  const field = { "Adult": "adult", "Senior (65+)": "senior", "Under 18": "youth" }[category];
  return best && typeof best[field] === "number" ? best[field] : null;
}

/** The Entries tab, its columns by heading (so TDs can reorder them), and its rows. */
function readEntries() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName("Entries");
  if (!sheet) {
    sheet = book.insertSheet("Entries");
    sheet.setFrozenRows(1);
  }
  let [header, ...rows] = sheet.getDataRange().getDisplayValues();
  header = header.map((h) => h.trim());
  const missing = HEADER.filter((h) => !header.includes(h));
  if (missing.length) {
    const start = header.filter(Boolean).length;
    sheet.getRange(1, start + 1, 1, missing.length).setNumberFormat("@").setValues([missing]);
    header = header.filter(Boolean).concat(missing);
  }
  rows = rows.map((r) => header.map((_, i) => r[i] || ""));
  return { sheet, col: Object.fromEntries(header.map((h, i) => [h, i])), rows };
}

/** Adds a row as plain text, so the Sheet doesn't turn dates and IDs into numbers. */
function appendText(sheet, col, row) {
  const values = new Array(Object.keys(col).length).fill("");
  for (const [h, i] of Object.entries(col)) values[i] = row[h] === undefined ? "" : row[h];
  const last = sheet.getLastRow();
  if (last === sheet.getMaxRows()) sheet.insertRowAfter(last);
  sheet.getRange(last + 1, 1, 1, values.length).setNumberFormat("@").setValues([values]);
}

function clearEntriesCache(event, date) {
  const cache = CacheService.getScriptCache();
  cache.remove("entries:all");
  const keys = [date, date.slice(0, 7)];
  if (date.length === 7) {
    for (const key of Object.keys(clubEvents())) if (key.startsWith(`${event}/${date}-`)) keys.push(key.split("/")[1]);
  }
  cache.removeAll(keys.map((d) => `entries:${event}/${d}`));
}

/** A member from US Chess; null if there is none, undefined if US Chess didn't answer. */
function lookup(id) {
  const response = UrlFetchApp.fetch(`${MEMBERS}/${id}`, { muteHttpExceptions: true });
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() !== 200) return undefined;
  return JSON.parse(response.getContentText());
}

/**
 * Adult, Senior (65+), or Under 18 on the date, from US Chess's age filters, which need the
 * API key; US Chess doesn't give out birth dates. A member with no birth date on file counts
 * as an adult. "" when it can't be told.
 *
 * The Players tab keeps each answer with the day it was checked, and US Chess is asked again
 * only after a year, or three months for a player under 18, so a birthday in between can leave
 * a player in the old category until then.
 */
function ageCategory(id, date) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const players = book.getSheetByName("Players") || book.insertSheet("Players");
  if (!players.getLastRow()) {
    players.getRange(1, 1, 1, 4).setNumberFormat("@").setValues([["US Chess ID", "Category", "Checked on", "For the date"]]);
    players.setFrozenRows(1);
  }
  const rows = players.getDataRange().getDisplayValues();
  const index = rows.findIndex((r, i) => i > 0 && r[0] === id);
  const daysAgo = (days) => Utilities.formatDate(new Date(Date.now() - days * 86400000), TZ, "yyyy-MM-dd");
  if (index > 0 && rows[index][1] && rows[index][2] > daysAgo(rows[index][1] === "Under 18" ? 91 : 365)) {
    return rows[index][1];
  }

  const key = PropertiesService.getScriptProperties().getProperty("USCHESS_API_KEY");
  if (!key) return "";
  const matches = (filter) => {
    const response = UrlFetchApp.fetch(`${MEMBERS_KEYED}?Fuzzy=${id}&${filter}&AgeDate=${date}`,
      { headers: { "X-Api-Key": key }, muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) throw new Error("US Chess age check: " + response.getResponseCode());
    return (JSON.parse(response.getContentText()).items || []).some((m) => m.id === id);
  };
  let category;
  try {
    category = matches("MaxAge=17") ? "Under 18" : matches("MinAge=65") ? "Senior (65+)" : "Adult";
  } catch (err) {
    console.error(err);
    return "";
  }
  const row = [id, category, Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"), date];
  const at = index > 0 ? index + 1 : players.getLastRow() + 1;
  if (at > players.getMaxRows()) players.insertRowAfter(players.getMaxRows());
  players.getRange(at, 1, 1, 4).setNumberFormat("@").setValues([row]);
  return category;
}

/** US Chess keeps some names in capitals; those are shown with only their first letters capitalized. */
function displayName(member) {
  const name = `${member.firstName || ""} ${member.lastName || ""}`.trim();
  return name === name.toUpperCase() ? name.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase()) : name;
}

function rating(member, system) {
  const r = (member.ratings || []).find((x) => x.ratingSystem === system);
  return r && r.rating ? String(r.rating) + (r.isProvisional ? "P" : "") : "";
}

function nightLabel(date) {
  return Utilities.formatDate(new Date(date + "T12:00:00Z"), TZ, "EEEE, MMMM d");
}

/** Null when the TD password is right; otherwise why not. Repeated failures lock the desk for 15 minutes. */
function checkPassword(password) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("failedLogins") || 0);
  if (fails >= FAILED_LOGINS) return "Too many wrong passwords. Try again in 15 minutes.";
  const expected = PropertiesService.getScriptProperties().getProperty("TD_PASSWORD");
  const digest = (s) => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s || ""));
  if (expected && String(digest(password)) === String(digest(expected))) return null;
  cache.put("failedLogins", String(fails + 1), 900);
  return expected ? "Wrong password." : "The TD password isn't set up yet.";
}

function underLimit() {
  const cache = CacheService.getScriptCache();
  const key = "posts:" + Math.floor(Date.now() / 60000);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const count = Number(cache.get(key) || 0) + 1;
    cache.put(key, String(count), 120);
    return count <= POSTS_PER_MINUTE;
  } finally {
    lock.releaseLock();
  }
}

function letters(s) {
  return String(s || "").normalize("NFD").replace(/[^A-Za-z]/g, "").toLowerCase();
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
