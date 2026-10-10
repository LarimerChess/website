/**
 * Online registration for club events: the Apps Script behind the Register form on each
 * club event's page (register.js) and the TD desk (td/). It lives in the registration
 * Sheet's Extensions → Apps Script; this file is its source. See README.md, Registration.
 *
 * What players register for, by key "<page name>/<date>":
 *   a tournament date (2026-11-07), a club night (2026-10-12), or a club night's whole month (2026-10).
 *
 * GET  ?entries=<key>     the public entry list, as JSON
 * GET  ?withdraw=<token>  a page with a button that withdraws one entry
 * POST event, date, id, last, email (and the trap field website)
 *                         registers a player, then emails the amount due and a withdraw link
 * POST action=..., password=...  the TD desk: login, choices, search, register, entries, remove
 *
 * Deploy as a web app that executes as the club account, with access for anyone. Script
 * properties (Project Settings → Script properties): TD_PASSWORD for the TD desk, and
 * USCHESS_API_KEY, the club's US Chess API key, which tells whether a player is under 18 or
 * 65 or older on the event's date. Fees for each come from the website's prices.json. Players
 * pay when they arrive.
 */

const SITE = "https://larimerchess.org";
const MEMBERS = "https://ratings-api.uschess.org/api/v1/members";
const MEMBERS_KEYED = "https://ratings-api.uschess.org/api/v2/members";
const TZ = "America/Denver";
const HEADER = ["Registered", "Event", "Date", "US Chess ID", "Name", "Category", "Amount", "Regular rating",
  "Quick rating", "Membership expires", "Email", "Status", "Added by", "Token"];
const CATEGORIES = ["Adult", "Senior (65+)", "Under 18"];
const POSTS_PER_MINUTE = 20;
const FAILED_LOGINS = 10;

function doGet(e) {
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
function entries(key, td) {
  const cache = CacheService.getScriptCache();
  const cached = !td && cache.get("entries:" + key);
  if (cached) return JSON.parse(cached);
  const [event, date] = String(key).split("/");
  const { col, rows } = readEntries();
  const list = rows
    .filter((r) => r[col.Event] === event && r[col.Status] !== "withdrawn" && (r[col.Date] === date
      || (date.length === 7 && r[col.Date].startsWith(date + "-"))
      || (date.length === 10 && r[col.Date] === date.slice(0, 7))))
    .map((r) => {
      const entry = { name: r[col.Name], id: r[col["US Chess ID"]], rating: r[col["Regular rating"]],
        for: r[col.Date].length === 7 ? "Whole month" : nightLabel(r[col.Date]) };
      if (td) {
        Object.assign(entry, { category: r[col.Category], amount: r[col.Amount], email: r[col.Email],
          expires: r[col["Membership expires"]], addedBy: r[col["Added by"]], token: r[col.Token] });
      }
      return entry;
    })
    .sort((a, b) => (parseInt(b.rating) || 0) - (parseInt(a.rating) || 0) || a.name.localeCompare(b.name));
  if (!td) cache.put("entries:" + key, JSON.stringify(list), 60);
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
