/**
 * Online registration for club tournaments: the Apps Script behind the Register form
 * on each tournament page (register.js). It lives in the registration Sheet's
 * Extensions → Apps Script; this file is its source. See README.md, Registration.
 *
 * GET  ?entries=<event>/<date>  the public entry list for one date, as JSON. A tournament
 *                               takes entries by date (2026-11-07), a club night by month (2026-10).
 * GET  ?withdraw=<token>        a page with a button that withdraws one entry
 * POST event, date, id, last, email (and the trap field website)
 *                               registers a player, then emails them a withdraw link
 *
 * Deploy as a web app that executes as the club account, with access for anyone.
 * Only club events in https://larimerchess.org/events.json take entries, until the date,
 * or the month's last date, starts. Players pay when they arrive.
 */

const SITE = "https://larimerchess.org";
const MEMBERS = "https://ratings-api.uschess.org/api/v1/members/";
const TZ = "America/Denver";
const SHEET = "Entries";
const HEADER = ["Registered", "Event", "Date", "US Chess ID", "Name", "Regular rating", "Quick rating",
  "Membership expires", "Email", "Status", "Token"];
const COL = Object.fromEntries(HEADER.map((name, i) => [name, i]));
const POSTS_PER_MINUTE = 20;

function doGet(e) {
  if (e.parameter.entries) return json({ entries: entries(e.parameter.entries) });
  if (e.parameter.withdraw) return withdrawPage(e.parameter.withdraw);
  return ContentService.createTextOutput("Larimer County Chess Club registration. See " + SITE + "/events/");
}

function doPost(e) {
  try {
    return json(register(e.parameter));
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong. Try again later, or email president@larimerchess.org." });
  }
}

function register(p) {
  // Bots fill in every field; people never see this one.
  if (p.website) return { ok: true, message: "Thanks." };
  if (!underLimit()) return { error: "Too many registrations right now. Try again in a minute." };

  const event = clubEvents()[`${p.event}/${p.date}`];
  if (!event) return { error: "That event isn't open for registration." };
  if (new Date(event.closes) <= new Date()) return { error: "Online registration for this has closed." };
  const id = String(p.id || "").trim();
  if (!/^\d{8}$/.test(id)) return { error: "A US Chess ID is eight digits." };
  const email = String(p.email || "").trim();
  // A leading = + - or @ would make the Sheet read the cell as a formula.
  if (email.length > 254 || !/^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
    return { error: "Check the email address." };
  }

  const response = UrlFetchApp.fetch(MEMBERS + id, { muteHttpExceptions: true });
  if (response.getResponseCode() === 404) return { error: "US Chess has no member with that ID." };
  if (response.getResponseCode() !== 200) return { error: "US Chess didn't answer. Try again in a few minutes." };
  const member = JSON.parse(response.getContentText());
  if (letters(member.lastName) !== letters(p.last)) {
    return { error: "That last name doesn't match the US Chess ID." };
  }
  const name = `${member.firstName} ${member.lastName}`.trim();
  const rating = (system) => {
    const r = (member.ratings || []).find((x) => x.ratingSystem === system);
    return r && r.rating ? String(r.rating) + (r.isProvisional ? "P" : "") : "";
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let token;
  try {
    const sheet = entriesSheet();
    const rows = sheet.getDataRange().getDisplayValues().slice(1);
    if (rows.some((r) => r[COL.Event] === p.event && r[COL.Date] === p.date && r[COL["US Chess ID"]] === id
        && r[COL.Status] !== "withdrawn")) {
      return { error: `${name} is already registered for this date.` };
    }
    token = Utilities.getUuid();
    const row = {
      Registered: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"), Event: p.event, Date: p.date,
      "US Chess ID": id, Name: name, "Regular rating": rating("R"), "Quick rating": rating("Q"),
      "Membership expires": member.expirationDate || "", Email: email, Status: "registered", Token: token,
    };
    appendText(sheet, HEADER.map((h) => row[h]));
    CacheService.getScriptCache().remove("entries:" + p.event + "/" + p.date);
  } finally {
    lock.releaseLock();
  }

  const lapsed = member.expirationDate && member.expirationDate < event.first
    ? `The US Chess membership expires ${member.expirationDate}, before this event. Renew it before you play.`
    : "";
  MailApp.sendEmail({
    to: email,
    replyTo: "president@larimerchess.org",
    name: "Larimer County Chess Club",
    subject: `Registered: ${event.name}, ${event.label}`,
    body: [
      `${name} (US Chess ID ${id}) is registered for ${event.name}, ${event.label}. Pay when you arrive.`,
      lapsed && lapsed + " https://new.uschess.org/join-us-chess",
      `Details and entries: ${SITE}${event.page}`,
      `Can't come? Withdraw here: ${ScriptApp.getService().getUrl()}?withdraw=${token}`,
      "Questions: president@larimerchess.org",
    ].filter(Boolean).join("\n\n"),
  });
  return { ok: true, message: `${name} is registered. A confirmation is on its way to ${email}.`
    + (lapsed ? " " + lapsed : "") };
}

function entries(key) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("entries:" + key);
  if (cached) return JSON.parse(cached);
  const [event, date] = String(key).split("/");
  const list = entriesSheet().getDataRange().getDisplayValues().slice(1)
    .filter((r) => r[COL.Event] === event && r[COL.Date] === date && r[COL.Status] !== "withdrawn")
    .map((r) => ({ name: r[COL.Name], id: r[COL["US Chess ID"]], rating: r[COL["Regular rating"]] }))
    .sort((a, b) => (parseInt(b.rating) || 0) - (parseInt(a.rating) || 0) || a.name.localeCompare(b.name));
  cache.put("entries:" + key, JSON.stringify(list), 60);
  return list;
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
    if (!row) return "No registration matches this link.";
    entriesSheet().getRange(row.index + 2, COL.Status + 1).setValue("withdrawn");
    CacheService.getScriptCache().remove("entries:" + row.event + "/" + row.date);
    return `${row.name} is withdrawn.`;
  } finally {
    lock.releaseLock();
  }
}

function findToken(token) {
  const rows = entriesSheet().getDataRange().getDisplayValues().slice(1);
  const index = token ? rows.findIndex((r) => r[COL.Token] === token) : -1;
  if (index < 0) return null;
  const r = rows[index];
  return { index, name: r[COL.Name], event: r[COL.Event], date: r[COL.Date], status: r[COL.Status] };
}

/**
 * What players can register for, by "<page name>/<date>" for a tournament or "<page name>/<month>"
 * for a club night, from the website's events.json, cached ten minutes. Each says when it
 * closes (the start of its last date) and its first date, for the membership check.
 */
function clubEvents() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("clubEvents");
  if (cached) return JSON.parse(cached);
  const events = JSON.parse(UrlFetchApp.fetch(SITE + "/events.json").getContentText());
  const out = {};
  for (const e of events.sort((a, b) => a.start.localeCompare(b.start))) {
    if (!e.page) continue;
    const name = e.page.split("/").filter(Boolean).pop();
    const byDate = e.tags.includes("tournament");
    const key = `${name}/${e.start.slice(0, byDate ? 10 : 7)}`;
    const start = new Date(e.start);
    out[key] = {
      name: e.title.replace(/^Larimer County Chess Club\s*/, ""), page: e.page, closes: e.start,
      first: out[key] ? out[key].first : e.start.slice(0, 10),
      label: byDate ? Utilities.formatDate(start, TZ, "EEEE, MMMM d, yyyy")
        : Utilities.formatDate(start, TZ, "EEEE") + "s in " + Utilities.formatDate(start, TZ, "MMMM yyyy"),
    };
  }
  cache.put("clubEvents", JSON.stringify(out), 600);
  return out;
}

function entriesSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET);
  if (!sheet) {
    sheet = book.insertSheet(SHEET);
    // Plain text, so dates and IDs stay as typed.
    appendText(sheet, HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Adds a row as plain text, so the Sheet doesn't turn dates and IDs into numbers. */
function appendText(sheet, values) {
  const last = sheet.getLastRow();
  if (last === sheet.getMaxRows()) sheet.insertRowAfter(last);
  sheet.getRange(last + 1, 1, 1, values.length).setNumberFormat("@").setValues([values]);
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
