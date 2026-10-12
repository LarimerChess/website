/**
 * Online registration for club events: the Apps Script behind the Register form on each
 * club event's page (register.js) and the TD desk (td/). It lives in the registration
 * Sheet's Extensions → Apps Script; this file is its source. See README.md, The registration script.
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
 * POST action=report, event, date, number, board, section, id, result
 *                         a player's report of their game's result, which the TD confirms on the desk
 * POST action=..., password=...  the TD desk: login, refresh, choices, history, people, search, contacts, contactSave, contactDelete,
 *                               register, entries, remove, paid, ledger,
 *                               incident, incidents, and for running tournaments: tournament, start,
 *                               sync, sections, section, round, result, results, byeKind, out, rounds, restart, and for arenas:
 *                               arenaJoin, arenaLeave, arenaPair, arenaResult, arenaPact, arenaCancel
 *
 * The Incidents tab logs TD actions under the Safe Play policy, §8. Expelled or removed from
 * the venue takes a player off that date's entries, so they aren't paired again; barred keeps
 * them from registering for any club event until the date in Until, or until the row is
 * deleted. Those three email the President, who needs a written account within two days.
 *
 * Deploy as a web app that executes as the club account, with access for anyone. Script
 * properties (Project Settings → Script properties): TD_PASSWORD for the TD desk, and
 * TOURNAMENT_SHEET_ID, the "Tournaments in progress" spreadsheet that running tournaments
 * keep their players, pairings, and results in until US Chess has rated them and the archive
 * Action clears them; and
 * USCHESS_API_KEY, the club's US Chess API key, which tells whether a player is under 18 or
 * 65 or older on the event's date. Fees for each come from the website's prices.json: the entry
 * fee, plus its round fee for each rated round (an arena, a flat rating fee), plus the card fee
 * when paid by card. Players pay when they arrive.
 *
 * A player who registers for a club night's whole month after registering for some of its nights
 * moves to the month: those nights' rows get the status "moved to month", and what was paid for
 * them, less any card fee, is credited to the month, up to its fee.
 *
 * The Payments tab is the ledger, and rows are only ever added to it: each payment, each
 * correction (marking a player unpaid adds one that cancels their payments, named in Reverses),
 * and each credit (a pair: out of a night, into its month). Each row splits what changed hands
 * into the entry fee (Peak's facility donation), the rating fee (US Chess and the club's
 * margin), and the card fee (the processor's), from the fees as they stood when the row was
 * added, so a later price change never rewrites it. A payment covers the rating fee first.
 *
 * Invitational club events (calendar metadata access=invitational) and events in the registration
 * Sheet's "Closed events" tab (Event, Name, Start, Format, Rounds, Fee) take registrations only from the TD
 * desk; their entries and pairings are public like any other event's. The tab can also hold an
 * event that isn't on the calendar, and gives a calendar event its format and fee.
 */

const SITE = "https://larimerchess.org";
const MEMBERS = "https://ratings-api.uschess.org/api/v1/members";
const MEMBERS_KEYED = "https://ratings-api.uschess.org/api/v2/members";
const TZ = "America/Denver";
const HEADER = ["Registered", "Event", "Date", "US Chess ID", "Name", "Category", "Amount", "Paid", "Paid on", "Regular rating",
  "Quick rating", "Membership expires", "Email", "Status", "Added by", "Token", "Phone", "Paid by", "Rating fee"];
const MOVED = "moved to month";
const PAYMENT_HEADER = ["No.", "Recorded", "Token", "Event", "Date", "US Chess ID", "Name", "Type", "Method", "Received",
  "Entry fee", "Rating fee", "Card fee", "Reverses", "Note"];
const METHODS = ["cash", "check", "card", "other"];
const CATEGORIES = ["Adult", "Senior (65+)", "Under 18"];
const INCIDENT_HEADER = ["Logged", "Event", "Date", "US Chess ID", "Name", "Action", "Round", "Reason", "TD", "Until"];
const ACTIONS = ["Warning", "Time penalty", "Game loss", "Expelled from the tournament", "Removed from the venue",
  "Barred from club events"];
const OUT_FOR_THE_DATE = ["Expelled from the tournament", "Removed from the venue"];
const ARENA_RESULTS = ["1-0", "0-1", "1/2-1/2", "1F-0F", "0F-1F", "0F-0F"];
// Tabs and headings the script adds to the tournament spreadsheet when they're missing.
const TOURNAMENT_HEADERS = {
  Tournaments: ["Key", "Event", "Name", "Format", "Rounds", "Status", "Started", "Coin", "Finished", "Cutoff", "Sections", "TD"],
  Players: ["Key", "No.", "US Chess ID", "Name", "Rating", "Out from round", "Section", "Floor", "Prior games", "Prior sweep", "State"],
  Rounds: ["Key", "Round", "Board", "White", "Black", "Result", "Bye points", "Posted", "Section", "Bye kind", "White report",
    "Black report"],
  Arena: ["Key", "Game", "White", "Black", "White pact", "Black pact", "Result", "Started", "Ended"],
};
// TD desk actions that change a tournament, refused once US Chess has rated it.
const TOURNAMENT_WRITES = ["sync", "sections", "section", "round", "result", "results", "byeKind", "out", "rounds", "restart", "arenaJoin",
  "arenaLeave", "arenaPair", "arenaResult", "arenaPact", "arenaCancel"];
const POSTS_PER_MINUTE = 20;
// Wrong TD passwords allowed in an hour, counted from the first, from all devices that haven't
// signed in before.
const FAILED_LOGINS = 5;

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
    if (p.action === "report") return json(reportResult(p));
    const denied = checkPassword(p.password, p.device);
    if (denied) return json({ error: denied, login: true });
    if (TOURNAMENT_WRITES.includes(p.action) && rated(`${p.event}/${p.date}`)) {
      return json({ error: "US Chess has rated this tournament, so it can't change on the desk." });
    }
    switch (p.action) {
      case "login": return json({ ok: true, changes: changes() });
      case "changes": return json({ changes: changes() });
      case "refresh": return json(refreshCaches());
      case "choices": return json({ choices: choices() });
      case "history": return json({ players: history(p.q) });
      case "people": return json({ players: people() });
      case "contacts": return json(contacts());
      case "contactSave": return json(saveContact(p));
      case "contactDelete": return json(deleteContact(p.id));
      case "search": return json({ players: search(p.q) });
      case "register": return json(register(p, true));
      case "entries": return json({ entries: entries(`${p.event}/${p.date}`, true) });
      case "remove": return json({ message: withdraw(p.token) });
      case "paid": return json(markPaid(p.token, p.amount, p.by));
      case "ledger": return json({ ledger: ledgerFor(`${p.event}/${p.date}`) });
      case "incident": return json(logIncident(p));
      case "incidents": return json({ incidents: incidentsFor(p.event, p.date) });
      case "tournament": return json({ tournament: tournament(`${p.event}/${p.date}`, true) });
      case "start": return json(startTournament(p));
      case "sync": return json(syncPlayers(`${p.event}/${p.date}`));
      case "sections": return json(setSections(p));
      case "section": return json(setSection(p));
      case "round": return json(saveRound(p));
      case "result": return json(saveResult(p));
      case "results": return json(saveResults(p));
      case "byeKind": return json(saveByeKind(p));
      case "out": return json(setOut(p));
      case "rounds": return json(setRounds(p));
      case "restart": return json(restartTournament(`${p.event}/${p.date}`));
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
  if (!event || (event.closed && !td)) return { error: "That event isn't open for registration." };
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
  let credited = 0;
  try {
    const { sheet, col, rows } = readEntries();
    const mine = rows.filter((r) => r[col.Event] === p.event && r[col["US Chess ID"]] === id && active(r[col.Status]));
    if (mine.some((r) => r[col.Date] === p.date)) return { error: `${name} is already registered for ${event.label}.` };
    const month = mine.find((r) => r[col.Date] === p.date.slice(0, 7) && event.kind === "night");
    if (month) return { error: `${name} is already registered for the whole month.` };
    token = Utilities.getUuid();
    const ratingDue = ratingFee(event, prices().fees);
    const row = {
      Registered: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"), Event: p.event, Date: p.date,
      "US Chess ID": id, Name: name, Category: category || "", Amount: amount === null ? "" : money(amount),
      "Regular rating": rating(member, "R"), "Quick rating": rating(member, "Q"),
      "Membership expires": member.expirationDate || "", Email: email, Status: "registered",
      "Added by": td ? "TD" : "online", Token: token, Phone: td ? String(p.phone || "").trim() : "",
      "Rating fee": ratingDue === null ? "" : money(ratingDue),
    };
    appendText(sheet, col, row);
    if (event.kind === "month") {
      const nights = mine.filter((r) => r[col.Date].startsWith(p.date + "-"));
      credited = moveToMonth(sheet, col, rows, nights, row, amount);
    }
    clearEntriesCache();
  } finally {
    lock.releaseLock();
  }

  const card = prices().fees.card;
  const owed = amount === null ? null : Math.round((amount - credited) * 100) / 100;
  const credit = credited ? ` after $${money(credited)} already paid for its nights` : "";
  const due = owed === null ? "The TD will confirm the fee when you arrive."
    : amount === 0 ? `No fee (${category.toLowerCase()}).`
    : owed === 0 ? `Nothing more is due: what was paid for its nights covers it.`
    : `Due when you arrive: $${money(owed)} (${category.toLowerCase()}${credit})`
      + `. Paying by card adds ${card.percent}% + $${money(card.fixed)}.`;
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
        event.page ? `Details and entries: ${SITE}${event.page}` : "",
        `Can't come? Withdraw here: ${ScriptApp.getService().getUrl()}?withdraw=${token}`,
        "Questions: president@larimerchess.org",
      ].filter(Boolean).join("\n\n"),
    });
  }
  const sent = email ? ` A confirmation is on its way to ${email}.` : "";
  return { ok: true, name, message: `${name} is registered for ${event.label}. ${due}${sent}${lapsed ? " " + lapsed : ""}` };
}

/** The entry list for a key. A club night's list includes the month's registrations; a month's
 *  includes each night's. The TD desk also gets what only the Sheet should show. */
function entries(key, td, read) {
  const cache = CacheService.getScriptCache();
  const cached = !td && cache.get(entriesKey(key));
  if (cached) return JSON.parse(cached);
  const [event, date] = String(key).split("/");
  const { col, rows } = read || readEntries();
  const logged = read ? read.logged : readIncidents().rows;
  const placed = read ? read.placed : sectionsByKey();
  const sectionOf = placed[key] || (date.length === 10 && placed[`${event}/${date.slice(0, 7)}`]) || {};
  const outReason = (id) => {
    const out = logged.find((i) => i.event === event && i.date === date && i["us chess id"] === id
      && OUT_FOR_THE_DATE.includes(i.action));
    if (out) return out.action;
    const bar = barred(id, date.length === 7 ? date + "-01" : date, logged);
    return bar ? "Barred from club events" : "";
  };
  const card = td && prices().fees.card;
  const ledger = td && ledgerByToken();
  const list = rows
    .filter((r) => r[col.Event] === event && active(r[col.Status]) && (r[col.Date] === date
      || (date.length === 7 && r[col.Date].startsWith(date + "-"))
      || (date.length === 10 && r[col.Date] === date.slice(0, 7))))
    .map((r) => ({ r, out: outReason(r[col["US Chess ID"]]) }))
    .filter(({ out }) => td || !out)
    .map(({ r, out }) => {
      const entry = { name: r[col.Name], id: r[col["US Chess ID"]], rating: r[col["Regular rating"]],
        for: r[col.Date].length === 7 ? "Whole month" : nightLabel(r[col.Date]) };
      if (sectionOf[entry.id]) entry.section = sectionOf[entry.id];
      if (td) {
        const credit = ((ledger[r[col.Token]] || {}).credit || 0) / 100;
        const due = r[col.Amount] === "" ? "" : money(Math.max(0, Math.round((Number(r[col.Amount]) - credit) * 100) / 100));
        Object.assign(entry, { out, category: r[col.Category], amount: r[col.Amount], paid: r[col.Paid],
          paidOn: r[col["Paid on"]], paidBy: r[col["Paid by"]] || "", email: r[col.Email],
          credit: credit ? money(credit) : "", due, card: due === "" || due === "0" ? "" : money(cardTotal(Number(due), card)),
          expires: r[col["Membership expires"]], addedBy: r[col["Added by"]], token: r[col.Token], date: r[col.Date],
          phone: r[col.Phone] });
      }
      return entry;
    })
    .sort((a, b) => (parseInt(b.rating) || 0) - (parseInt(a.rating) || 0) || a.name.localeCompare(b.name));
  if (!td) cachePut(entriesKey(key), JSON.stringify(list));
  return list;
}

/** The public lists for every tournament date and club night still to come, in date order. */
function allEntries() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(allEntriesKey());
  if (cached) return JSON.parse(cached);
  const read = { ...readEntries(), logged: readIncidents().rows, placed: sectionsByKey() };
  const today = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  const list = Object.entries(clubEvents())
    .filter(([, e]) => e.kind !== "month" && e.first >= today)
    .sort(([, a], [, b]) => a.closes.localeCompare(b.closes))
    .map(([key, e]) => ({ key, name: e.name, label: e.label, page: e.page, closed: Boolean(e.closed), start: e.closes,
      entries: entries(key, false, read) }));
  cachePut(allEntriesKey(), JSON.stringify(list));
  return list;
}

/** What the TD desk can register for: every club event key whose date hasn't passed. */
function choices() {
  const today = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  return Object.entries(clubEvents())
    .filter(([, e]) => e.last >= today)
    .map(([key, e]) => ({ key, name: e.name, label: e.label, kind: e.kind, first: e.first, format: e.format || "",
      rounds: e.rounds || "", closed: Boolean(e.closed) }))
    .sort((a, b) => a.first.localeCompare(b.first) || (a.kind === "month" ? -1 : 1));
}

/** Players who have registered before, by US Chess ID or by every word of a name. The desk before it
 *  searched as you type asked this on each keystroke. */
function history(q) {
  q = String(q || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/);
  return people().filter((p) => (/^\d+$/.test(q) ? p.id.startsWith(q) : words.every((w) => p.name.toLowerCase().includes(w))))
    .slice(0, 12);
}

/** Everyone who has registered, each as of their latest registration, with their contact's email and
 *  phone when the registration has none: the TD desk loads these once and searches them as the TD
 *  types, so most searches never reach US Chess. */
function people() {
  const { col, rows } = readEntries();
  const latest = new Map();
  for (const r of rows) {
    if (r[col["US Chess ID"]]) latest.set(r[col["US Chess ID"]], r);
  }
  return [...latest.values()].map((r) => {
    const contact = contactFor(r[col.Name], r[col["US Chess ID"]]);
    return { id: r[col["US Chess ID"]], name: r[col.Name], state: "", rating: r[col["Regular rating"]],
      expires: r[col["Membership expires"]], known: true, email: r[col.Email] || contact?.email || "",
      phone: r[col.Phone] || contact?.phone || "" };
  });
}

/**
 * The club contact, from the Sheet's Contacts tab (the club's contact list), with the player's US
 * Chess ID, or else whose first and last names match the player's; null if none or several.
 * A nickname in parentheses, as in "Anthony (Tony) Whitt", matches as a first name too. Only the
 * TD desk reads contacts.
 */
let contactRows = null;

function contactFor(name, id) {
  if (!name) return null;
  if (!contactRows) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Contacts");
    contactRows = sheet ? sheet.getDataRange().getDisplayValues() : [[]];
  }
  const words = (s) => String(s).toLowerCase().normalize("NFD").replace(/[^a-z\s()-]/g, "").split(/\s+/).filter(Boolean);
  const player = words(name.replace(/\(.*?\)/g, " "));
  if (player.length < 2) return null;
  const [header, ...rows] = contactRows;
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  if (col.Name === undefined) return null;
  const byId = id && col["US Chess ID"] !== undefined && rows.filter((r) => r[col["US Chess ID"]] === id);
  if (byId && byId.length === 1) return { email: byId[0][col.Email], phone: byId[0][col.Phone] };
  const matches = rows.filter((r) => {
    const all = words(r[col.Name]);
    const plain = all.filter((w) => !w.startsWith("("));
    const firsts = [plain[0], ...all.filter((w) => w.startsWith("(")).map((w) => w.replace(/[()]/g, ""))];
    return plain.length >= 2 && plain.at(-1) === player.at(-1) && firsts.includes(player[0]);
  });
  return matches.length === 1 ? { email: matches[0][col.Email], phone: matches[0][col.Phone] } : null;
}

// Headings the desk's Contacts section needs; the tab's others are its own, and the desk shows them all.
const CONTACT_HEADINGS = ["Name", "Email", "Phone", "US Chess ID", "ID"];

/** The Contacts tab for the desk's Contacts section: its headings but ID, and each contact. A contact
 *  added in the Sheet by hand gets its ID here. */
function contacts() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { sheet, col, rows } = readTab("Contacts", CONTACT_HEADINGS);
    const headings = Object.keys(col).filter((h) => h && h !== "ID");
    const list = [];
    rows.forEach((r, i) => {
      if (!r.some(Boolean)) return;
      if (!r[col.ID]) {
        r[col.ID] = Utilities.getUuid();
        sheet.getRange(i + 2, col.ID + 1).setNumberFormat("@").setValue(r[col.ID]);
      }
      list.push({ id: r[col.ID], ...Object.fromEntries(headings.map((h) => [h, r[col[h]]])) });
    });
    return { headings, contacts: list };
  } finally {
    lock.releaseLock();
  }
}

/** Adds a contact, or changes the one with p.id, from p.fields, JSON by heading; headings it leaves
 *  out keep their values. */
function saveContact(p) {
  let fields;
  try {
    fields = JSON.parse(p.fields || "{}");
  } catch (err) {
    return { error: "The contact didn't arrive whole. Try again." };
  }
  const name = String(fields.Name || "").trim();
  if (!name) return { error: "A contact needs a name." };
  if (fields["US Chess ID"] && !/^\d{8}$/.test(String(fields["US Chess ID"]).trim())) return { error: "A US Chess ID is eight digits." };
  // A leading = + - or @ would make the Sheet read the cell as a formula.
  const plain = (v) => {
    const text = String(v ?? "").trim();
    return /^[=+\-@]/.test(text) ? "'" + text : text;
  };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { sheet, col, rows } = readTab("Contacts", CONTACT_HEADINGS);
    const index = p.id ? rows.findIndex((r) => r[col.ID] === p.id) : -1;
    if (p.id && index < 0) return { error: "That contact is no longer in the Sheet. Reload the contacts." };
    const row = index >= 0 ? [...rows[index]] : new Array(Object.keys(col).length).fill("");
    for (const [h, i] of Object.entries(col)) if (h !== "ID" && h in fields) row[i] = plain(fields[h]);
    const id = index >= 0 ? p.id : Utilities.getUuid();
    row[col.ID] = id;
    if (index >= 0) {
      sheet.getRange(index + 2, 1, 1, row.length).setNumberFormat("@").setValues([row]);
    } else {
      appendText(sheet, col, Object.fromEntries(Object.entries(col).map(([h, i]) => [h, row[i]])));
    }
    touch("contacts");
    return { ok: true, id, message: `${name} is saved.` };
  } finally {
    lock.releaseLock();
  }
}

function deleteContact(id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { sheet, col, rows } = readTab("Contacts", CONTACT_HEADINGS);
    const index = id ? rows.findIndex((r) => r[col.ID] === id) : -1;
    if (index < 0) return { error: "That contact is no longer in the Sheet. Reload the contacts." };
    sheet.deleteRow(index + 2);
    touch("contacts");
    return { ok: true, message: `${rows[index][col.Name]} is deleted.` };
  } finally {
    lock.releaseLock();
  }
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
  const players = found.slice(0, 12).map((m) => {
    const contact = contactFor(displayName(m));
    return { id: m.id, name: displayName(m), state: m.stateRep || "", rating: rating(m, "R"),
      expires: m.expirationDate || "", email: contact?.email || "", phone: contact?.phone || "" };
  });
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
<? } else if (row.status === moved) { ?><p><?= row.name ?> moved to the whole month. To withdraw, use the link in the month's confirmation email.</p>
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
  page.moved = MOVED;
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
    if (row.status === MOVED) return `${row.name} moved to the whole month; withdraw from the month instead.`;
    const { sheet, col } = readEntries();
    sheet.getRange(row.index + 2, col.Status + 1).setValue("withdrawn");
    clearEntriesCache();
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
    clearEntriesCache();
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
// rounds: the desk pairs its games (Arena tab) with arena.js from the players waiting (queues()),
// and they're public as soon as they're paired.
//
// A Swiss may have sections, such as Open and Under 1400, each paired and ranked on its own (28A,
// 29). Tournaments' Sections cell holds them as JSON, [{"name":"Open"},{"name":"Under 1400",
// "under":1400}], and each Players and Rounds row names its section; boards are numbered within
// each. Quads are sections Quad 1, Quad 2, and so on. A tournament started before sections has
// none of these, and runs as one section, or as quads by number, as it always did.

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
      rating: /^\d+/.test(r.Rating) ? parseInt(r.Rating) : null, out: r["Out from round"] ? Number(r["Out from round"]) : null,
      section: r.Section || "", floor: /^\d+$/.test(r.Floor) ? Number(r.Floor) : null,
      games: /^\d+$/.test(r["Prior games"]) ? Number(r["Prior games"]) : null, sweep: r["Prior sweep"] || "",
      state: r.State || "" }));
  const lines = table("Rounds").rows.filter((r) => r.Key === key && (td || r.Posted));
  const count = lines.reduce((m, r) => Math.max(m, Number(r.Round)), 0);
  const rounds = [...Array(count)].map((_, i) => {
    const n = i + 1;
    const here = lines.filter((r) => Number(r.Round) === n);
    return {
      games: here.filter((r) => r.Black).sort((a, b) => Number(a.Board) - Number(b.Board))
        .map((r) => {
          const game = { board: Number(r.Board), white: r.White, black: r.Black, result: r.Result, section: r.Section || "" };
          if (r["White report"] || r["Black report"]) game.reports = { white: r["White report"], black: r["Black report"] };
          return game;
        }),
      byes: here.filter((r) => !r.Black).map((r) => ({ id: r.White, points: Number(r["Bye points"]) || 0, section: r.Section || "",
        kind: r["Bye kind"] || "" })),
      out: players.filter((p) => p.out && p.out <= n).map((p) => p.id),
      posted: here.some((r) => r.Posted),
      postedAt: (here.find((r) => r.Posted) || { Posted: "" }).Posted,
    };
  });
  const result = { key, event: info.Event, name: info.Name, format: info.Format, rounds: rounds,
    plannedRounds: Number(info.Rounds) || null, status: info.Status, coin: info.Coin, sections: sectionsOf(info), players,
    td: info.TD || "" };
  const event = ratedEvents()[key];
  if (event) Object.assign(result, { status: "rated", usChessEvent: event });
  if (info.Format === "arena") {
    result.cutoff = info.Cutoff;
    result.games = table("Arena").rows.filter((r) => r.Key === key)
      .sort((a, b) => Number(a.Game) - Number(b.Game))
      .map((r) => ({ game: Number(r.Game), white: r.White, black: r.Black, whitePact: r["White pact"] === "yes",
        blackPact: r["Black pact"] === "yes", result: r.Result, started: r.Started, ended: r.Ended }));
    result.queue = queues()[key] || [];
  }
  return result;
}

/** { key: US Chess event ID } for each tournament US Chess has rated with the desk's results, from the
 *  website's ratings.json, which its Results Action keeps. None when the site doesn't answer. */
function ratedEvents() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("rated");
  if (cached) return JSON.parse(cached);
  try {
    const response = UrlFetchApp.fetch(SITE + "/ratings.json", { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) return {};
    const rated = JSON.parse(response.getContentText());
    cache.put("rated", JSON.stringify(rated), 300);
    return rated;
  } catch (err) {
    console.error(err);
    return {};
  }
}

function rated(key) {
  return Boolean(ratedEvents()[key]);
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
    const format = ["arena", "quad"].includes(p.format) ? p.format : "swiss";
    // 30G: a quad is a three-round round robin.
    const rounds = format === "quad" ? "3" : format === "arena" ? "" : String(p.rounds || "").trim();
    const cutoff = format === "arena" ? String(p.cutoff || "").trim() : "";
    if (format === "arena" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) return { error: "No new games after what time? Such as 17:30." };
    const defined = format === "swiss" && p.sections !== undefined ? parseSections(p.sections) : { sections: [] };
    if (defined.error) return defined;
    appendText(t.sheet, t.col, { Key: key, Event: event.event, Name: `${event.name}, ${event.label}`, Format: format,
      Rounds: rounds, Status: "running", Started: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"),
      Coin: p.coin === "black" ? "black" : "white", Finished: "", Cutoff: cutoff,
      Sections: defined.sections.length ? JSON.stringify(defined.sections) : "", TD: /^\d{8}$/.test(p.td || "") ? p.td : "" });
  } finally {
    lock.releaseLock();
  }
  const synced = syncPlayers(key);
  if (p.format === "quad") numberQuads(key);
  return synced;
}

/** Changes how many rounds a Swiss plays: more, or as few as are paired, to stop early. */
function setRounds(p) {
  const key = `${p.event}/${p.date}`;
  const rounds = String(p.rounds || "").trim();
  if (!/^[1-9]\d?$/.test(rounds)) return { error: "Rounds is a number from 1 to 99." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = table("Tournaments");
    const line = t.rows.find((r) => r.Key === key);
    if (!line) return { error: "No such tournament." };
    if (line.Format !== "swiss") return { error: "Only a Swiss can change its number of rounds." };
    const paired = table("Rounds").rows.filter((r) => r.Key === key).reduce((m, r) => Math.max(m, Number(r.Round)), 0);
    if (Number(rounds) < paired) return { error: `${paired} rounds are paired already, so it can't have fewer.` };
    setCell(t, line.row, "Rounds", rounds);
    clearTournamentCache();
    return { ok: true, message: `It plays ${rounds} rounds.` };
  } finally {
    lock.releaseLock();
  }
}

/** Deletes everything the tournament spreadsheet has for a tournament, so it can be started again.
 *  Its entries stay in the registration Sheet. */
function restartTournament(key) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (!table("Tournaments").rows.some((r) => r.Key === key)) return { error: "No such tournament." };
    for (const name of Object.keys(TOURNAMENT_HEADERS)) {
      const t = table(name);
      for (const r of t.rows.filter((x) => x.Key === key).reverse()) t.sheet.deleteRow(r.row);
    }
    setQueue(key, []);
    clearTournamentCache();
    return { ok: true, message: "Deleted. Start it again when ready." };
  } finally {
    lock.releaseLock();
  }
}

/** 30G and 30A: quads are groups of four by rating, and within each the table numbers are drawn by
 *  lot. Each quad is a section; numbers 5 to 8 are still the second quad's. */
function numberQuads(key) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = table("Players");
    const mine = t.rows.filter((r) => r.Key === key).sort((a, b) => (parseInt(b.Rating) || 0) - (parseInt(a.Rating) || 0));
    const quads = [];
    for (let g = 0; g < mine.length; g += 4) {
      const group = mine.slice(g, g + 4);
      const numbers = group.map((_, i) => g + i + 1);
      for (let i = numbers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
      }
      const name = `Quad ${g / 4 + 1}`;
      quads.push({ name });
      group.forEach((r, i) => {
        setCell(t, r.row, "No.", String(numbers[i]));
        setCell(t, r.row, "Section", name);
      });
    }
    const info = table("Tournaments");
    const line = info.rows.find((r) => r.Key === key);
    if (line && quads.length) setCell(info, line.row, "Sections", JSON.stringify(quads));
    clearTournamentCache();
  } finally {
    lock.releaseLock();
  }
}

/** Adds registered entrants who aren't players yet, numbered after the others (28B), each in the
 *  section their rating puts them in. */
function syncPlayers(key) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const info = table("Tournaments").rows.find((r) => r.Key === key);
    const defs = info && info.Format !== "quad" ? sectionsOf(info) : [];
    const t = table("Players");
    const have = new Set(t.rows.filter((r) => r.Key === key).map((r) => r["US Chess ID"]));
    let number = t.rows.filter((r) => r.Key === key).reduce((m, r) => Math.max(m, Number(r["No."]) || 0), 0);
    // A month's entrants include each night's; entries() already leaves out the expelled and barred.
    const entrants = entries(key, true).filter((e) => !e.out && !have.has(e.id));
    entrants.sort((a, b) => (parseInt(b.rating) || 0) - (parseInt(a.rating) || 0));
    // Players added before the records were kept get them now.
    const unrecorded = t.rows.filter((r) => r.Key === key && (r["Prior games"] === "" || !r.State));
    const records = priorRecords([...entrants.map((e) => e.id), ...unrecorded.map((r) => r["US Chess ID"])]);
    for (const e of entrants) {
      if (have.has(e.id)) continue;
      have.add(e.id);
      appendText(t.sheet, t.col, { Key: key, "No.": String(++number), "US Chess ID": e.id, Name: e.name,
        Rating: e.rating || "", "Out from round": "", Section: defs.length ? placeIn(defs, e.rating) : "", ...records[e.id] });
    }
    for (const r of unrecorded) {
      for (const [heading, value] of Object.entries(records[r["US Chess ID"]] || {})) setCell(t, r.row, heading, value);
    }
    clearTournamentCache();
    return { ok: true, added: entrants.length, message: entrants.length ? `Added ${entrants.length} player(s).` : "No new entrants." };
  } finally {
    lock.releaseLock();
  }
}

/** Saves a round's pairings and byes; posted makes them public. Replaces the round if it was saved before. */
const FORFEITS = ["1F-0F", "0F-1F", "0F-0F"];
// A round without a game: a full-point bye, a half-point bye, a zero-point bye asked for in
// advance, or unplayed (such as a no-show), with the points each scores. pairing.js has the same.
const BYE_KINDS = { bye: 1, half: 0.5, zero: 0, unplayed: 0 };

/** Reclassifies a player's round without a game, such as an unplayed round the TD later excuses
 *  as a half-point bye; the points follow the kind. */
function saveByeKind(p) {
  if (BYE_KINDS[p.kind] === undefined) return { error: "Not a kind of bye." };
  const key = `${p.event}/${p.date}`;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = table("Rounds");
    const line = t.rows.find((r) => r.Key === key && Number(r.Round) === Number(p.number) && r.White === p.id && !r.Black);
    if (!line) return { error: "That player has a game that round, not a bye." };
    setCell(t, line.row, "Bye kind", p.kind);
    setCell(t, line.row, "Bye points", String(BYE_KINDS[p.kind]));
    clearTournamentCache();
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

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
    // A saved round can hold forfeits for quad players not here; only a posted round's results block re-pairing.
    if (old.some((r) => r.Result && r.Posted)) return { error: "This round has results; clear them before re-pairing (29G)." };
    for (const r of old.reverse()) t.sheet.deleteRow(r.row);
    const posted = p.post === "yes" ? Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm") : "";
    const fresh = table("Rounds");
    for (const g of games) {
      appendText(fresh.sheet, fresh.col, { Key: key, Round: String(round), Board: String(g.board), White: g.white,
        Black: g.black, Result: FORFEITS.includes(g.result) ? g.result : "", "Bye points": "", Posted: posted,
        Section: String(g.section || "") });
    }
    for (const b of byes) {
      appendText(fresh.sheet, fresh.col, { Key: key, Round: String(round), Board: "", White: b.id, Black: "",
        Result: "", "Bye points": String(b.points), Posted: posted, Section: String(b.section || ""),
        "Bye kind": BYE_KINDS[b.kind] !== undefined ? b.kind : "" });
    }
    clearTournamentCache();
    return { ok: true, message: posted ? `Round ${round} is posted.` : `Round ${round} is saved, not posted.` };
  } finally {
    lock.releaseLock();
  }
}

/** A board's Rounds row. A desk from before sections sends no section and saves rounds without
 *  one, with boards unique in the round. */
function boardLine(t, key, number, board, section) {
  const here = t.rows.filter((r) => r.Key === key && Number(r.Round) === Number(number) && r.Black && Number(r.Board) === Number(board));
  return here.find((r) => section === undefined || r.Section === section) || here.find((r) => !r.Section);
}

function saveResult(p) {
  return saveResults({ ...p, results: JSON.stringify([{ board: p.board, section: p.section, result: p.result }]) });
}

/** Enters results for boards of a round, [{ board, section, result }], such as every result both players reported alike. */
function saveResults(p) {
  const key = `${p.event}/${p.date}`;
  const allowed = ["", "1-0", "0-1", "1/2-1/2", "1F-0F", "0F-1F", "0F-0F"];
  const list = JSON.parse(p.results || "[]");
  if (!list.length || list.some((x) => !allowed.includes(x.result))) return { error: "Not a result." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = table("Rounds");
    const lines = list.map((x) => boardLine(t, key, p.number, x.board, x.section));
    if (lines.some((line) => !line)) return { error: "No such board." };
    lines.forEach((line, i) => setCell(t, line.row, "Result", list[i].result));
    clearTournamentCache();
    return { ok: true, message: list.length > 1 ? `${list.length} results are entered.` : "" };
  } finally {
    lock.releaseLock();
  }
}

const REPORTS = { "1-0": "1–0", "0-1": "0–1", "1/2-1/2": "½–½" };

/** A player's report of their game's result, from the Pairings page. Anyone can send one for any
 *  player, so it never sets Result: the TD confirms it on the desk. Re-pairing the round clears it. */
function reportResult(p) {
  if (!underLimit()) return { error: "Too many reports right now. Try again in a minute." };
  const id = String(p.id || "").trim();
  if (!/^\d{8}$/.test(id)) return { error: "A US Chess ID is eight digits." };
  if (!REPORTS[p.result]) return { error: "Report 1–0, 0–1, or ½–½." };
  const key = `${p.event}/${p.date}`;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const info = table("Tournaments").rows.find((r) => r.Key === key);
    if (!info || info.Format === "arena" || info.Status !== "running" || rated(key)) return { error: "That tournament isn't taking results." };
    const t = table("Rounds");
    const line = boardLine(t, key, p.number, p.board, p.section);
    if (!line || !line.Posted || (line.White !== id && line.Black !== id)) {
      return { error: `That player isn't on board ${p.board} in round ${p.number}. Reload the pairings.` };
    }
    if (line.Result) return { error: "The TD has already entered this game's result." };
    setCell(t, line.row, line.White === id ? "White report" : "Black report", p.result);
    clearTournamentCache();
    return { ok: true, message: `Board ${line.Board}: ${REPORTS[p.result]} is reported. The TD will confirm it.` };
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

/** A tournament's sections from its Tournaments row; [] for one started before sections. */
function sectionsOf(info) {
  try {
    const list = JSON.parse(info.Sections || "[]");
    return Array.isArray(list) ? list.filter((s) => s && s.name) : [];
  } catch (err) {
    return [];
  }
}

/** The sections the desk sent, [{ name, under }], or an error. */
function parseSections(text) {
  let list;
  try {
    list = JSON.parse(text || "[]");
  } catch (err) {
    list = null;
  }
  if (!Array.isArray(list) || !list.length) return { error: "Give the tournament at least one section, such as Open." };
  const sections = [];
  for (const s of list) {
    const name = String((s && s.name) || "").trim().replace(/\s+/g, " ");
    const under = String(s && s.under != null ? s.under : "").trim();
    // US Chess's rating report keeps 30 characters of a section's name.
    if (!name || name.length > 30) return { error: "Each section needs a name of up to 30 characters." };
    if (sections.some((x) => x.name.toLowerCase() === name.toLowerCase())) return { error: `Two sections are named ${name}.` };
    if (under && !/^\d{3,4}$/.test(under)) return { error: `${name}: the rating limit is a number, such as 1400, or empty for none.` };
    sections.push(under ? { name, under: Number(under) } : { name });
  }
  return { sections };
}

/** pairing.js's placeIn: the section with the lowest limit the rating is under, or else one without a limit. */
function placeIn(defs, rating) {
  const r = parseInt(rating, 10);
  const allowed = defs.filter((s) => !s.under || isNaN(r) || r < Number(s.under));
  const limited = allowed.filter((s) => s.under).sort((a, b) => a.under - b.under);
  const best = limited[0] || allowed[0] || defs.slice().sort((a, b) => (b.under || Infinity) - (a.under || Infinity))[0];
  return best ? best.name : "";
}

/** Sections can change until round 1 is posted or has a result; a saved round 1 is deleted, to be paired again. */
function beforeRoundOne(key) {
  const t = table("Rounds");
  const mine = t.rows.filter((r) => r.Key === key);
  if (mine.some((r) => r.Posted || r.Result)) return "Round 1 is posted, so sections can't change now: a player plays in one section.";
  for (const r of mine.reverse()) t.sheet.deleteRow(r.row);
  return "";
}

/** Sets a Swiss's sections and puts every player in the one their rating gives, before round 1. */
function setSections(p) {
  const key = `${p.event}/${p.date}`;
  const parsed = parseSections(p.sections);
  if (parsed.error) return parsed;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const info = table("Tournaments");
    const line = info.rows.find((r) => r.Key === key);
    if (!line) return { error: "No such tournament." };
    if (line.Format !== "swiss") return { error: "Only a Swiss has sections to set; quads are grouped when they start." };
    const late = beforeRoundOne(key);
    if (late) return { error: late };
    setCell(info, line.row, "Sections", JSON.stringify(parsed.sections));
    const t = table("Players");
    for (const r of t.rows.filter((x) => x.Key === key)) setCell(t, r.row, "Section", placeIn(parsed.sections, r.Rating));
    clearTournamentCache();
    return { ok: true, message: `Sections: ${parsed.sections.map((s) => s.name).join(", ")}. Everyone is placed by rating.` };
  } finally {
    lock.releaseLock();
  }
}

/** Moves a player to another section before round 1. A player may play up, never down. */
function setSection(p) {
  const key = `${p.event}/${p.date}`;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const info = table("Tournaments").rows.find((r) => r.Key === key);
    if (!info) return { error: "No such tournament." };
    if (info.Format !== "swiss") return { error: "Quads are grouped by rating when they start." };
    const def = sectionsOf(info).find((s) => s.name === p.section);
    if (!def) return { error: "No such section." };
    const t = table("Players");
    const line = t.rows.find((r) => r.Key === key && r["US Chess ID"] === p.id);
    if (!line) return { error: "Not a player in this tournament." };
    const r = parseInt(line.Rating, 10);
    if (def.under && r >= def.under) {
      return { error: `${line.Name} is rated ${line.Rating}, too high for ${def.name}. A player may play up, not down.` };
    }
    const late = beforeRoundOne(key);
    if (late) return { error: late };
    setCell(t, line.row, "Section", def.name);
    clearTournamentCache();
    return { ok: true, message: `${line.Name} plays in ${def.name}.` };
  } finally {
    lock.releaseLock();
  }
}

/** Each running tournament's players' sections, { key: { id: section } }, where it has more than one section. */
function sectionsByKey() {
  try {
    const several = new Set(table("Tournaments").rows.filter((r) => sectionsOf(r).length > 1).map((r) => r.Key));
    const out = {};
    for (const r of table("Players").rows) {
      if (several.has(r.Key) && r.Section) (out[r.Key] = out[r.Key] || {})[r["US Chess ID"]] = r.Section;
    }
    return out;
  } catch (err) {
    console.error(err);
    return {};
  }
}

// Arenas. Every write rereads the tabs under the lock, so two desks can't put a player in two games.

const stamp = (pattern) => Utilities.formatDate(new Date(), TZ, pattern || "yyyy-MM-dd HH:mm:ss");

function runningArena(key) {
  const info = table("Tournaments").rows.find((r) => r.Key === key);
  if (!info || info.Format !== "arena") return { error: "No arena is running for this." };
  if (info.Status !== "running") return { error: "This arena isn't running." };
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
    const queue = queues()[key] || [];
    if (queue.some((q) => q.id === p.id)) return { error: `${player.Name} is already waiting.` };
    const playing = table("Arena").rows.some((r) => r.Key === key && !r.Result && (r.White === p.id || r.Black === p.id));
    if (playing) return { error: `${player.Name} is in a game.` };
    setQueue(key, [...queue, { id: p.id, since: stamp() }]);
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
    setQueue(key, (queues()[key] || []).filter((q) => q.id !== p.id));
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
    const queue = queues()[key] || [];
    const waiting = new Set(queue.map((q) => q.id));
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
    setQueue(key, queue.filter((q) => !started.includes(q.id)));
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
    setQueue(key, [...(queues()[key] || []), ...back.map((id) => ({ id, since: stamp() }))]);
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
    setQueue(key, [...(queues()[key] || []), ...[line.White, line.Black].map((id) => ({ id, since: stamp() }))]);
    clearTournamentCache();
    return { ok: true, message: `Game ${p.game} is taken back.` };
  } finally {
    lock.releaseLock();
  }
}

/** Each running arena's waiting players, [{ id, since }] by tournament key, from the script property
 *  arenaQueues: the script alone uses them, and only while the arena runs. */
function queues() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty("arenaQueues") || "{}");
  } catch (err) {
    return {};
  }
}

/** Sets one arena's queue, and drops any tournament's no longer in the spreadsheet. Callers hold the script lock. */
function setQueue(key, list) {
  const all = queues();
  const running = new Set(table("Tournaments").rows.map((r) => r.Key));
  for (const k of Object.keys(all)) if (k === key || !running.has(k)) delete all[k];
  if (list.length && running.has(key)) all[key] = list;
  PropertiesService.getScriptProperties().setProperty("arenaQueues", JSON.stringify(all));
}

/** Every tournament in the spreadsheet, with only posted rounds, for the public Pairings page. */
function currentTournaments() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("tournaments");
  if (cached) return JSON.parse(cached);
  const list = table("Tournaments").rows.map((r) => tournament(r.Key, false)).filter(Boolean);
  cachePut("tournaments", JSON.stringify(list));
  return list;
}

/** Clears the Pairings and Standings pages' copy, and the entry lists, which show each player's section. */
function clearTournamentCache() {
  CacheService.getScriptCache().removeAll(["tournaments", "entriesVersion"]);
  touch("tournaments");
}

// The public pages' copies of the entry lists and tournaments last six hours, the longest Apps Script
// keeps anything: every change the script makes clears them, so they're only ever stale after an edit
// made in the Sheet by hand, which the TD desk's Refresh clears.
const PUBLIC_CACHE = 21600;

/** Caches a public copy. Apps Script refuses a value over 100 KB; then the pages read the Sheet each time. */
function cachePut(key, value) {
  try {
    CacheService.getScriptCache().put(key, value, PUBLIC_CACHE);
  } catch (err) {
    console.error(`not cached: ${key}, ${value.length} characters`);
  }
}

/** The entry lists' copies are kept under a version, so one change clears them all: a new version. */
function entriesKey(key) {
  const cache = CacheService.getScriptCache();
  let version = cache.get("entriesVersion");
  if (!version) {
    version = Utilities.getUuid().slice(0, 8);
    cache.put("entriesVersion", version, PUBLIC_CACHE);
  }
  return `entries:${version}:${key}`;
}

/** The Entries page's list: by day, since a day's events drop off it at midnight, and by the events
 *  themselves, so one added to or moved on the calendar shows without waiting for the copy to expire. */
function allEntriesKey() {
  const events = JSON.stringify(Object.entries(clubEvents()).map(([key, e]) => [key, e.label, e.closes, e.closed]));
  let hash = 0;
  for (let i = 0; i < events.length; i++) hash = (hash * 31 + events.charCodeAt(i)) | 0;
  return entriesKey(`all:${Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd")}:${(hash >>> 0).toString(36)}`);
}

function clearEntriesCache() {
  CacheService.getScriptCache().remove("entriesVersion");
  touch("entries");
}

// The TD desk asks for these every few seconds and reloads whatever has a new stamp, so a change made
// on another desk or on the website shows without a reload. A stamp the cache has dropped reads as
// "", which costs the desks one reload.
const CHANGE_SCOPES = ["entries", "tournaments", "contacts"];

function touch(...scopes) {
  const stamp = Math.random().toString(36).slice(2, 10);
  CacheService.getScriptCache().putAll(Object.fromEntries(scopes.map((s) => [`changed:${s}`, stamp])), PUBLIC_CACHE);
}

function changes() {
  const stamps = CacheService.getScriptCache().getAll(CHANGE_SCOPES.map((s) => `changed:${s}`));
  return Object.fromEntries(CHANGE_SCOPES.map((s) => [s, stamps[`changed:${s}`] || ""]));
}

/** The TD desk's Refresh: clears every copy the public pages and the script keep, and builds the
 *  public pages' copies again from the Sheets. */
function refreshCaches() {
  CacheService.getScriptCache().removeAll(["clubEvents", "prices", "rated", "tournaments", "entriesVersion"]);
  touch(...CHANGE_SCOPES);
  const lists = allEntries().length;
  const months = Object.entries(clubEvents()).filter(([, e]) => e.kind === "month");
  for (const [key] of months) entries(key, false);
  const tournaments = currentTournaments().length;
  return { ok: true, message: `Refreshed ${lists + months.length} entry lists and ${tournaments} ${tournaments === 1 ? "tournament" : "tournaments"}.` };
}

/** Records what a player paid at the door and how, or, when amount is empty, marks them unpaid with
 *  corrections that cancel their payments. */
function markPaid(token, amount, by) {
  amount = String(amount || "").trim().replace(/^\$/, "");
  if (amount && !/^\d+(\.\d\d)?$/.test(amount)) return { error: "Enter the amount paid, such as 15." };
  // The desk before payment methods sent nothing for a payment that wasn't by card.
  const method = by || "cash";
  if (!METHODS.includes(method)) return { error: "Choose how they paid." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const row = findToken(token);
    if (!row) return { error: "No registration matches this." };
    const { sheet, col, rows } = readEntries();
    const r = rows[row.index];
    const book = readPayments();
    const mine = book.rows.filter((x) => x.Token === token);
    if (amount) {
      const event = clubEvents()[`${row.event}/${row.date}`];
      const listed = r[col["Rating fee"]];
      const fee = listed !== "" ? Number(listed) : event ? ratingFee(event, prices().fees) : null;
      const split = allocate(cents(amount), method, fee === null ? null : cents(fee), sum(mine, "Rating fee"), prices().fees.card);
      addPayment(book, token, partyOf(r, col), { Type: "payment", Method: method, Received: cents(amount), ...split,
        Note: fee === null ? "Rating fee unknown, so all of it counted as entry fee." : "" });
    } else {
      const reversed = new Set(mine.map((x) => x.Reverses).filter(Boolean));
      for (const x of mine.filter((x) => x.Type === "payment" && !reversed.has(x["No."]))) {
        addPayment(book, token, partyOf(r, col), { Type: "correction", Method: x.Method, Received: -cents(x.Received),
          "Entry fee": -cents(x["Entry fee"]), "Rating fee": -cents(x["Rating fee"]), "Card fee": -cents(x["Card fee"]),
          Reverses: x["No."], Note: "Marked unpaid" });
      }
    }
    const when = amount ? Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm") : "";
    sheet.getRange(row.index + 2, col.Paid + 1).setNumberFormat("@").setValue(amount);
    sheet.getRange(row.index + 2, col["Paid on"] + 1).setNumberFormat("@").setValue(when);
    sheet.getRange(row.index + 2, col["Paid by"] + 1).setNumberFormat("@").setValue(amount ? method : "");
    touch("entries");
    return { ok: true, message: amount ? `${row.name} paid $${amount} by ${method}.` : `${row.name} is marked unpaid.` };
  } finally {
    lock.releaseLock();
  }
}

/** Splits a payment, in cents: the card fee is what paying by card added to the base, the
 *  largest amount whose card total fits in what was received; of the base, the rating fee
 *  still unpaid comes first, and the rest is entry fee. */
function allocate(received, method, ratingDue, ratingPaid, card) {
  let base = received;
  if (method === "card") {
    base = Math.max(0, Math.floor((received - card.fixed * 100) / (1 + card.percent / 100)));
    while (Math.round(cardTotal((base + 1) / 100, card) * 100) <= received) base++;
  }
  const rating = ratingDue === null ? 0 : Math.min(base, Math.max(0, ratingDue - ratingPaid));
  return { "Entry fee": base - rating, "Rating fee": rating, "Card fee": received - base };
}

/** Moves a player's nights to the month they just registered for: marks them moved and credits
 *  their entry and rating fees, never a card fee, to the month, up to its amount. Returns the
 *  credit in dollars. */
function moveToMonth(sheet, col, rows, nights, month, amount) {
  const book = readPayments();
  const held = ledgerByToken(book);
  let room = amount === null ? Infinity : cents(amount);
  let total = 0;
  for (const r of nights) {
    sheet.getRange(rows.indexOf(r) + 2, col.Status + 1).setNumberFormat("@").setValue(MOVED);
    const h = held[r[col.Token]];
    if (!h) continue;
    const rating = Math.max(0, Math.min(h.rating, room));
    room -= rating;
    const entry = Math.max(0, Math.min(h.entry, room));
    room -= entry;
    if (!rating && !entry) continue;
    addPayment(book, r[col.Token], partyOf(r, col), { Type: "credit", "Entry fee": -entry, "Rating fee": -rating,
      Note: `To the whole month, ${month.Token}` });
    addPayment(book, month.Token, month, { Type: "credit", "Entry fee": entry, "Rating fee": rating,
      Note: `From ${nightLabel(r[col.Date])}, ${r[col.Token]}` });
    total += rating + entry;
  }
  return total / 100;
}

/** What each registration holds in the ledger, in cents: received, entry, rating, card, and credit
 *  (what credits moved in, or out when negative). */
function ledgerByToken(book) {
  const held = {};
  for (const x of (book || readPayments()).rows) {
    if (!held[x.Token]) held[x.Token] = { received: 0, entry: 0, rating: 0, card: 0, credit: 0 };
    const h = held[x.Token];
    h.received += cents(x.Received);
    h.entry += cents(x["Entry fee"]);
    h.rating += cents(x["Rating fee"]);
    h.card += cents(x["Card fee"]);
    if (x.Type === "credit") h.credit += cents(x["Entry fee"]) + cents(x["Rating fee"]);
  }
  return held;
}

/** The ledger's totals for a key, for the TD desk: received by method, and how it splits. A month
 *  includes its nights. For a tournament, US Chess's charge for the rated games played so far,
 *  while the tournament spreadsheet still has them. */
function ledgerFor(key) {
  const [event, date] = String(key).split("/");
  const rows = readPayments().rows.filter((x) => x.Event === event
    && (x.Date === date || (date.length === 7 && x.Date.startsWith(date + "-"))));
  const total = (field, keep) => money(rows.filter(keep || (() => true)).reduce((n, x) => n + cents(x[field]), 0) / 100);
  const received = Object.fromEntries(METHODS.map((m) => [m, total("Received", (x) => x.Method === m)]));
  const games = ratedGames(key);
  const uschess = prices().fees.uschess;
  return { received, entry: total("Entry fee"), rating: total("Rating fee"), card: total("Card fee"), games,
    uschess: games === null ? "" : money(Math.max(uschess.minimum, Math.round(games * uschess.game * 100) / 100)) };
}

/** Games played over the board in a tournament, which US Chess rates; null when there's no tournament. */
function ratedGames(key) {
  if (!table("Tournaments").rows.some((r) => r.Key === key)) return null;
  const played = (r) => r.Key === key && r.White && r.Black && ["1-0", "0-1", "1/2-1/2"].includes(r.Result);
  return table("Rounds").rows.filter(played).length + table("Arena").rows.filter(played).length;
}

/** The Payments tab as rows keyed by heading. */
function readPayments() {
  const { sheet, col, rows } = readTab("Payments", PAYMENT_HEADER);
  return { sheet, col, rows: rows.map((r) => Object.fromEntries(Object.entries(col).map(([h, i]) => [h, r[i]]))) };
}

/** Adds a ledger row; amounts are in cents. */
function addPayment(book, token, party, fields) {
  const row = { "No.": String(book.rows.length + 1), Recorded: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"), Token: token,
    Event: party.Event, Date: party.Date, "US Chess ID": party["US Chess ID"], Name: party.Name, Method: "", Reverses: "", Note: "" };
  for (const [h, v] of Object.entries(fields)) row[h] = typeof v === "number" ? money(v / 100) : v;
  for (const h of ["Received", "Entry fee", "Rating fee", "Card fee"]) if (row[h] === undefined) row[h] = "0";
  appendText(book.sheet, book.col, row);
  book.rows.push(row);
}

function partyOf(r, col) {
  return Object.fromEntries(["Event", "Date", "US Chess ID", "Name"].map((h) => [h, r[col[h]]]));
}

function sum(rows, field) {
  return rows.reduce((n, x) => n + cents(x[field]), 0);
}

function cents(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function active(status) {
  return status !== "withdrawn" && status !== MOVED;
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
      closed: e.tags.includes("invitational"), format: e.pairing || "", rounds: e.rounds || "",
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
  const closed = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Closed events");
  if (closed) {
    const [header, ...rows] = closed.getDataRange().getDisplayValues();
    const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
    for (const r of rows) {
      const name = r[col.Event], start = r[col.Start];
      if (!name || !start) continue;
      const key = `${name}/${start.slice(0, 10)}`;
      const extra = { closed: true, fee: r[col.Fee] === "" || r[col.Fee] === undefined ? null : Number(r[col.Fee]) };
      if (r[col.Format]) extra.format = r[col.Format];
      if (r[col.Rounds]) extra.rounds = r[col.Rounds];
      // An event on the calendar too keeps its page and dates; the tab adds the format and fee.
      out[key] = out[key] ? { ...out[key], ...extra } : {
        event: name, name: r[col.Name] || name, page: "", kind: "entry", format: "", rounds: "", ...extra,
        label: Utilities.formatDate(new Date(start), TZ, "EEEE, MMMM d, yyyy"),
        closes: start, first: start.slice(0, 10), last: start.slice(0, 10),
      };
    }
  }
  cache.put("clubEvents", JSON.stringify(out), 600);
  return out;
}

/** The website's prices.json, cached ten minutes. */
function prices() {
  const cache = CacheService.getScriptCache();
  let text = cache.get("prices");
  if (!text) {
    text = UrlFetchApp.fetch(SITE + "/prices.json").getContentText();
    cache.put("prices", text, 600);
  }
  return JSON.parse(text);
}

/** The fee: the entry fee from the prices.json row for the event and kind whose "applies" is the
 *  most specific match (the date, its month, or all), plus the round fee for each round the entry
 *  covers. null when no row applies or the rounds aren't known. */
function price(event, category) {
  const list = prices();
  let entry = event.closed ? event.fee : null;
  if (!event.closed) {
    const date = event.kind === "month" ? event.first.slice(0, 7) : event.first;
    const rank = (applies) => applies === date ? 3 : applies === date.slice(0, 7) ? 2 : applies === "all" ? 1 : 0;
    const best = (list[event.event] || [])
      .filter((r) => r.kind === event.kind && rank(r.applies))
      .sort((a, b) => rank(b.applies) - rank(a.applies))[0];
    const field = { "Adult": "adult", "Senior (65+)": "senior", "Under 18": "youth" }[category];
    entry = best && typeof best[field] === "number" ? best[field] : null;
  }
  const rating = ratingFee(event, list.fees);
  if (entry === null || entry === undefined || rating === null) return null;
  return Math.round((entry + rating) * 100) / 100;
}

/** What an entry adds for US Chess rating: the round fee for each rated round it covers (a night one, a
 *  month its nights, a tournament date its planned rounds, a quad's three), or an arena's flat fee, since
 *  no one knows ahead how many games each player will play. null when the rounds aren't known. */
function ratingFee(event, fees) {
  if (event.format === "arena" && event.kind === "entry") return fees.arena;
  let rounds = Number(event.rounds) || null;
  if (event.kind === "night") rounds = 1;
  if (event.kind === "month") {
    rounds = Object.values(clubEvents()).filter((e) => e.kind === "night" && e.event === event.event
      && e.first.startsWith(event.first.slice(0, 7))).length;
  }
  if (event.kind === "entry" && event.format === "quad") rounds = 3;
  return rounds === null ? null : fees.round * rounds;
}

/** What paying an amount by card comes to, with the processor's percentage and fixed fee, rounded up to
 *  the cent so the club never comes out short. It works in cents, since 15 * 1.025 is 15.374999… in
 *  floating point. */
function cardTotal(amount, card) {
  const cents = Math.round(amount * 100);
  return Math.ceil(cents + cents * card.percent / 100 + card.fixed * 100) / 100;
}


/** An amount as the Sheet and messages show it: 17, or 16.50. */
function money(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** The Entries tab, its columns by heading (so TDs can reorder them), and its rows. */
function readEntries() {
  return readTab("Entries", HEADER);
}

/** A tab of the registration Sheet, made when it's missing and given any missing headings. */
function readTab(name, headings) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.setFrozenRows(1);
  }
  let [header, ...rows] = sheet.getDataRange().getDisplayValues();
  header = header.map((h) => h.trim());
  const missing = headings.filter((h) => !header.includes(h));
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
 * The script keeps each answer with the day it was checked (knownPlayer), and US Chess is asked again
 * only after a year, or three months for a player under 18, so a birthday in between can leave
 * a player in the old category until then.
 */
function ageCategory(id, date) {
  const saved = knownPlayer(id);
  const daysAgo = (days) => Utilities.formatDate(new Date(Date.now() - days * 86400000), TZ, "yyyy-MM-dd");
  if (saved.Category && saved["Checked on"] > daysAgo(saved.Category === "Under 18" ? 91 : 365)) return saved.Category;

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
  rememberPlayer(id, { Category: category, "Checked on": Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"), "For the date": date });
  return category;
}

/**
 * For pairing.js's rating estimates: each player's regular-rating floor and their regular-rated
 * games before now, counted to 50 (the formula never needs more), with "wins" or "losses" if they
 * were all one; and for the rating report, the state they represent. The script keeps each for two
 * weeks (knownPlayer), so US Chess is asked again only after that, or sooner for
 * a record kept before it had the state; anyone it doesn't answer for is left blank.
 */
function priorRecords(ids) {
  const fresh = Utilities.formatDate(new Date(Date.now() - 14 * 86400000), TZ, "yyyy-MM-dd");
  const today = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  const records = {};
  const stale = [];
  for (const id of [...new Set(ids)]) {
    const saved = knownPlayer(id);
    if (saved["Record checked on"] > fresh && saved.State) {
      records[id] = { Floor: saved.Floor || "", "Prior games": saved["Prior games"] || "", "Prior sweep": saved["Prior sweep"] || "",
        State: saved.State };
    } else stale.push(id);
  }
  if (!stale.length) return records;
  const responses = UrlFetchApp.fetchAll(stale.flatMap((id) => [
    { url: `${MEMBERS}/${id}`, muteHttpExceptions: true },
    { url: `${MEMBERS}/${id}/games?RatingSource=R&Size=50`, muteHttpExceptions: true }]));
  stale.forEach((id, i) => {
    const [member, games] = responses.slice(2 * i, 2 * i + 2)
      .map((r) => (r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null));
    if (!member || !games) return;
    const regular = (member.ratings || []).find((x) => x.ratingSystem === "R") || {};
    const outcomes = [...new Set((games.items || []).map((g) => g.player && g.player.outcome))];
    records[id] = { Floor: regular.floor ? String(regular.floor) : "", "Prior games": String((games.items || []).length),
      "Prior sweep": outcomes.length === 1 ? { Win: "wins", Loss: "losses" }[outcomes[0]] || "" : "", State: member.stateRep || "" };
    rememberPlayer(id, { ...records[id], "Record checked on": today });
  });
  return records;
}

/** What the script last heard from US Chess about a player, from the script property player:<id>:
 *  Category, Checked on, and For the date from ageCategory; Floor, Prior games, Prior sweep, State,
 *  and Record checked on from priorRecords. {} for a player not heard about, or deleted to be asked again. */
function knownPlayer(id) {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty("player:" + id) || "{}");
  } catch (err) {
    return {};
  }
}

/** Adds to what's known about a player, and forgets anyone not checked in a year, whom both
 *  functions would ask about again anyway, so the properties stay within Google's limit. */
function rememberPlayer(id, fields) {
  const store = PropertiesService.getScriptProperties();
  store.setProperty("player:" + id, JSON.stringify({ ...knownPlayer(id), ...fields }));
  const yearAgo = Utilities.formatDate(new Date(Date.now() - 366 * 86400000), TZ, "yyyy-MM-dd");
  for (const [name, value] of Object.entries(store.getProperties())) {
    if (!name.startsWith("player:")) continue;
    let p = {};
    try { p = JSON.parse(value); } catch (err) {}
    if ((p["Checked on"] || "") < yearAgo && (p["Record checked on"] || "") < yearAgo) store.deleteProperty(name);
  }
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
/**
 * Checks the TD password. Apps Script can't see a visitor's IP address, so the desk sends a random ID
 * it keeps on the device, and a device that has signed in before is trusted and never locked out.
 * Every other device shares one count of wrong passwords, which limits guessing.
 */
function checkPassword(password, device) {
  const cache = CacheService.getScriptCache();
  device = /^[\w-]{16,64}$/.test(device || "") ? device : "";
  const trusted = device && trustedDevices().includes(device);
  const fails = JSON.parse(cache.get("failedLogins") || "null") || { count: 0, until: Date.now() + 3600 * 1000 };
  if (!trusted && fails.count >= FAILED_LOGINS) {
    return `Too many wrong passwords. Try again after ${Utilities.formatDate(new Date(fails.until), TZ, "h:mm a")}.`;
  }
  const expected = PropertiesService.getScriptProperties().getProperty("TD_PASSWORD");
  const digest = (s) => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s || ""));
  if (expected && String(digest(password)) === String(digest(expected))) {
    if (device && !trusted) trustDevice(device);
    return null;
  }
  if (!trusted) {
    fails.count += 1;
    cache.put("failedLogins", JSON.stringify(fails), Math.max(1, Math.ceil((fails.until - Date.now()) / 1000)));
  }
  return expected ? "Wrong password." : "The TD password isn't set up yet.";
}

/** The devices that have signed in to the TD desk, newest first, in the script property TD_DEVICES,
 *  which lasts until someone deletes it. */
function trustedDevices() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty("TD_DEVICES") || "[]");
  } catch (err) {
    return [];
  }
}

function trustDevice(device) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const list = [device, ...trustedDevices().filter((d) => d !== device)].slice(0, 100);
    PropertiesService.getScriptProperties().setProperty("TD_DEVICES", JSON.stringify(list));
  } finally {
    lock.releaseLock();
  }
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
