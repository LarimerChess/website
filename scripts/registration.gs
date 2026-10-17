/**
 * Online registration for club events: the Apps Script behind the Register form on each
 * club event's page (register.js) and the TD desk (td/). It lives in the registration
 * Sheet's Extensions → Apps Script; this file is its source. See README.md, The registration script.
 *
 * What players register for, by key "<page name>/<date>":
 *   a tournament date (2026-11-07), a club night (2026-10-12), or a club night's whole month (2026-10).
 *
 * GET  ?entries=<key>     the public entry list, as JSON
 * GET  ?entries=all       every upcoming tournament date's and club night's list, for /entries/, which also
 *                         keeps a copy in the database's public/entries
 * GET  ?tournaments=current  the tournaments in progress, with posted pairings and results, for /pairings/
 * GET  ?withdraw=<token>  a page with a button that withdraws one entry
 * POST event, date, id, last, email, phone and byes (both optional; and the trap field website)
 *                         registers a player, notes them in the Contacts tab, then emails the amount due and a withdraw link
 * POST action=toNight, event, date, id, last, email
 *                         switches a player's unpaid whole month to the one night on date
 * POST action=byes, event, date, id, last, email, byes
 *                         replaces the half-point byes a player has asked for
 * POST action=report, event, date, number, board, section, id, result
 *                         a player's report of their game's result, which the TD confirms on the desk
 * POST action=..., idToken=...  the TD desk: login, whoami, refresh, choices, createEvent, history, people, search, contacts, contactSave, contactDelete,
 *                               register, entries, remove, paid, refund, discount, toNight, byes, ledger,
 *                               incident, incidents, and for running tournaments: tournament, start,
 *                               sync, sections, section, extraSection, dropSection, timeControl, round, result, results, byeKind,
 *                               out, rounds, restart, and for arenas:
 *                               arenaJoin, arenaLeave, arenaPair, arenaResult, arenaPact, arenaCancel
 *
 * A TD signs in to the desk with Firebase Authentication (Google, or a link by email), and the
 * desk sends the account's ID token. Only verified addresses in the registration Sheet's TDs tab (Email,
 * Name, US Chess ID, Role) whose Role is td, or blank, may use the desk. A request without a token is
 * checked against the TD password instead, until every desk signs in this way.
 *
 * The Incidents tab logs TD actions under the Safe Play policy, §8. Expelled or removed from
 * the venue takes a player off that date's entries, so they aren't paired again; barred keeps
 * them from registering for any club event until the date in Until, or until the row is
 * deleted. Those three email the President, who needs a written account within two days.
 *
 * Deploy as a web app that executes as the club account, with access for anyone; its manifest,
 * with the permissions it needs, is appsscript.json. Script
 * properties (Project Settings → Script properties): FIREBASE_API_KEY, the Firebase web app's public API
 * key, which checks the desk's sign-ins; TD_PASSWORD, for a desk that sends no token; and
 * TOURNAMENT_SHEET_ID, the "Tournaments in progress" spreadsheet that running tournaments
 * keep their players, pairings, and results in until US Chess has rated them and the archive
 * Action clears them; FIREBASE_URL, when set, the Firebase Realtime Database that keeps them
 * instead, with a public copy of each tournament and the desks' change stamps, which the pages
 * listen to; and
 * USCHESS_API_KEY, the club's US Chess API key, which tells whether a player is under 18 or
 * 65 or older on the event's date. Fees for each come from the website's prices.json: the entry
 * fee, plus its round fee for each rated round (an arena, a flat rating fee), plus the card fee
 * when paid by card. Players pay when they arrive, all at once or in parts: a payment short of what's
 * due leaves the rest owed, for the TD to collect with another payment.
 *
 * A player who registers for a club night's whole month after registering for some of its nights
 * moves to the month: those nights' rows get the status "moved to month", and what was paid for
 * them, less any card fee, is credited to the month, up to its fee. The other way, a whole month
 * becomes one of its nights: the month's row gets "moved to night", and all it holds, less any
 * card fee, is credited to the night; what that leaves over the night's fee is for the TD to refund.
 *
 * A player in a Swiss can ask in advance for half-point byes (22C), when registering or later on the Entries
 * page, and the TD can set them on the desk. The Byes column holds a tournament date's rounds, "2, 4", or a
 * month's nights, "2026-10-19, 2026-10-26"; the running tournament's Players row holds them as rounds. Quads
 * and arenas take none, and a round already paired changes only under the desk's Byes and unplayed rounds.
 * Online, a tournament date takes one bye, and once round 1 is posted its last round can be neither asked for
 * nor dropped (22C4).
 *
 * The club turns no one away: a TD can give a discount, which lowers what an entry owes (the
 * Discount column, with its reason and TD in Discount note), and refund what was paid, less any
 * card fee, which the processor keeps.
 *
 * The Payments tab is the ledger, and rows are only ever added to it: each payment, each
 * correction (marking a player unpaid adds one that cancels their payments, named in Reverses),
 * and each credit (a pair: out of a night, into its month). Each row splits what changed hands
 * into the entry fee (Peak's facility donation), the rating fee (US Chess and the club's
 * margin), and the card fee (the processor's), from the fees as they stood when the row was
 * added, so a later price change never rewrites it. A payment covers the rating fee first. What a
 * player pays over the fee, the TD can make a donation to the club: the payment's Donation, kept out of
 * the entry fee and never refunded, and credited to the player by their name and US Chess ID on the row.
 * A donation apart from any entry, from a contact or anonymous, is a row of its own (giveDonation).
 *
 * Invitational club events (calendar metadata access=invitational) and events in the registration
 * Sheet's "Closed events" tab (Event, Name, Start, Format, Rounds, Fee) take registrations only from the TD
 * desk; their entries and pairings are public like any other event's. The tab can also hold an
 * event that isn't on the calendar, as the desk's New tournament adds (createEvent), and gives a calendar
 * event its format and fee.
 */

const SITE = "https://larimerchess.org";
const MEMBERS = "https://ratings-api.uschess.org/api/v1/members";
const MEMBERS_KEYED = "https://ratings-api.uschess.org/api/v2/members";
const TZ = "America/Denver";
const HEADER = ["Registered", "Event", "Date", "US Chess ID", "Name", "Category", "Amount", "Paid", "Paid on", "Regular rating",
  "Quick rating", "Membership expires", "Email", "Status", "Added by", "Token", "Phone", "Paid by", "Rating fee",
  "Discount", "Discount note", "Byes"];
const MOVED = "moved to month";
const TO_NIGHT = "moved to night";
const PAYMENT_HEADER = ["No.", "Recorded", "Token", "Event", "Date", "US Chess ID", "Name", "Type", "Method", "Received",
  "Entry fee", "Rating fee", "Card fee", "Reverses", "Note", "Donation"];
const METHODS = ["cash", "check", "card", "other"];
const CATEGORIES = ["Adult", "Senior (65+)", "Under 18"];
const INCIDENT_HEADER = ["Logged", "Event", "Date", "US Chess ID", "Name", "Action", "Round", "Reason", "TD", "Until"];
const ACTIONS = ["Warning", "Time penalty", "Game loss", "Expelled from the tournament", "Removed from the venue",
  "Barred from club events"];
const OUT_FOR_THE_DATE = ["Expelled from the tournament", "Removed from the venue"];
const ARENA_RESULTS = ["1-0", "0-1", "1/2-1/2", "1F-0F", "0F-1F", "0F-0F"];
// Tabs and headings the script adds to the tournament spreadsheet when they're missing.
const TOURNAMENT_HEADERS = {
  Tournaments: ["Key", "Event", "Name", "Format", "Rounds", "Status", "Started", "Coin", "Finished", "Cutoff", "Sections", "TD",
    "Round dates", "Time control"],
  Players: ["Key", "No.", "US Chess ID", "Name", "Rating", "Out from round", "Section", "Floor", "Prior games", "Prior sweep", "State",
    "Byes"],
  Rounds: ["Key", "Round", "Board", "White", "Black", "Result", "Bye points", "Posted", "Section", "Bye kind", "White report",
    "Black report"],
  Arena: ["Key", "Game", "White", "Black", "White pact", "Black pact", "Result", "Started", "Ended"],
};
// TD desk actions that change a tournament, refused once US Chess has rated it.
const TOURNAMENT_WRITES = ["sync", "sections", "section", "extraSection", "dropSection", "timeControl", "round", "result", "results", "byeKind", "out", "rounds", "restart", "byes",
  "arenaJoin", "arenaLeave", "arenaPair", "arenaResult", "arenaPact", "arenaCancel"];
const POSTS_PER_MINUTE = 20;
// Wrong TD passwords allowed in an hour, counted from the first, from all devices that haven't
// signed in before.
const FAILED_LOGINS = 5;
const IDENTITY_LOOKUP = "https://identitytoolkit.googleapis.com/v1/accounts:lookup";
const TD_HEADINGS = ["Email", "Name", "US Chess ID", "Role"];
// Roles in the TDs tab that may use the desk; a blank Role is "td".
const DESK_ROLES = ["td"];

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
    // The Entries page's switch and byes; the desk's carry its sign-in and come through below.
    if (p.action === "toNight" && !p.idToken && !p.password) return json(toNight(p, null));
    if (p.action === "byes" && !p.idToken && !p.password) return json(setByes(p, null));
    let td = null;
    if (p.idToken) {
      const signedIn = signedInTd(p.idToken);
      if (signedIn.error) return json(signedIn);
      td = signedIn.td;
    } else {
      const denied = checkPassword(p.password, p.device);
      if (denied) return json({ error: denied, login: true });
    }
    if (TOURNAMENT_WRITES.includes(p.action) && rated(`${p.event}/${p.date}`)) {
      return json({ error: "US Chess has rated this tournament, so it can't change on the desk." });
    }
    switch (p.action) {
      case "login": return json(td ? { ok: true, changes: changes(), td } : { ok: true, changes: changes() });
      case "whoami": return json({ td });
      case "changes": return json({ changes: changes() });
      case "refresh": return json(refreshCaches());
      case "choices": return json({ choices: choices() });
      case "createEvent": return json(createEvent(p));
      case "history": return json({ players: history(p.q) });
      case "people": return json({ players: people() });
      case "contacts": return json(contacts());
      case "donation": return json(giveDonation(p, td));
      case "contactSave": return json(saveContact(p));
      case "contactDelete": return json(deleteContact(p.id));
      case "search": return json({ players: search(p.q) });
      case "register": return json(register(p, true, td));
      case "entries": return json({ entries: entries(`${p.event}/${p.date}`, true) });
      case "remove": return json({ message: withdraw(p.token) });
      case "paid": return json(markPaid(p.token, p.amount, p.by, p.donate === "1"));
      case "refund": return json(refund(p.token, p.amount, p.by, td));
      case "discount": return json(discount(p.token, p.amount, p.note, td));
      case "toNight": return json(toNight(p, td || { name: "" }));
      case "byes": return json(setByes(p, td || { name: "" }));
      case "ledger": return json({ ledger: ledgerFor(`${p.event}/${p.date}`) });
      case "incident": return json(logIncident(p, td));
      case "incidents": return json({ incidents: incidentsFor(p.event, p.date) });
      case "tournament": return json({ tournament: tournament(`${p.event}/${p.date}`, true) });
      case "start": return json(startTournament(p, td));
      case "sync": return json(syncPlayers(`${p.event}/${p.date}`));
      case "sections": return json(setSections(p));
      case "section": return json(setSection(p));
      case "extraSection": return json(addExtraSection(p));
      case "dropSection": return json(dropExtraSection(p));
      case "timeControl": return json(setTimeControl(p));
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
 *  TD may set the category instead of taking it from US Chess. signedIn is the TD, when known. */
function register(p, td, signedIn) {
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

  const phone = phoneNumber(p.phone);
  if (phone === null) return { error: "Enter a 10-digit phone number, or leave it blank." };

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

  const lock = lockTournaments();
  let token;
  let credited = 0;
  let byes = [];
  try {
    const { sheet, col, rows } = readEntries();
    const mine = rows.filter((r) => r[col.Event] === p.event && r[col["US Chess ID"]] === id && active(r[col.Status]));
    if (mine.some((r) => r[col.Date] === p.date)) return { error: `${name} is already registered for ${event.label}.` };
    const month = mine.find((r) => r[col.Date] === p.date.slice(0, 7) && event.kind === "night");
    if (month) return { error: `${name} is already registered for the whole month.` };
    const asked = byeList(p.byes);
    const run = asked.length ? runOf(key) : null;
    const checked = run ? checkByes(asked, [], key, event, run, !td) : { list: [] };
    if (checked.error) return checked;
    byes = checked.list;
    token = Utilities.getUuid();
    const ratingDue = ratingFee(event, prices().fees);
    const row = {
      Registered: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"), Event: p.event, Date: p.date,
      "US Chess ID": id, Name: name, Category: category || "", Amount: amount === null ? "" : money(amount),
      "Regular rating": rating(member, "R"), "Quick rating": rating(member, "Q"),
      "Membership expires": member.expirationDate || "", Email: email, Status: "registered",
      "Added by": !td ? "online" : signedIn ? `TD (${signedIn.name})` : "TD", Token: token, Phone: phone,
      "Rating fee": ratingDue === null ? "" : money(ratingDue), Byes: byes.join(", "),
    };
    appendText(sheet, col, row);
    if (event.kind === "month") {
      const nights = mine.filter((r) => r[col.Date].startsWith(p.date + "-"));
      credited = moveToMonth(sheet, col, rows, nights, row, amount);
    }
    // Sync never changes a player it has added, so one already in the tournament, as from a night of the month, gets them here.
    if (run && run.info && setPlayerByes(key, id, byes, run.info)) clearTournamentCache(key);
    clearEntriesCache();
  } finally {
    lock.releaseLock();
  }

  noteContact({ name, id, email, phone, minor: category === "Under 18" });
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
  const asking = !byes.length ? "" : event.kind === "month" ? `Nights you'll miss: ${andList(byes.map(nightLabel))}.`
    : `Byes asked for: ${byesText(byes)}.`;
  // Only a device that registered online keeps the player for the Entries page.
  const change = td ? "To change them, email president@larimerchess.org."
    : `To change them, go to ${entriesLink(key, event)} on the device you registered from, or email president@larimerchess.org.`;
  if (email) {
    MailApp.sendEmail({
      to: email,
      replyTo: "president@larimerchess.org",
      name: "Larimer County Chess Club",
      subject: `Registered: ${event.name}, ${event.label}`,
      body: [
        `${name} (US Chess ID ${id}) is registered for ${event.name}, ${event.label}.`,
        asking && `${asking} ${change}`,
        due,
        lapsed && lapsed + " https://new.uschess.org/join-us-chess",
        event.page ? `Details and entries: ${SITE}${event.page}` : "",
        `Can't come? Withdraw here: ${ScriptApp.getService().getUrl()}?withdraw=${token}`,
        "Questions: president@larimerchess.org",
      ].filter(Boolean).join("\n\n"),
    });
  }
  const sent = email ? ` A confirmation is on its way to ${email}.` : "";
  return { ok: true, name, message: `${name} is registered for ${event.label}.${asking ? " " + asking : ""} ${due}${sent}${lapsed ? " " + lapsed : ""}` };
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
      const byes = byeList(r[col.Byes]);
      if (byes.length) entry.byes = byes;
      if (td) {
        const held = ledger[r[col.Token]] || { entry: 0, rating: 0, donation: 0, credit: 0, refunded: 0 };
        const credit = held.credit / 100;
        const off = cents(r[col.Discount]);
        const fee = r[col.Amount] === "" ? null : cents(r[col.Amount]) - off;
        const due = fee === null ? "" : money(Math.max(0, fee - held.credit) / 100);
        const kept = held.entry + held.rating;
        // A refund gives back what's over the fee, so it never adds to what's still owed.
        const balance = fee === null ? "" : money(Math.max(0, fee - kept - held.refunded) / 100);
        Object.assign(entry, { out, category: r[col.Category], amount: r[col.Amount], paid: r[col.Paid],
          paidOn: r[col["Paid on"]], paidBy: r[col["Paid by"]] || "", email: r[col.Email],
          credit: credit ? money(credit) : "", due, balance,
          card: balance === "" || balance === "0" ? "" : money(cardTotal(Number(balance), card)),
          expires: r[col["Membership expires"]], addedBy: r[col["Added by"]], token: r[col.Token], date: r[col.Date],
          phone: r[col.Phone], discount: off ? money(off / 100) : "", discountNote: r[col["Discount note"]] || "",
          refunded: held.refunded ? money(held.refunded / 100) : "", donation: held.donation ? money(held.donation / 100) : "", refundable: kept > 0 ? money(kept / 100) : "",
          over: fee !== null && kept > fee ? money((kept - fee) / 100) : "" });
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
  publishEntries(list);
  return list;
}

/** Copies the lists to the database's public/entries, which the Entries page reads before it hears from
 *  the script, since a call to the script takes a second or more. A copy built just before a change can
 *  land just after it; the page then corrects it from the script, whose next build here replaces it. */
function publishEntries(list) {
  if (!firebaseUrl()) return;
  try {
    firebase("PUT", "public/entries", JSON.stringify(list));
  } catch (err) {
    console.error(err);
  }
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

/** The desk's New tournament: a Closed events row for a tournament that starts now, keyed by a page-style
 *  name made from its name. A blank fee is one the TD will confirm. */
function createEvent(p) {
  const name = String(p.name || "").trim();
  const slug = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return { error: "Give the tournament a name with letters or digits." };
  if (name.length > 100) return { error: "Keep the name to 100 characters." };
  const format = ["quad", "swiss", "arena"].includes(p.format) ? p.format : null;
  if (!format) return { error: "Choose quad, Swiss, or arena." };
  const fee = String(p.fee || "").trim().replace(/^\$/, "");
  if (fee && !/^\d+(\.\d\d)?$/.test(fee)) return { error: "Enter the fee in dollars, such as 15, or leave it blank." };
  const now = new Date();
  const start = Utilities.formatDate(now, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const key = `${slug}/${start.slice(0, 10)}`;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    CacheService.getScriptCache().remove("clubEvents");
    if (clubEvents()[key]) return { error: "That name is taken today; choose another." };
    const { sheet, col } = readTab("Closed events", ["Event", "Name", "Start", "Format", "Rounds", "Fee"]);
    appendText(sheet, col, { Event: slug, Name: name, Start: start, Format: format, Fee: fee });
    CacheService.getScriptCache().remove("clubEvents");
  } finally {
    lock.releaseLock();
  }
  clearEntriesCache();
  return { ok: true, key, message: `${name} is on the desk. Register its players, then start it under Run the tournament.` };
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
  const [header, ...rows] = contactRows;
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  if (col.Name === undefined) return null;
  const byId = id && col["US Chess ID"] !== undefined && rows.filter((r) => r[col["US Chess ID"]] === id);
  if (byId && byId.length === 1) return { email: byId[0][col.Email], phone: byId[0][col.Phone] };
  const matches = rows.filter((r) => namesMatch(r[col.Name], name));
  return matches.length === 1 ? { email: matches[0][col.Email], phone: matches[0][col.Phone] } : null;
}

/** Whether a contact's name is the player's: the same last name, and the first name or a nickname in
 *  parentheses the same as the player's first. Never for a name of one word. */
function namesMatch(contact, player) {
  const words = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z\s()-]/g, "").split(/\s+/).filter(Boolean);
  const theirs = words(String(player || "").replace(/\(.*?\)/g, " "));
  const all = words(contact);
  const plain = all.filter((w) => !w.startsWith("("));
  const firsts = [plain[0], ...all.filter((w) => w.startsWith("(")).map((w) => w.replace(/[()]/g, ""))];
  return theirs.length >= 2 && plain.length >= 2 && plain.at(-1) === theirs.at(-1) && firsts.includes(theirs[0]);
}

/**
 * Keeps the Contacts tab up with a registration: the contact with the player's US Chess ID, or else
 * the one whose name matches, gets whatever it was missing (name, email, phone, ID), an email or phone
 * it didn't have goes in Other emails or Other phones, and a Contact, Sheridan list, or Prospective
 * becomes a Player. With no such contact, a nameless one with the email is taken, except for a player
 * under 18, whose email is a parent's or guardian's; with none of those, the player is added. Nothing
 * a contact already has is overwritten, and with several matches nothing changes. Registration never
 * fails over it, and a Sheet without a Contacts tab doesn't get one.
 */
function noteContact(player) {
  try {
    if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Contacts")) return;
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const { sheet, col, rows } = readTab("Contacts", CONTACT_HEADINGS);
      const live = rows.map((r, index) => ({ r, index })).filter(({ r }) => r.some(Boolean));
      const email = String(player.email || "").toLowerCase();
      const emailsOf = (r) => [r[col.Email], ...(col["Other emails"] === undefined ? [] : r[col["Other emails"]].split(/[,;]\s*/))]
        .map((e) => e.trim().toLowerCase()).filter(Boolean);
      const digits = (t) => String(t || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      const phonesOf = (r) => [r[col.Phone], ...(col["Other phones"] === undefined ? [] : r[col["Other phones"]].split(/[,;]\s*/))]
        .map(digits).filter(Boolean);
      const tries = [
        live.filter(({ r }) => r[col["US Chess ID"]] === player.id),
        live.filter(({ r }) => namesMatch(r[col.Name], player.name)),
        player.minor || !email ? [] : live.filter(({ r }) => !r[col.Name].trim() && emailsOf(r).includes(email)),
      ];
      const found = tries.find((matches) => matches.length);
      if (found && found.length > 1) {
        console.warn(`Contacts: ${found.length} contacts could be ${player.id}; none changed.`);
        return;
      }
      if (!found) {
        appendText(sheet, col, { Name: player.name, Email: player.email, Phone: player.phone, Status: "Player", "US Chess ID": player.id,
          ID: Utilities.getUuid(), Notes: `Added at registration, ${Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd")}`
            + (player.minor ? "; under 18, so the email is a parent's or guardian's" : "") + "." });
        touch("contacts");
        return;
      }
      const { r, index } = found[0];
      const changes = {};
      const fill = (heading, value) => {
        if (col[heading] !== undefined && value && !r[col[heading]].trim()) changes[heading] = value;
      };
      fill("Name", player.name);
      fill("Email", player.email);
      fill("Phone", player.phone);
      fill("US Chess ID", player.id);
      if (col.ID !== undefined && !r[col.ID].trim()) changes.ID = Utilities.getUuid();
      const add = (heading, value) => {
        if (col[heading] !== undefined) changes[heading] = [r[col[heading]].trim(), value].filter(Boolean).join(", ");
      };
      if (email && !changes.Email && !emailsOf(r).includes(email)) add("Other emails", player.email);
      if (player.phone && !changes.Phone && !phonesOf(r).includes(digits(player.phone))) add("Other phones", player.phone);
      if (col.Status !== undefined && ["", "Contact", "Sheridan list", "Prospective"].includes(r[col.Status].trim())) changes.Status = "Player";
      for (const [heading, value] of Object.entries(changes)) {
        sheet.getRange(index + 2, col[heading] + 1).setNumberFormat("@").setValue(value);
      }
      if (Object.keys(changes).length) touch("contacts");
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
  }
}

/** A phone number as the Contacts tab writes them, 970-555-0123: "" for none, null for one that
 *  isn't ten digits (after a leading 1). */
function phoneNumber(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return /^\d{10}$/.test(digits) && !/[^\d\s().+-]/.test(raw) ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : null;
}

// Headings the desk's Contacts section needs; the tab's others are its own, and the desk shows them all.
const CONTACT_HEADINGS = ["Name", "Email", "Phone", "US Chess ID", "ID"];

/** The Contacts tab for the desk's Contacts section: its headings but ID, and each contact with what
 *  they have donated, by their ID or their US Chess ID; and what was donated anonymously. A contact
 *  added in the Sheet by hand gets its ID here. */
function contacts() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { sheet, col, rows } = readTab("Contacts", CONTACT_HEADINGS);
    const headings = Object.keys(col).filter((h) => h && h !== "ID");
    const gifts = readPayments().rows.filter((x) => cents(x.Donation));
    const given = (keep) => money(gifts.filter(keep).reduce((n, x) => n + cents(x.Donation), 0) / 100);
    const list = [];
    rows.forEach((r, i) => {
      if (!r.some(Boolean)) return;
      if (!r[col.ID]) {
        r[col.ID] = Utilities.getUuid();
        sheet.getRange(i + 2, col.ID + 1).setNumberFormat("@").setValue(r[col.ID]);
      }
      const id = r[col.ID], uschess = r[col["US Chess ID"]];
      list.push({ id, ...Object.fromEntries(headings.map((h) => [h, r[col[h]]])),
        donated: given((x) => x.Token === id || (uschess && x["US Chess ID"] === uschess)) });
    });
    return { headings, contacts: list, anonymous: given((x) => x.Type === "donation" && !x.Token) };
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
<? } else if (row.status === toNight) { ?><p><?= row.name ?> switched to one night. To withdraw, use the link in that night's confirmation email.</p>
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
  page.toNight = TO_NIGHT;
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
    if (row.status === TO_NIGHT) return `${row.name} switched to one night; withdraw from the night instead.`;
    const { sheet, col } = readEntries();
    sheet.getRange(row.index + 2, col.Status + 1).setValue("withdrawn");
    clearEntriesCache();
    return `${row.name} is withdrawn.`;
  } finally {
    lock.releaseLock();
  }
}

/** Logs a TD action from the desk. Taking a player off a date needs that date, not a whole month.
 *  The TD named is the one the desk sends, or else the TD signed in. */
function logIncident(p, signedIn) {
  const key = `${p.event}/${p.date}`;
  const event = clubEvents()[key];
  if (!event) return { error: "That event isn't open." };
  if (!ACTIONS.includes(p.action_taken)) return { error: "Choose what happened." };
  if (event.kind === "month" && p.action_taken !== "Barred from club events") {
    return { error: "Choose the night it happened, not the whole month." };
  }
  const reason = String(p.reason || "").trim();
  const tdName = String(p.td || "").trim() || (signedIn ? signedIn.name : "");
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

/** A tab of running tournaments as rows keyed by heading, each with its row: a sheet row number, or
 *  the database's row ID. */
function table(name) {
  if (firebaseUrl()) return databaseTable(name);
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
  return { name, sheet, col, rows: rows.map((r, i) => ({ ...Object.fromEntries(header.map((h, j) => [h.trim(), r[j] || ""])), row: i + 2 })) };
}

function setCell(t, row, heading, value) {
  setCells(t, { [row]: { [heading]: value } });
}

/** Changes cells of several rows, { row: { heading: value } }; the database takes them in one write. */
function setCells(t, changes) {
  if (t.sheet) {
    for (const [row, fields] of Object.entries(changes)) {
      for (const [heading, value] of Object.entries(fields)) {
        t.sheet.getRange(Number(row), t.col[heading] + 1).setNumberFormat("@").setValue(value);
      }
    }
    return;
  }
  const paths = {};
  for (const [row, fields] of Object.entries(changes)) {
    for (const [heading, value] of Object.entries(encodeFields(fields))) paths[`${row}/${heading}`] = value;
  }
  if (!Object.keys(paths).length) return;
  firebase("PATCH", `tables/${t.name}`, paths);
  for (const [row, fields] of Object.entries(changes)) Object.assign(databaseTables()[t.name][row], fields);
}

/** Adds rows, objects by heading; headings the tab lacks are left out. */
function addRows(t, list) {
  if (t.sheet) {
    for (const fields of list) appendText(t.sheet, t.col, fields);
    return;
  }
  if (!list.length) return;
  const added = Object.fromEntries(list.map((fields) => [newRowId(),
    Object.fromEntries(Object.keys(t.col).map((h) => [h, fields[h] === undefined ? "" : String(fields[h])]))]));
  firebase("PATCH", `tables/${t.name}`, Object.fromEntries(Object.entries(added).map(([id, r]) => [id, encodeFields(r)])));
  const stored = databaseTables();
  stored[t.name] = { ...stored[t.name], ...added };
}

/** Deletes rows from table(t.name). */
function deleteRows(t, rows) {
  if (t.sheet) {
    for (const r of rows.slice().sort((a, b) => b.row - a.row)) t.sheet.deleteRow(r.row);
    return;
  }
  if (!rows.length) return;
  firebase("PATCH", `tables/${t.name}`, Object.fromEntries(rows.map((r) => [r.row, null])));
  for (const r of rows) delete databaseTables()[t.name][r.row];
}

// The database (FIREBASE_URL) keeps the tables' rows at /tables/{tab}/{row ID}, read once and then kept
// here, and the arena queues at /queues. Its keys can't hold . $ # [ ] /, so a tournament key's slash
// is a colon in a node name, and headings such as No. are stored percent-encoded.
let firebaseBase = null;
let databaseCopy = null;
let databaseQueues = null;
let rowsAdded = 0;

function firebaseUrl() {
  if (firebaseBase === null) {
    firebaseBase = (PropertiesService.getScriptProperties().getProperty("FIREBASE_URL") || "").trim().replace(/\/+$/, "");
  }
  return firebaseBase;
}

/** Calls the database's REST API at a path ("" for the root) as the account the script runs as. */
function firebase(method, path, body, query) {
  const options = { method: method.toLowerCase(), headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true };
  if (body !== undefined) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(body);
  }
  const response = UrlFetchApp.fetch(`${firebaseUrl()}/${path}.json${query ? "?" + query : ""}`, options);
  if (response.getResponseCode() !== 200) {
    throw new Error(`Firebase ${method} /${path}: ${response.getResponseCode()} ${response.getContentText().slice(0, 200)}`);
  }
  return JSON.parse(response.getContentText());
}

/** Takes the script lock for a tournament change. The database is read again under it, since another
 *  execution may have changed it while this one waited. */
function lockTournaments() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  databaseCopy = null;
  databaseQueues = null;
  return lock;
}

function databaseTables() {
  if (!databaseCopy) {
    const stored = firebase("GET", "tables") || {};
    databaseCopy = Object.fromEntries(Object.entries(stored).map(([name, rows]) => [name,
      Object.fromEntries(Object.entries(rows || {}).map(([id, r]) => [id,
        Object.fromEntries(Object.entries(r || {}).map(([h, v]) => [decodeField(h), String(v)]))]))]));
  }
  return databaseCopy;
}

function databaseTable(name) {
  const stored = databaseTables()[name] || {};
  const header = [...TOURNAMENT_HEADERS[name]];
  for (const r of Object.values(stored)) for (const h of Object.keys(r)) if (!header.includes(h)) header.push(h);
  return { name, col: Object.fromEntries(header.map((h, i) => [h, i])),
    rows: Object.keys(stored).sort().map((id) => ({ ...Object.fromEntries(header.map((h) => [h, stored[id][h] || ""])), row: id })) };
}

/** A row ID that sorts after the migrated rows' r000002 and the rows added before it. */
function newRowId() {
  return "s" + Date.now().toString(36).padStart(8, "0") + (rowsAdded++).toString(36).padStart(3, "0");
}

function encodeFields(fields) {
  const encode = (h) => h.replace(/[.$#[\]/%]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return Object.fromEntries(Object.entries(fields).map(([h, v]) => [encode(h), v]));
}

function decodeField(h) {
  return h.replace(/%(2E|24|23|5B|5D|2F|25)/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const nodeOf = (key) => key.replace(/\//g, ":");
const keyOf = (node) => node.replace(/:/g, "/");

/** Everything about a tournament, in pairing.js's shape. Without td, only posted rounds. */
function tournament(key, td) {
  const info = table("Tournaments").rows.find((r) => r.Key === key);
  if (!info) return null;
  const players = table("Players").rows.filter((r) => r.Key === key)
    .sort((a, b) => Number(a["No."]) - Number(b["No."]))
    .map((r) => {
      const player = { id: r["US Chess ID"], number: Number(r["No."]), name: r.Name,
        rating: /^\d+/.test(r.Rating) ? parseInt(r.Rating) : null, out: r["Out from round"] ? Number(r["Out from round"]) : null,
        section: r.Section || "", floor: /^\d+$/.test(r.Floor) ? Number(r.Floor) : null,
        games: /^\d+$/.test(r["Prior games"]) ? Number(r["Prior games"]) : null, sweep: r["Prior sweep"] || "",
        state: r.State || "" };
      const byes = byeRounds(byeList(r.Byes), info);
      if (byes.length) player.byes = byes;
      return player;
    });
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
    td: info.TD || "", timeControl: info["Time control"] || "" };
  const dates = roundDates(info);
  if (dates.length) result.roundDates = dates;
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

function startTournament(p, signedIn) {
  const key = `${p.event}/${p.date}`;
  const event = clubEvents()[key];
  if (!event) return { error: "That event isn't open." };
  if (event.kind === "night") return { error: "A club night's Swiss runs for the month; choose the month." };
  const lock = lockTournaments();
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
    addRows(t, [{ Key: key, Event: event.event, Name: `${event.name}, ${event.label}`, Format: format,
      Rounds: rounds, Status: "running", Started: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"),
      Coin: p.coin === "black" ? "black" : "white", Finished: "", Cutoff: cutoff,
      Sections: defined.sections.length ? JSON.stringify(defined.sections) : "", TD: [p.td, signedIn && signedIn.usChessId].find((id) => /^\d{8}$/.test(id || "")) || "",
      "Round dates": event.kind === "month" ? JSON.stringify(monthNights(key)) : "",
      "Time control": String(p.timeControl || "").trim().slice(0, 40) }]);
  } finally {
    lock.releaseLock();
  }
  const synced = syncPlayers(key);
  if (p.format === "quad") numberQuads(key);
  return synced;
}

/** Changes how many rounds a Swiss plays: more, or as few as are paired, to stop early. Once it has an
 *  extra rated games section, every section has its own rounds, and p.section names the one to change;
 *  a quad's extra games sections change too, but its quads play three rounds. */
function setRounds(p) {
  const key = `${p.event}/${p.date}`;
  const rounds = String(p.rounds || "").trim();
  if (!/^[1-9]\d?$/.test(rounds)) return { error: "Rounds is a number from 1 to 99." };
  const lock = lockTournaments();
  try {
    const t = table("Tournaments");
    const line = t.rows.find((r) => r.Key === key);
    if (!line) return { error: "No such tournament." };
    const defs = sectionsOf(line);
    const extras = defs.some((s) => s.extra);
    if (line.Format !== "swiss" && !(line.Format === "quad" && extras)) return { error: "Only a Swiss can change its number of rounds." };
    const lines = table("Rounds").rows.filter((r) => r.Key === key);
    if (extras) {
      const def = defs.find((s) => s.name === p.section);
      if (!def) return { error: "Which section's rounds?" };
      if (line.Format === "quad" && !def.extra) return { error: "A quad plays three rounds (30G)." };
      const first = Number(def.first) || 1;
      const paired = lines.filter((r) => r.Section === def.name).reduce((m, r) => Math.max(m, Number(r.Round) - first + 1), 0);
      if (Number(rounds) < paired) return { error: `${def.name} has ${paired} rounds paired already, so it can't have fewer.` };
      def.last = first + Number(rounds) - 1;
      setCells(t, { [line.row]: { Sections: JSON.stringify(defs), Rounds: String(lastRound(defs)) } });
      clearTournamentCache(key);
      return { ok: true, message: `${def.name} plays ${rounds} ${rounds === "1" ? "round" : "rounds"}.` };
    }
    const paired = lines.reduce((m, r) => Math.max(m, Number(r.Round)), 0);
    if (Number(rounds) < paired) return { error: `${paired} rounds are paired already, so it can't have fewer.` };
    setCell(t, line.row, "Rounds", rounds);
    clearTournamentCache(key);
    return { ok: true, message: `It plays ${rounds} rounds.` };
  } finally {
    lock.releaseLock();
  }
}

const lastRound = (defs) => defs.reduce((m, s) => Math.max(m, Number(s.last) || 0), 0);

/**
 * Adds an extra rated games section (28M4) to a Swiss or quads, paired as a Swiss: p.players, a JSON list of its players' IDs, play
 * p.rounds rounds in it from the next round, apart from their own section's standings and alongside any
 * rounds it has left, and the rating report has it as a section of its own. The other sections keep the
 * rounds they had, as their last.
 */
function addExtraSection(p) {
  const key = `${p.event}/${p.date}`;
  const name = String(p.name || "").trim().replace(/\s+/g, " ");
  const rounds = String(p.rounds || "").trim();
  let ids;
  try {
    ids = JSON.parse(p.players || "[]");
  } catch (err) {
    ids = null;
  }
  // US Chess's rating report keeps 30 characters of a section's name.
  if (!name || name.length > 30) return { error: "Name the section, in up to 30 characters." };
  if (!/^[1-9]\d?$/.test(rounds)) return { error: "Rounds is a number from 1 to 99." };
  if (!Array.isArray(ids)) return { error: "Choose the section's players." };
  const lock = lockTournaments();
  try {
    const t = table("Tournaments");
    const line = t.rows.find((r) => r.Key === key);
    if (!line) return { error: "No such tournament." };
    if (!["swiss", "quad"].includes(line.Format)) return { error: "Only a Swiss or quads can add an extra games section." };
    const defs = sectionsOf(line);
    if (!defs.length) return { error: "This tournament started before sections, so it can't add one." };
    if (defs.some((s) => s.name.toLowerCase() === name.toLowerCase())) return { error: `There's already a section named ${name}.` };
    const have = new Set(table("Players").rows.filter((r) => r.Key === key).map((r) => r["US Chess ID"]));
    const players = [...new Set(ids.map(String))].filter((id) => have.has(id));
    if (players.length < 2) return { error: "Choose at least two of the tournament's players." };
    const paired = table("Rounds").rows.filter((r) => r.Key === key).reduce((m, r) => Math.max(m, Number(r.Round)), 0);
    const planned = Math.max(Number(line.Rounds) || 0, paired);
    for (const s of defs) if (!s.last) s.last = planned;
    const first = paired + 1;
    defs.push({ name, extra: true, first, last: first + Number(rounds) - 1, players });
    setCells(t, { [line.row]: { Sections: JSON.stringify(defs), Rounds: String(lastRound(defs)) } });
    clearTournamentCache(key);
    return { ok: true, message: `${name}: ${players.length} players, ${rounds} ${rounds === "1" ? "round" : "rounds"} from round ${first}.` };
  } finally {
    lock.releaseLock();
  }
}

/** Sets the time control the rating report gives, p.value: the tournament's, or with p.section that
 *  section's own, where it differs (rule 5C, TD tip, note 2); an empty one goes back to the tournament's. */
function setTimeControl(p) {
  const key = `${p.event}/${p.date}`;
  // S_TIMECTL holds 40 characters.
  const value = String(p.value || "").trim().replace(/\s+/g, " ");
  if (value.length > 40) return { error: "A time control fits in 40 characters, such as G/30;+30." };
  const lock = lockTournaments();
  try {
    const t = table("Tournaments");
    const line = t.rows.find((r) => r.Key === key);
    if (!line) return { error: "No such tournament." };
    if (!p.section) {
      setCell(t, line.row, "Time control", value);
    } else {
      const defs = sectionsOf(line);
      const def = defs.find((s) => s.name === p.section);
      if (!def) return { error: "No such section." };
      if (value) def.timeControl = value;
      else delete def.timeControl;
      setCell(t, line.row, "Sections", JSON.stringify(defs));
    }
    clearTournamentCache(key);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Takes off an extra rated games section added by mistake, with any of its rounds saved but not posted. */
function dropExtraSection(p) {
  const key = `${p.event}/${p.date}`;
  const lock = lockTournaments();
  try {
    const t = table("Tournaments");
    const line = t.rows.find((r) => r.Key === key);
    if (!line) return { error: "No such tournament." };
    const defs = sectionsOf(line);
    const def = defs.find((s) => s.extra && s.name === p.section);
    if (!def) return { error: "No such extra games section." };
    const rows = table("Rounds");
    const mine = rows.rows.filter((r) => r.Key === key && r.Section === def.name);
    if (mine.some((r) => r.Posted)) return { error: `${def.name} has posted pairings, so it stays; lower its rounds to stop it.` };
    deleteRows(rows, mine);
    const kept = defs.filter((s) => s !== def);
    // Without an extra section, the others play through the tournament's rounds again.
    if (!kept.some((s) => s.extra)) for (const s of kept) delete s.last;
    const paired = table("Rounds").rows.filter((r) => r.Key === key).reduce((m, r) => Math.max(m, Number(r.Round)), 0);
    setCells(t, { [line.row]: { Sections: JSON.stringify(kept), Rounds: String(Math.max(lastRound(kept), paired)) } });
    clearTournamentCache(key);
    return { ok: true, message: `${def.name} is taken off.` };
  } finally {
    lock.releaseLock();
  }
}

/** Deletes everything the tournament spreadsheet or database has for a tournament, so it can be
 *  started again. Its entries stay in the registration Sheet. */
function restartTournament(key) {
  const lock = lockTournaments();
  try {
    if (!table("Tournaments").rows.some((r) => r.Key === key)) return { error: "No such tournament." };
    for (const name of Object.keys(TOURNAMENT_HEADERS)) {
      const t = table(name);
      deleteRows(t, t.rows.filter((x) => x.Key === key));
    }
    setQueue(key, []);
    clearTournamentCache(key);
    return { ok: true, message: "Deleted. Start it again when ready." };
  } finally {
    lock.releaseLock();
  }
}

/** 30G and 30A: quads are groups of four by rating, and within each the table numbers are drawn by
 *  lot. Each quad is a section; numbers 5 to 8 are still the second quad's. */
function numberQuads(key) {
  const lock = lockTournaments();
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
      setCells(t, Object.fromEntries(group.map((r, i) => [r.row, { "No.": String(numbers[i]), Section: name }])));
    }
    const info = table("Tournaments");
    const line = info.rows.find((r) => r.Key === key);
    if (line && quads.length) setCell(info, line.row, "Sections", JSON.stringify(quads));
    clearTournamentCache(key);
  } finally {
    lock.releaseLock();
  }
}

/** Adds registered entrants who aren't players yet, numbered after the others (28B), each in the
 *  section their rating puts them in, and in a Swiss with the byes they asked for. */
function syncPlayers(key) {
  const lock = lockTournaments();
  try {
    const info = table("Tournaments").rows.find((r) => r.Key === key);
    const defs = info && info.Format !== "quad" ? sectionsOf(info).filter((s) => !s.extra) : [];
    const swiss = info && !["quad", "arena"].includes(info.Format);
    const t = table("Players");
    const have = new Set(t.rows.filter((r) => r.Key === key).map((r) => r["US Chess ID"]));
    let number = t.rows.filter((r) => r.Key === key).reduce((m, r) => Math.max(m, Number(r["No."]) || 0), 0);
    // A month's entrants include each night's; entries() already leaves out the expelled and barred.
    const entrants = entries(key, true).filter((e) => !e.out && !have.has(e.id));
    entrants.sort((a, b) => (parseInt(b.rating) || 0) - (parseInt(a.rating) || 0));
    // Players added before the records were kept get them now.
    const unrecorded = t.rows.filter((r) => r.Key === key && (r["Prior games"] === "" || !r.State));
    const records = priorRecords([...entrants.map((e) => e.id), ...unrecorded.map((r) => r["US Chess ID"])]);
    const added = [];
    for (const e of entrants) {
      if (have.has(e.id)) continue;
      have.add(e.id);
      added.push({ Key: key, "No.": String(++number), "US Chess ID": e.id, Name: e.name,
        Rating: e.rating || "", "Out from round": "", Section: defs.length ? placeIn(defs, e.rating) : "",
        Byes: swiss ? byeRounds(e.byes || [], info).join(", ") : "", ...records[e.id] });
    }
    addRows(t, added);
    setCells(t, Object.fromEntries(unrecorded.filter((r) => records[r["US Chess ID"]]).map((r) => [r.row, records[r["US Chess ID"]]])));
    clearTournamentCache(key);
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
 *  as a half-point bye; the points follow the kind. p.section, when sent, names the section's row. */
function saveByeKind(p) {
  if (BYE_KINDS[p.kind] === undefined) return { error: "Not a kind of bye." };
  const key = `${p.event}/${p.date}`;
  const lock = lockTournaments();
  try {
    const t = table("Rounds");
    const here = t.rows.filter((r) => r.Key === key && Number(r.Round) === Number(p.number)
      && (p.section === undefined || r.Section === p.section));
    const line = here.find((r) => r.White === p.id && !r.Black);
    if (!line) {
      // A round with no row for the player, such as one a late entrant missed (28K), gets one.
      if (!here.length) return { error: "That round isn't paired yet." };
      if (here.some((r) => r.White === p.id || r.Black === p.id)) return { error: "That player has a game that round, not a bye." };
      if (!table("Players").rows.some((r) => r.Key === key && r["US Chess ID"] === p.id)) return { error: "Not a player in this tournament." };
      addRows(t, [{ Key: key, Round: String(p.number), Board: "", White: p.id, Black: "", Result: "", "Bye points": String(BYE_KINDS[p.kind]),
        Posted: (here.find((r) => r.Posted) || { Posted: "" }).Posted, Section: String(p.section || ""), "Bye kind": p.kind }]);
      clearTournamentCache(key);
      return { ok: true };
    }
    setCells(t, { [line.row]: { "Bye kind": p.kind, "Bye points": String(BYE_KINDS[p.kind]) } });
    clearTournamentCache(key);
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
  const lock = lockTournaments();
  try {
    const t = table("Rounds");
    const old = t.rows.filter((r) => r.Key === key && Number(r.Round) === round);
    // A saved round can hold forfeits for quad players not here; only a posted round's results block re-pairing.
    if (old.some((r) => r.Result && r.Posted)) return { error: "This round has results; clear them before re-pairing (29G)." };
    deleteRows(t, old);
    const posted = p.post === "yes" ? Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm") : "";
    addRows(table("Rounds"), [
      ...games.map((g) => ({ Key: key, Round: String(round), Board: String(g.board), White: g.white,
        Black: g.black, Result: FORFEITS.includes(g.result) ? g.result : "", "Bye points": "", Posted: posted,
        Section: String(g.section || "") })),
      ...byes.map((b) => ({ Key: key, Round: String(round), Board: "", White: b.id, Black: "",
        Result: "", "Bye points": String(b.points), Posted: posted, Section: String(b.section || ""),
        "Bye kind": BYE_KINDS[b.kind] !== undefined ? b.kind : "" })),
    ]);
    clearTournamentCache(key);
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
  const lock = lockTournaments();
  try {
    const t = table("Rounds");
    const lines = list.map((x) => boardLine(t, key, p.number, x.board, x.section));
    if (lines.some((line) => !line)) return { error: "No such board." };
    setCells(t, Object.fromEntries(lines.map((line, i) => [line.row, { Result: list[i].result }])));
    clearTournamentCache(key);
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
  const lock = lockTournaments();
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
    clearTournamentCache(key);
    return { ok: true, message: `Board ${line.Board}: ${REPORTS[p.result]} is reported. The TD will confirm it.` };
  } finally {
    lock.releaseLock();
  }
}

/** Withdraws or expels a player from a round on (28P), or brings them back with an empty round. */
function setOut(p) {
  const key = `${p.event}/${p.date}`;
  const lock = lockTournaments();
  try {
    const t = table("Players");
    const line = t.rows.find((r) => r.Key === key && r["US Chess ID"] === p.id);
    if (!line) return { error: "Not a player in this tournament." };
    setCell(t, line.row, "Out from round", String(p.from || ""));
    clearTournamentCache(key);
    return { ok: true, message: p.from ? `${line.Name} is out from round ${p.from}.` : `${line.Name} is back in.` };
  } finally {
    lock.releaseLock();
  }
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
  deleteRows(t, mine);
  return "";
}

/** Sets a Swiss's sections and puts every player in the one their rating gives, before round 1. */
function setSections(p) {
  const key = `${p.event}/${p.date}`;
  const parsed = parseSections(p.sections);
  if (parsed.error) return parsed;
  const lock = lockTournaments();
  try {
    const info = table("Tournaments");
    const line = info.rows.find((r) => r.Key === key);
    if (!line) return { error: "No such tournament." };
    if (line.Format !== "swiss") return { error: "Only a Swiss has sections to set; quads are grouped when they start." };
    const extras = sectionsOf(line).filter((s) => s.extra);
    const taken = extras.find((x) => parsed.sections.some((s) => s.name.toLowerCase() === x.name.toLowerCase()));
    if (taken) return { error: `${taken.name} is an extra games section already.` };
    const last = (sectionsOf(line).find((s) => !s.extra && s.last) || {}).last;
    if (extras.length && last) for (const s of parsed.sections) s.last = last;
    const late = beforeRoundOne(key);
    if (late) return { error: late };
    setCell(info, line.row, "Sections", JSON.stringify([...parsed.sections, ...extras]));
    const t = table("Players");
    setCells(t, Object.fromEntries(t.rows.filter((x) => x.Key === key).map((r) => [r.row, { Section: placeIn(parsed.sections, r.Rating) }])));
    clearTournamentCache(key);
    return { ok: true, message: `Sections: ${parsed.sections.map((s) => s.name).join(", ")}. Everyone is placed by rating.` };
  } finally {
    lock.releaseLock();
  }
}

/** Moves a player to another section before round 1. A player may play up, never down. */
function setSection(p) {
  const key = `${p.event}/${p.date}`;
  const lock = lockTournaments();
  try {
    const info = table("Tournaments").rows.find((r) => r.Key === key);
    if (!info) return { error: "No such tournament." };
    if (info.Format !== "swiss") return { error: "Quads are grouped by rating when they start." };
    const def = sectionsOf(info).find((s) => s.name === p.section && !s.extra);
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
    clearTournamentCache(key);
    return { ok: true, message: `${line.Name} plays in ${def.name}.` };
  } finally {
    lock.releaseLock();
  }
}

/** Each running tournament's players' sections, { key: { id: section } }, where it has more than one section. */
function sectionsByKey() {
  try {
    const several = new Set(table("Tournaments").rows.filter((r) => sectionsOf(r).filter((s) => !s.extra).length > 1).map((r) => r.Key));
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
  const lock = lockTournaments();
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
    clearTournamentCache(key);
    return { ok: true, message: `${player.Name} is waiting for a game.` };
  } finally {
    lock.releaseLock();
  }
}

function arenaLeave(p) {
  const key = `${p.event}/${p.date}`;
  const lock = lockTournaments();
  try {
    setQueue(key, (queues()[key] || []).filter((q) => q.id !== p.id));
    clearTournamentCache(key);
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
  const lock = lockTournaments();
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
    const added = [];
    for (const g of games) {
      if (g.white === g.black || !waiting.has(g.white) || !waiting.has(g.black)) continue;
      waiting.delete(g.white);
      waiting.delete(g.black);
      added.push({ Key: key, Game: String(++number), White: g.white, Black: g.black,
        "White pact": "", "Black pact": "", Result: "", Started: stamp(), Ended: "" });
      started.push(g.white, g.black);
    }
    addRows(arena, added);
    setQueue(key, queue.filter((q) => !started.includes(q.id)));
    clearTournamentCache(key);
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
  const lock = lockTournaments();
  try {
    const arena = table("Arena");
    const line = arena.rows.find((r) => r.Key === key && Number(r.Game) === Number(p.game));
    if (!line) return { error: "No such game." };
    if (line.Result) {
      setCell(arena, line.row, "Result", p.result);
      clearTournamentCache(key);
      return { ok: true, message: `Game ${p.game} is corrected.` };
    }
    setCells(arena, { [line.row]: { Result: p.result, Ended: stamp() } });
    const back = [];
    if (!/^0F/.test(p.result)) back.push(line.White);
    if (!/0F$/.test(p.result)) back.push(line.Black);
    setQueue(key, [...(queues()[key] || []), ...back.map((id) => ({ id, since: stamp() }))]);
    clearTournamentCache(key);
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
  const lock = lockTournaments();
  try {
    const arena = table("Arena");
    const line = arena.rows.find((r) => r.Key === key && Number(r.Game) === Number(p.game));
    if (!line) return { error: "No such game." };
    setCell(arena, line.row, heading, p.on === "yes" ? "yes" : "");
    clearTournamentCache(key);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Takes back a pairing made by mistake, before it has a result; both players wait again. */
function arenaCancel(p) {
  const key = `${p.event}/${p.date}`;
  const lock = lockTournaments();
  try {
    const arena = table("Arena");
    const line = arena.rows.find((r) => r.Key === key && Number(r.Game) === Number(p.game));
    if (!line) return { error: "No such game." };
    if (line.Result) return { error: "That game has a result." };
    deleteRows(arena, [line]);
    setQueue(key, [...(queues()[key] || []), ...[line.White, line.Black].map((id) => ({ id, since: stamp() }))]);
    clearTournamentCache(key);
    return { ok: true, message: `Game ${p.game} is taken back.` };
  } finally {
    lock.releaseLock();
  }
}

/** Each running arena's waiting players, [{ id, since }] by tournament key, from the script property
 *  arenaQueues, or the database's /queues: the script alone uses them, and only while the arena runs. */
function queues() {
  if (firebaseUrl()) {
    if (!databaseQueues) {
      const stored = firebase("GET", "queues") || {};
      databaseQueues = {};
      for (const [node, text] of Object.entries(stored)) {
        try {
          databaseQueues[keyOf(node)] = JSON.parse(text);
        } catch (err) {
          console.error(`queue ${node}: ${err}`);
        }
      }
    }
    return { ...databaseQueues };
  }
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty("arenaQueues") || "{}");
  } catch (err) {
    return {};
  }
}

/** Sets one arena's queue, and drops any tournament's no longer running. Callers hold the script lock. */
function setQueue(key, list) {
  const all = queues();
  const running = new Set(table("Tournaments").rows.map((r) => r.Key));
  const dropped = Object.keys(all).filter((k) => k === key || !running.has(k));
  for (const k of dropped) delete all[k];
  if (list.length && running.has(key)) all[key] = list;
  if (!firebaseUrl()) {
    PropertiesService.getScriptProperties().setProperty("arenaQueues", JSON.stringify(all));
    return;
  }
  const changes = Object.fromEntries(dropped.map((k) => [nodeOf(k), null]));
  if (all[key]) changes[nodeOf(key)] = JSON.stringify(all[key]);
  if (Object.keys(changes).length) firebase("PATCH", "queues", changes);
  databaseQueues = all;
}

/** Every running tournament, with only posted rounds, for the public Pairings page. */
function currentTournaments() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("tournaments");
  if (cached) return JSON.parse(cached);
  const list = table("Tournaments").rows.map((r) => tournament(r.Key, false)).filter(Boolean);
  cachePut("tournaments", JSON.stringify(list));
  return list;
}

/** After a change to the tournament with the key: clears the Pairings and Standings pages' copy, and the
 *  entry lists, which show each player's section, and rewrites the database's public copy. */
function clearTournamentCache(key) {
  CacheService.getScriptCache().removeAll(["tournaments", "entriesVersion"]);
  stampChanges(["tournaments"], firebaseUrl() ? publicCopies([key]) : {});
}

/** The database's public copies of tournaments, { path: JSON or null for one that's gone }, for stampChanges. */
function publicCopies(keys) {
  return Object.fromEntries(keys.map((key) => {
    const shown = tournament(key, false);
    return [`public/tournaments/${nodeOf(key)}`, shown ? JSON.stringify(shown) : null];
  }));
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
  // Rebuilt now, not at the next visit, so the database's copy has the change.
  if (!firebaseUrl()) return;
  try {
    allEntries();
  } catch (err) {
    console.error(err);
  }
}

// The TD desk asks for these every few seconds and reloads whatever has a new stamp, so a change made
// on another desk or on the website shows without a reload. A stamp the cache has dropped reads as
// "", which costs the desks one reload.
const CHANGE_SCOPES = ["entries", "tournaments", "contacts"];

function touch(...scopes) {
  stampChanges(scopes, {});
}

/** New stamps for the scopes. With the database, one write sets them at /changes, which the desks
 *  listen to, along with updates, { path: value }. */
function stampChanges(scopes, updates) {
  const stamp = Math.random().toString(36).slice(2, 10);
  CacheService.getScriptCache().putAll(Object.fromEntries(scopes.map((s) => [`changed:${s}`, stamp])), PUBLIC_CACHE);
  if (!firebaseUrl()) return;
  // What changed is saved by now; a database that's down mustn't turn a registration or result into an error.
  // The desks then catch up by polling, and Refresh rewrites the public copies.
  try {
    firebase("PATCH", "", { ...updates, ...Object.fromEntries(scopes.map((s) => [`changes/${s}`, stamp])) });
  } catch (err) {
    console.error(err);
  }
}

function changes() {
  const stamps = CacheService.getScriptCache().getAll(CHANGE_SCOPES.map((s) => `changed:${s}`));
  return Object.fromEntries(CHANGE_SCOPES.map((s) => [s, stamps[`changed:${s}`] || ""]));
}

/** The TD desk's Refresh: clears every copy the public pages and the script keep, and builds the
 *  public pages' copies again from the Sheets, or the database's public copies from its tables. */
function refreshCaches() {
  CacheService.getScriptCache().removeAll(["clubEvents", "prices", "rated", "tournaments", "entriesVersion", "tds"]);
  let copies = {};
  if (firebaseUrl()) {
    const listed = Object.keys(firebase("GET", "public/tournaments", undefined, "shallow=true") || {}).map(keyOf);
    copies = publicCopies([...new Set([...listed, ...table("Tournaments").rows.map((r) => r.Key)])]);
  }
  stampChanges(CHANGE_SCOPES, copies);
  const lists = allEntries().length;
  const months = Object.entries(clubEvents()).filter(([, e]) => e.kind === "month");
  for (const [key] of months) entries(key, false);
  const tournaments = currentTournaments().length;
  return { ok: true, message: `Refreshed ${lists + months.length} entry lists and ${tournaments} ${tournaments === 1 ? "tournament" : "tournaments"}.` };
}

/** Records what a player paid at the door and how, or, when amount is empty, marks them unpaid with
 *  corrections that cancel their payments. Paid is the total of their payments, and Paid by each way they paid. */
function markPaid(token, amount, by, donate) {
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
    let donation = 0;
    if (amount) {
      const event = clubEvents()[`${row.event}/${row.date}`];
      const listed = r[col["Rating fee"]];
      const fee = listed !== "" ? Number(listed) : event ? ratingFee(event, prices().fees) : null;
      const split = allocate(cents(amount), method, fee === null ? null : cents(fee), sum(mine, "Rating fee"), prices().fees.card);
      if (donate) {
        if (r[col.Amount] === "") return { error: "The fee isn't known, so what's over it can't be told. Set the category first." };
        const owed = Math.max(0, cents(r[col.Amount]) - cents(r[col.Discount]) - sum(mine, "Entry fee") - sum(mine, "Rating fee"));
        donation = Math.max(0, split["Entry fee"] + split["Rating fee"] - owed);
        // The rating fee is covered first, so what's over the fee is in the entry fee unless that is short.
        const fromEntry = Math.min(donation, split["Entry fee"]);
        split["Entry fee"] -= fromEntry;
        split["Rating fee"] -= donation - fromEntry;
        split.Donation = donation;
      }
      addPayment(book, token, partyOf(r, col), { Type: "payment", Method: method, Received: cents(amount), ...split,
        Note: fee === null ? "Rating fee unknown, so all of it counted as entry fee." : "" });
    } else {
      const reversed = new Set(mine.map((x) => x.Reverses).filter(Boolean));
      for (const x of mine.filter((x) => (x.Type === "payment" || x.Type === "refund") && !reversed.has(x["No."]))) {
        addPayment(book, token, partyOf(r, col), { Type: "correction", Method: x.Method, Received: -cents(x.Received),
          "Entry fee": -cents(x["Entry fee"]), "Rating fee": -cents(x["Rating fee"]), "Card fee": -cents(x["Card fee"]),
          Donation: -cents(x.Donation), Reverses: x["No."], Note: "Marked unpaid" });
      }
    }
    const when = amount ? Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm") : "";
    const paid = amount ? money((cents(r[col.Paid]) + cents(amount)) / 100) : "";
    const before = String(r[col["Paid by"]] || "").split(", ").filter(Boolean);
    const by = amount ? [...new Set([...before, method])].join(", ") : "";
    sheet.getRange(row.index + 2, col.Paid + 1).setNumberFormat("@").setValue(paid);
    sheet.getRange(row.index + 2, col["Paid on"] + 1).setNumberFormat("@").setValue(when);
    sheet.getRange(row.index + 2, col["Paid by"] + 1).setNumberFormat("@").setValue(by);
    // A contact's Donated total counts donations made with entries too.
    touch("entries", ...(donation || mine.some((x) => cents(x.Donation)) ? ["contacts"] : []));
    if (!amount) return { ok: true, message: `${row.name} is marked unpaid.` };
    const gift = donation ? `, with a $${money(donation / 100)} donation` : "";
    const held = ledgerByToken(book)[token];
    const short = r[col.Amount] === "" ? 0 : cents(r[col.Amount]) - cents(r[col.Discount]) - held.entry - held.rating - held.refunded;
    const rest = short > 0 ? ` $${money(short / 100)} is still due.` : "";
    return { ok: true, message: `${row.name} paid $${amount} by ${method}${gift}.${rest}` };
  } finally {
    lock.releaseLock();
  }
}

/** Switches a whole month to one of its nights, p.date, crediting the night with all the month holds.
 *  From the Entries page (td null), the player is p.id with p.last and the month's p.email, and only
 *  while nothing has been paid on the month and the night is still open; from the TD desk, p.token. */
function toNight(p, td) {
  if (!td && !underLimit()) return { error: "Too many changes right now. Try again in a minute." };
  const key = `${p.event}/${p.date}`;
  const night = clubEvents()[key];
  if (!night || night.kind !== "night") return { error: "That isn't one of the month's nights." };
  if (!td && (night.closed || new Date(night.closes) <= new Date())) {
    return { error: "This night has started, so only the TD can change the registration now." };
  }
  const id = String(p.id || "").trim();
  if (!td) {
    const member = lookup(id);
    if (member === null) return { error: "US Chess has no member with that ID." };
    if (!member) return { error: "US Chess didn't answer. Try again in a few minutes." };
    if (letters(member.lastName) !== letters(p.last)) return { error: "That last name doesn't match the US Chess ID." };
  }
  const lock = lockTournaments();
  let row, name, over, due;
  try {
    const { sheet, col, rows } = readEntries();
    const month = rows.find((r) => r[col.Event] === p.event && r[col.Date] === p.date.slice(0, 7) && active(r[col.Status])
      && (td ? r[col.Token] === p.token : r[col["US Chess ID"]] === id));
    if (!month) return { error: "No whole-month registration matches." };
    name = month[col.Name];
    if (!td && String(month[col.Email]).toLowerCase() !== String(p.email || "").trim().toLowerCase()) {
      return { error: "That email doesn't match the registration." };
    }
    const book = readPayments();
    const held = ledgerByToken(book)[month[col.Token]] || { received: 0, entry: 0, rating: 0 };
    if (!td && held.received) {
      return { error: `${name} has paid for the month, so the TD switches it at the event and refunds the difference.` };
    }
    const amount = month[col.Category] ? price(night, month[col.Category]) : null;
    const ratingDue = ratingFee(night, prices().fees);
    row = { ...partyOf(month, col), Date: p.date, Registered: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm"),
      Category: month[col.Category], Amount: amount === null ? "" : money(amount), "Regular rating": month[col["Regular rating"]],
      "Quick rating": month[col["Quick rating"]], "Membership expires": month[col["Membership expires"]], Email: month[col.Email],
      Status: "registered", "Added by": !td ? "online" : td.name ? `TD (${td.name})` : "TD", Token: Utilities.getUuid(),
      Phone: month[col.Phone], "Rating fee": ratingDue === null ? "" : money(ratingDue) };
    appendText(sheet, col, row);
    sheet.getRange(rows.indexOf(month) + 2, col.Status + 1).setNumberFormat("@").setValue(TO_NIGHT);
    // The month's tournament keeps the player for this night, without the month's byes, which would give them half
    // points for the others.
    const monthKey = `${p.event}/${p.date.slice(0, 7)}`;
    const run = byeList(month[col.Byes]).length ? runOf(monthKey) : null;
    if (run && run.info && setPlayerByes(monthKey, month[col["US Chess ID"]], [], run.info)) clearTournamentCache(monthKey);
    if (held.entry || held.rating) {
      addPayment(book, month[col.Token], partyOf(month, col), { Type: "credit", "Entry fee": -held.entry, "Rating fee": -held.rating,
        Note: `To ${nightLabel(p.date)}, ${row.Token}` });
      addPayment(book, row.Token, row, { Type: "credit", "Entry fee": held.entry, "Rating fee": held.rating,
        Note: `From the whole month, ${month[col.Token]}` });
    }
    const kept = held.entry + held.rating;
    over = amount !== null && kept > cents(amount) ? money((kept - cents(amount)) / 100) : "";
    due = amount === null ? null : money(Math.max(0, cents(amount) - kept) / 100);
    clearEntriesCache();
  } finally {
    lock.releaseLock();
  }
  const owed = over ? `$${over} of what was paid for the month is to be refunded.`
    : due === null ? "The TD will confirm the fee." : due === "0" ? "Nothing more is due." : `Due when you arrive: $${due}.`;
  if (row.Email) {
    MailApp.sendEmail({
      to: row.Email,
      replyTo: "president@larimerchess.org",
      name: "Larimer County Chess Club",
      subject: `Changed: ${night.name}, ${night.label}`,
      body: [
        `${name} (US Chess ID ${row["US Chess ID"]}) is now registered for ${night.name}, ${night.label} only, instead of the whole month.`,
        owed,
        `Can't come? Withdraw here: ${ScriptApp.getService().getUrl()}?withdraw=${row.Token}`,
        "Questions: president@larimerchess.org",
      ].join("\n\n"),
    });
  }
  return { ok: true, message: `${name} is registered for ${night.label} only. ${owed}` };
}

/** Replaces the byes an entry asks for with p.byes, in the entry and in its running tournament's Players row.
 *  From the Entries page (td null), the entry is p.event/p.date's for p.id, with p.last and the entry's
 *  p.email; from the TD desk, p.token. */
function setByes(p, td) {
  if (!td && !underLimit()) return { error: "Too many changes right now. Try again in a minute." };
  const id = String(p.id || "").trim();
  if (!td) {
    if (!/^\d{8}$/.test(id)) return { error: "A US Chess ID is eight digits." };
    const member = lookup(id);
    if (member === null) return { error: "US Chess has no member with that ID." };
    if (!member) return { error: "US Chess didn't answer. Try again in a few minutes." };
    if (letters(member.lastName) !== letters(p.last)) return { error: "That last name doesn't match the US Chess ID." };
  }
  const lock = lockTournaments();
  try {
    const { sheet, col, rows } = readEntries();
    const index = rows.findIndex((r) => active(r[col.Status]) && (td ? r[col.Token] === p.token
      : r[col.Event] === p.event && r[col.Date] === p.date && r[col["US Chess ID"]] === id));
    if (index < 0) return { error: "No registration matches." };
    const r = rows[index];
    const email = String(p.email || "").trim().toLowerCase();
    // The desk takes registrations without an email, and a blank one would match a blank cell.
    if (!td && (!email || String(r[col.Email]).toLowerCase() !== email)) return { error: "That email doesn't match the registration." };
    const key = `${r[col.Event]}/${r[col.Date]}`;
    const event = clubEvents()[key];
    if (!event) return { error: "That event isn't open." };
    const run = runOf(key);
    // doPost's check of TOURNAMENT_WRITES goes by p.event and p.date, which the desk may leave out and the Entries page skips.
    if (run.info && rated(key)) return { error: "US Chess has rated this tournament, so its byes can't change." };
    const checked = checkByes(byeList(p.byes), byeList(r[col.Byes]), key, event, run, !td);
    if (checked.error) return checked;
    sheet.getRange(index + 2, col.Byes + 1).setNumberFormat("@").setValue(checked.list.join(", "));
    if (run.info) setPlayerByes(key, r[col["US Chess ID"]], checked.list, run.info);
    clearEntriesCache();
    if (run.info) clearTournamentCache(key);
    return { ok: true, message: `${r[col.Name]}'s byes: ${byesText(checked.list)}.` };
  } finally {
    lock.releaseLock();
  }
}

/** Checks the byes asked for, a list as byeList makes it, for the event with the key: against old, the entry's
 *  list before, and run (runOf), its tournament's rows once it has started. online is the player's own change,
 *  not the TD's. Returns { list }, as the Byes column keeps it, or { error }. */
function checkByes(asked, old, key, event, run, online) {
  if (event.kind === "night") {
    return asked.length ? { error: "A single night has no byes; register for the whole month to miss a night." } : { list: [] };
  }
  const { info, lines } = run;
  const format = info ? info.Format : event.format || "";
  if (asked.length && format === "quad") return { error: "This tournament has no byes; a game a player misses is forfeited." };
  if (asked.length && format === "arena") return { error: "An arena has no byes." };
  const month = event.kind === "month";
  const dates = roundDates(info);
  const rounds = Number(info && info.Rounds) || Number(event.rounds) || 0;
  let list;
  if (month) {
    const nights = [...monthNights(key), ...dates];
    if (asked.some((d) => !nights.includes(d))) return { error: "Not a night of this month." };
    list = [...new Set(asked)].sort();
  } else {
    if (asked.length && !rounds) return { error: "The number of rounds isn't set yet; tell the TD." };
    if (asked.some((n) => !/^\d+$/.test(n) || Number(n) < 1 || Number(n) > rounds)) return { error: "Not a round of this tournament." };
    list = [...new Set(asked.map(Number))].sort((a, b) => a - b).map(String);
  }
  const paired = lines.reduce((m, r) => Math.max(m, Number(r.Round) || 0), 0);
  const locked = [...list.filter((x) => !old.includes(x)), ...old.filter((x) => !list.includes(x))]
    .filter((x) => byeRound(x, dates) && byeRound(x, dates) <= paired)
    .sort((a, b) => byeRound(a, dates) - byeRound(b, dates))[0];
  if (locked) {
    const what = month ? Utilities.formatDate(new Date(locked + "T12:00:00Z"), TZ, "MMMM d") : `Round ${locked}`;
    return { error: `${what} is already paired, so only the TD can change it.` };
  }
  if (online && !month && list.length > 1) return { error: "One half-point bye per player; ask the TD for more." };
  // 22C4: the last round's bye, a month's last night's, is asked for before round 1 and is then irrevocable.
  const last = month ? [...monthNights(key), ...dates].sort().at(-1) : String(rounds);
  if (online && lines.some((r) => Number(r.Round) === 1 && r.Posted) && list.includes(last) !== old.includes(last)) {
    return { error: `A ${month ? "bye for the month's last night" : "last-round bye"} is asked for before round 1 and can't be dropped after it (22C4); tell the TD.` };
  }
  return { list };
}

/** Sets the byes, as rounds, of the player with the US Chess ID in the tournament with the key, when they are
 *  one of its players; whether they are. */
function setPlayerByes(key, id, list, info) {
  const players = table("Players");
  const line = players.rows.find((x) => x.Key === key && x["US Chess ID"] === id);
  if (line) setCell(players, line.row, "Byes", byeRounds(list, info).join(", "));
  return Boolean(line);
}

/** A tournament's Tournaments row once it has started, or null, and its Rounds rows. */
function runOf(key) {
  const info = table("Tournaments").rows.find((r) => r.Key === key) || null;
  return { info, lines: info ? table("Rounds").rows.filter((r) => r.Key === key) : [] };
}

/** A Byes cell or request, "2, 4", as a list. */
function byeList(text) {
  return String(text || "").split(",").map((x) => x.trim()).filter(Boolean);
}

/** A bye's round: a round number, or a month's night by its place in dates (roundDates); 0 for neither. */
function byeRound(x, dates) {
  return /^\d{4}-\d\d-\d\d$/.test(x) ? dates.indexOf(x) + 1 : /^\d+$/.test(x) ? Number(x) : 0;
}

/** Byes as the tournament's round numbers, in order, leaving out a night its Round dates don't have. */
function byeRounds(list, info) {
  const dates = roundDates(info);
  return [...new Set(list.map((x) => byeRound(x, dates)))].filter(Boolean).sort((a, b) => a - b);
}

/** A month's nights in round order, from its Tournaments row's Round dates (JSON), which Start sets from the
 *  nights still to come; [] for a tournament date, or a month started before Round dates. */
function roundDates(info) {
  try {
    const list = JSON.parse((info && info["Round dates"]) || "[]");
    return Array.isArray(list) ? list.map(String) : [];
  } catch (err) {
    return [];
  }
}

/** The dates of a month's club nights that clubEvents() still lists, in order. */
function monthNights(key) {
  const events = clubEvents();
  return Object.keys(events).filter((k) => k.startsWith(key + "-") && events[k].kind === "night").map((k) => k.split("/")[1]).sort();
}

/** Byes as messages name them: "round 3", "rounds 2 and 4", a month's nights as "October 19 and 26", or "none". */
function byesText(list) {
  if (!list.length) return "none";
  if (!/^\d{4}-/.test(list[0])) return `${list.length > 1 ? "rounds" : "round"} ${andList(list)}`;
  return `${Utilities.formatDate(new Date(list[0] + "T12:00:00Z"), TZ, "MMMM")} ${andList(list.map((d) => String(Number(d.slice(8)))))}`;
}

function andList(items) {
  return items.length > 2 ? `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}` : items.join(" and ");
}

/** The Entries page open on an entry's list. It lists a month's entries under each night, so a month opens on
 *  its first still to come. */
function entriesLink(key, event) {
  const today = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  const night = event.kind === "month" && monthNights(key).find((d) => d >= today);
  return `${SITE}/entries/?event=${night ? `${event.event}/${night}` : key}`;
}

/** Records a donation to the club apart from any entry, from the contact p.contact or, with none,
 *  anonymous: the ledger row's Token is the contact's ID and its Event blank. A negative amount
 *  corrects a mistake. By card, the card fee comes out of what was given. */
function giveDonation(p, td) {
  const amount = String(p.amount || "").trim().replace(/^\$/, "");
  if (!/^-?\d+(\.\d\d)?$/.test(amount) || !cents(amount)) return { error: "Enter the amount given, such as 20." };
  const method = p.by || "cash";
  if (!METHODS.includes(method)) return { error: "Choose how it was given." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let party = { Event: "", Date: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"), "US Chess ID": "", Name: "Anonymous" };
    if (p.contact) {
      const { col, rows } = readTab("Contacts", CONTACT_HEADINGS);
      const r = rows.find((x) => x[col.ID] === p.contact);
      if (!r) return { error: "That contact is no longer in the Sheet. Reload the contacts." };
      party = { ...party, "US Chess ID": r[col["US Chess ID"]], Name: r[col.Name] };
    }
    const received = cents(amount);
    const split = allocate(Math.abs(received), method, 0, 0, prices().fees.card);
    const sign = Math.sign(received);
    const note = [String(p.note || "").trim(), td && td.name ? `By ${td.name}` : ""].filter(Boolean).join(". ");
    addPayment(readPayments(), p.contact || "", party, { Type: sign > 0 ? "donation" : "correction", Method: method, Received: received,
      "Card fee": sign * split["Card fee"], Donation: sign * split["Entry fee"], Note: note });
    touch("contacts");
    const gift = money(split["Entry fee"] / 100);
    return { ok: true, message: sign > 0 ? `Recorded a $${gift} donation from ${party.Name}${split["Card fee"] ? ", after the card fee" : ""}.`
      : `Took $${gift} off ${party.Name}'s donations.` };
  } finally {
    lock.releaseLock();
  }
}

/** Records money paid back to a player, by how it went back. It comes from the rating fee the entry no
 *  longer needs first, then the entry fee; never the card fee, which the processor keeps. */
function refund(token, amount, by, td) {
  amount = String(amount || "").trim().replace(/^\$/, "");
  if (!/^\d+(\.\d\d)?$/.test(amount) || !cents(amount)) return { error: "Enter the amount refunded, such as 9.50." };
  const method = by || "cash";
  if (!METHODS.includes(method)) return { error: "Choose how it was refunded." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const found = findToken(token);
    if (!found) return { error: "No registration matches this." };
    const { col, rows } = readEntries();
    const r = rows[found.index];
    const book = readPayments();
    const held = ledgerByToken(book)[token] || { entry: 0, rating: 0 };
    const back = cents(amount);
    if (back > held.entry + held.rating) {
      return { error: `At most $${money((held.entry + held.rating) / 100)} can be refunded: what was paid, less any card fee.` };
    }
    const ratingDue = active(r[col.Status]) ? cents(r[col["Rating fee"]]) : 0;
    let rating = Math.min(back, Math.max(0, held.rating - ratingDue));
    let entry = back - rating;
    if (entry > held.entry) {
      rating += entry - held.entry;
      entry = held.entry;
    }
    addPayment(book, token, partyOf(r, col), { Type: "refund", Method: method, Received: -back, "Entry fee": -entry, "Rating fee": -rating,
      Note: td && td.name ? `By ${td.name}` : "" });
    touch("entries");
    return { ok: true, message: `${found.name} was refunded $${money(back / 100)} by ${method}.` };
  } finally {
    lock.releaseLock();
  }
}

/** Sets what's taken off an entry's fee, up to all of it; an empty amount or 0 removes it. */
function discount(token, amount, note, td) {
  amount = String(amount || "").trim().replace(/^\$/, "");
  if (amount && !/^\d+(\.\d\d)?$/.test(amount)) return { error: "Enter the discount in dollars, such as 5." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const found = findToken(token);
    if (!found) return { error: "No registration matches this." };
    const { sheet, col, rows } = readEntries();
    const r = rows[found.index];
    const off = cents(amount);
    if (r[col.Amount] !== "" && off > cents(r[col.Amount])) return { error: `A discount can't be more than the fee, $${r[col.Amount]}.` };
    const why = [String(note || "").trim(), td && td.name ? `by ${td.name}` : ""].filter(Boolean).join(", ");
    sheet.getRange(found.index + 2, col.Discount + 1).setNumberFormat("@").setValue(off ? money(off / 100) : "");
    sheet.getRange(found.index + 2, col["Discount note"] + 1).setNumberFormat("@").setValue(off ? why : "");
    touch("entries");
    return { ok: true, message: off ? `${found.name} has a $${money(off / 100)} discount.` : `${found.name}'s discount is removed.` };
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

/** What each registration holds in the ledger, in cents: received, entry, rating, card, donation, credit
 *  (what credits moved in, or out when negative), and refunded. */
function ledgerByToken(book) {
  const held = {};
  const rows = (book || readPayments()).rows;
  const reversed = new Set(rows.map((x) => x.Reverses).filter(Boolean));
  for (const x of rows) {
    if (!held[x.Token]) held[x.Token] = { received: 0, entry: 0, rating: 0, card: 0, donation: 0, credit: 0, refunded: 0 };
    const h = held[x.Token];
    h.received += cents(x.Received);
    h.entry += cents(x["Entry fee"]);
    h.rating += cents(x["Rating fee"]);
    h.card += cents(x["Card fee"]);
    h.donation += cents(x.Donation);
    if (x.Type === "credit") h.credit += cents(x["Entry fee"]) + cents(x["Rating fee"]);
    if (x.Type === "refund" && !reversed.has(x["No."])) h.refunded -= cents(x.Received);
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
  return { received, entry: total("Entry fee"), rating: total("Rating fee"), card: total("Card fee"), donation: total("Donation"), games,
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
  for (const h of ["Received", "Entry fee", "Rating fee", "Card fee", "Donation"]) if (row[h] === undefined) row[h] = "0";
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
  return status !== "withdrawn" && status !== MOVED && status !== TO_NIGHT;
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
    // An unrated club event, such as a class, takes no registration.
    if (!e.page || !e.tags.includes("rated")) continue;
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

/** The TD a Firebase ID token signs in, { td: { email, name, usChessId } }, or why not, { error, login, verify }.
 *  Only a verified address counts, since anyone can make a Firebase account with any address. */
function signedInTd(idToken) {
  const user = firebaseUser(idToken);
  if (user.error) return user;
  if (!user.emailVerified) return { error: "Confirm your email address first; we've sent you a link.", login: true, verify: true };
  const email = user.email.toLowerCase();
  const pick = (list) => {
    const mine = list.filter((t) => t.emails.includes(email));
    return mine.find((t) => DESK_ROLES.includes(t.role)) || mine[0];
  };
  let listed = pick(tdList(false));
  if (!listed || !DESK_ROLES.includes(listed.role)) listed = pick(tdList(true));
  if (!listed) return { error: `${user.email} isn't on the club's list of TDs. Ask the president to add you.`, login: true };
  if (!DESK_ROLES.includes(listed.role)) {
    return { error: `${user.email} is on the club's list, but not as a TD. Ask the president to add you as one.`, login: true };
  }
  return { td: { email: user.email, name: listed.name || user.name || user.email, usChessId: listed.usChessId } };
}

/** The Firebase account an ID token belongs to, { email, emailVerified, name }, or { error, login }. Google's
 *  answer is kept under the token's hash until the token expires, or an hour at most; an unverified one isn't,
 *  so confirming the address takes effect at once. */
function firebaseUser(idToken) {
  const expired = { error: "Your sign-in has expired. Sign in again.", login: true };
  let exp = 0;
  try {
    const part = String(idToken).split(".")[1];
    const bytes = Utilities.base64DecodeWebSafe(part + "===".slice((part.length + 3) % 4));
    exp = Number(JSON.parse(Utilities.newBlob(bytes).getDataAsString()).exp) || 0;
  } catch (err) {
    return expired;
  }
  const seconds = Math.min(3600, Math.floor(exp - Date.now() / 1000));
  if (seconds < 1) return expired;
  const cache = CacheService.getScriptCache();
  const key = "idToken:" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(idToken)));
  const kept = cache.get(key);
  if (kept) return JSON.parse(kept);
  const apiKey = PropertiesService.getScriptProperties().getProperty("FIREBASE_API_KEY");
  if (!apiKey) return { error: "Sign-in isn't set up yet.", login: true };
  const response = UrlFetchApp.fetch(`${IDENTITY_LOOKUP}?key=${encodeURIComponent(apiKey)}`, { method: "post",
    contentType: "application/json", payload: JSON.stringify({ idToken }), muteHttpExceptions: true });
  const code = response.getResponseCode();
  if (code !== 200 && code !== 400) {
    console.error(`Firebase sign-in check: ${code} ${response.getContentText()}`);
    return { error: "Your sign-in couldn't be checked just now. Try again in a minute." };
  }
  const user = code === 200 && (JSON.parse(response.getContentText()).users || [])[0];
  const outcome = user && user.email ? { email: user.email, emailVerified: user.emailVerified === true, name: user.displayName || "" }
    : expired;
  if (outcome.emailVerified || outcome === expired) cache.put(key, JSON.stringify(outcome), seconds);
  return outcome;
}

/** The registration Sheet's TDs tab, kept for five minutes: each row's addresses (an Email cell may hold several),
 *  Name, US Chess ID, and Role. fresh reads the tab again. */
function tdList(fresh) {
  const cache = CacheService.getScriptCache();
  const kept = !fresh && cache.get("tds");
  if (kept) return JSON.parse(kept);
  const { col, rows } = readTab("TDs", TD_HEADINGS);
  const list = rows.map((r) => ({ emails: r[col.Email].toLowerCase().split(/[\s,;]+/).filter(Boolean), name: r[col.Name].trim(),
    usChessId: r[col["US Chess ID"]].trim(), role: r[col.Role].trim().toLowerCase() || "td" })).filter((t) => t.emails.length);
  cache.put("tds", JSON.stringify(list), 300);
  return list;
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
