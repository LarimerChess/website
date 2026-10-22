// Tests for scripts/registration.gs's running tournaments, against in-memory sheets and an in-memory
// Firebase Realtime Database: a spreadsheet from before sections (a quad mid-event), a Swiss in two
// sections, quads as sections, and the results players report.
//   node --test tests/test_registration.mjs
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const ROOT = new URL("..", import.meta.url).pathname;
const Pairing = createRequire(import.meta.url)("../pairing.js");
// Objects from the script are of another realm, so they are compared as JSON.
const eq = (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message);

function makeSheet(rows) {
  const data = rows.map((r) => r.map(String));
  const width = () => Math.max(1, ...data.map((r) => r.length));
  const sheet = {
    data,
    getDataRange: () => ({ getDisplayValues: () => (data.length ? data.map((r) => [...r, ...Array(width() - r.length).fill("")]) : [[""]]) }),
    getRange: (row, col) => {
      const range = {
        setNumberFormat: () => range,
        setValues: (values) => {
          values.forEach((vals, i) => vals.forEach((v, j) => {
            while (data.length < row + i) data.push([]);
            const r = data[row + i - 1];
            while (r.length < col + j) r.push("");
            r[col + j - 1] = String(v);
          }));
          return range;
        },
        setValue: (v) => range.setValues([[v]]),
      };
      return range;
    },
    setFrozenRows: () => {},
    getLastRow: () => data.length,
    getMaxRows: () => data.length + 100,
    insertRowAfter: () => {},
    deleteRow: (n) => data.splice(n - 1, 1),
  };
  return sheet;
}

const DATABASE = "https://lccc-test.firebaseio.com";
const FORBIDDEN = /[.$#[\]/]/;

// The database's REST API: GET (with shallow), PUT, PATCH (several paths at once), POST, and DELETE, as
// the president, whose token the script sends. Like the real one, it refuses keys with . $ # [ ] /,
// and keeps no empty objects. failing makes it answer 500.
function fakeDatabase() {
  const db = { root: {}, calls: [], failing: false };
  const parts = (path) => path.split("/").filter(Boolean);
  const clean = (value) => {
    if (value === null || typeof value !== "object") return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN.test(k) || !k) throw new Error(`invalid key ${k}`);
      const c = clean(v);
      if (c !== null && c !== undefined && !(typeof c === "object" && !Object.keys(c).length)) out[k] = c;
    }
    return Object.keys(out).length ? out : null;
  };
  const set = (path, value) => {
    const keys = parts(path);
    if (keys.some((k) => FORBIDDEN.test(k))) throw new Error(`invalid path ${path}`);
    value = clean(value);
    if (!keys.length) {
      db.root = value || {};
      return;
    }
    const trail = [];
    let node = db.root;
    for (const k of keys.slice(0, -1)) {
      if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
      trail.push([node, k]);
      node = node[k];
    }
    if (value === null || value === undefined) delete node[keys.at(-1)];
    else node[keys.at(-1)] = value;
    for (const [parent, k] of trail.reverse()) if (!Object.keys(parent[k]).length) delete parent[k];
  };
  const get = (path) => parts(path).reduce((n, k) => (n && typeof n === "object" ? n[k] : undefined), db.root);
  const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body ?? null) });
  db.fetch = (url, options = {}) => {
    const [, path, query = ""] = url.slice(DATABASE.length).match(/^\/(.*?)\.json(?:\?(.*))?$/);
    const method = (options.method || "get").toUpperCase();
    db.calls.push({ method, path, query });
    if (!/^Bearer \S+$/.test((options.headers || {}).Authorization || "")) return reply(401, { error: "Permission denied" });
    if (db.failing) return reply(500, { error: "down" });
    const body = options.payload === undefined ? undefined : JSON.parse(options.payload);
    try {
      if (method === "GET") {
        const value = get(path) ?? null;
        return reply(200, query.includes("shallow=true") && value && typeof value === "object"
          ? Object.fromEntries(Object.keys(value).map((k) => [k, true])) : value);
      }
      if (method === "PUT") set(path, body);
      else if (method === "PATCH") for (const [k, v] of Object.entries(body)) set(`${path}/${k}`, v);
      else if (method === "POST") {
        const name = `-push${db.calls.length}`;
        set(`${path}/${name}`, body);
        return reply(200, { name });
      } else if (method === "DELETE") set(path, null);
      else return reply(405, { error: "method" });
    } catch (err) {
      return reply(400, { error: err.message });
    }
    return reply(200, method === "DELETE" ? null : body);
  };
  return db;
}

const TOURNAMENT_TABS = ["Tournaments", "Players", "Rounds", "Arena"];
const STORES = ["sheet", "firebase"];
const encodeKey = (h) => h.replace(/[.$#[\]/%]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const decodeKey = (h) => h.replace(/%(2E|24|23|5B|5D|2F|25)/gi, (_, x) => String.fromCharCode(parseInt(x, 16)));

// US Chess as the script sees it: a member's regular floor and their regular-rated games' outcomes.
const US_CHESS = {
  11111111: { floor: 1700, outcomes: ["Win", "Loss", "Draw"] },
  55555555: { floor: 100, outcomes: ["Loss", "Loss"] },
  66666666: { first: "Ann", last: "Ash", outcomes: [] },
  77777777: { first: "Ben", last: "Birch", outcomes: [] },
};

// cache: what the script cache holds, such as this minute's count of public posts. props: the
// script properties, such as the US Chess answers kept by ID. With store "firebase", the tournament
// tabs start in the database as the migration leaves them, row IDs r000002 on, and the script uses it.
function load(tabs, cache = {}, store = "sheet") {
  const db = fakeDatabase();
  const inDatabase = (name) => store === "firebase" && TOURNAMENT_TABS.includes(name);
  for (const [name, [header, ...rows]] of Object.entries(tabs).filter(([name, rows]) => inDatabase(name) && rows.length)) {
    db.fetch(`${DATABASE}/tables/${name}.json`, { method: "put", headers: { Authorization: "Bearer seed" },
      payload: JSON.stringify(Object.fromEntries(rows.map((r, i) => [`r${String(i + 2).padStart(6, "0")}`,
        Object.fromEntries(header.map((h, j) => [encodeKey(h), String(r[j] ?? "")]))]))) });
  }
  db.calls.length = 0;
  const sheets = Object.fromEntries(Object.entries(tabs).filter(([name]) => !inDatabase(name)).map(([name, rows]) => [name, makeSheet(rows)]));
  const book = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet([])) };
  const registration = book;
  const props = { TOURNAMENT_SHEET_ID: "sheet", USCHESS_API_KEY: "key", TD_PASSWORD: "sheet", FIREBASE_API_KEY: "web-key" };
  if (store === "firebase") props.FIREBASE_URL = DATABASE + "/";
  const fetched = [];
  // The website's ratings.json, the tournaments US Chess has rated.
  const ratings = {};
  // Firebase Authentication's accounts:lookup: the account each ID token belongs to; a token not here is invalid.
  const accounts = {};
  const lookups = [];
  const answer = (url, options) => {
    if (url.startsWith(DATABASE)) return db.fetch(url, options);
    if (url.startsWith("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=")) {
      const { idToken } = JSON.parse(options.payload);
      lookups.push(idToken);
      const user = accounts[idToken];
      return { getResponseCode: () => (user ? 200 : 400),
        getContentText: () => JSON.stringify(user ? { users: [user] } : { error: { message: "INVALID_ID_TOKEN" } }) };
    }
    fetched.push(url);
    if (url.endsWith("/ratings.json")) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(ratings) };
    if (url.endsWith("/prices.json")) return { getResponseCode: () => 200, getContentText: () => readFileSync(`${ROOT}prices.json`, "utf8") };
    const [, id, games] = url.match(/members\/(\d+)(\/games)?/);
    const m = US_CHESS[id] || { outcomes: [] };
    const body = games ? { items: m.outcomes.map((outcome) => ({ player: { outcome } })) }
      : { ratings: m.floor ? [{ ratingSystem: "R", floor: m.floor }] : [], stateRep: m.state ?? "CO", firstName: m.first, lastName: m.last };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
  };
  const context = {
    console,
    fetched,
    UrlFetchApp: { fetch: answer, fetchAll: (requests) => requests.map((r) => answer(r.url, r)) },
    ScriptApp: { getOAuthToken: () => "president-token", getService: () => ({ getUrl: () => "https://script.example/exec" }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; }, getProperties: () => ({ ...props }) }) },
    SpreadsheetApp: { openById: () => {
      if (store === "firebase") throw new Error("the tournament spreadsheet is opened with the database in use");
      return book;
    }, getActiveSpreadsheet: () => registration },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v; }, remove() {}, removeAll() {},
      getAll: (keys) => Object.fromEntries(keys.filter((k) => k in cache).map((k) => [k, cache[k]])),
      putAll: (values) => Object.assign(cache, values) }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text) => ({ setMimeType: () => JSON.parse(text) }) },
    Utilities: { formatDate: (d, tz, f) => (f === "yyyy-MM-dd" ? d.toISOString().slice(0, 10) : "2026-10-10 10:00"), getUuid: () => "uuid",
      computeDigest: (_, s) => [...s].map((c) => c.charCodeAt(0)), DigestAlgorithm: {},
      base64DecodeWebSafe: (s) => [...Buffer.from(s, "base64url")], base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString("base64url"),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString("utf8") }) },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(`${ROOT}scripts/registration.gs`, "utf8"), context);
  const headers = vm.runInContext("TOURNAMENT_HEADERS", context);
  // A tournament tab's rows in order, from either store, with every heading.
  const rows = (name) => {
    if (!inDatabase(name)) return rowsOf(sheets[name]);
    const stored = (db.root.tables || {})[name] || {};
    return Object.keys(stored).sort().map((id) => {
      const r = Object.fromEntries(Object.entries(stored[id]).map(([h, v]) => [decodeKey(h), v]));
      return { ...Object.fromEntries(headers[name].map((h) => [h, ""])), ...r };
    });
  };
  // An edit made by hand in the Sheet or the database to a tab's row (0 is the first after the
  // headings), which the script sees in its next execution: fields by heading, or null to delete it.
  const handEdit = (name, index, fields) => {
    if (!inDatabase(name)) {
      const data = sheets[name].data;
      if (!fields) data.splice(index + 1, 1);
      else for (const [h, v] of Object.entries(fields)) data[index + 1][data[0].indexOf(h)] = v;
      return;
    }
    const stored = db.root.tables[name];
    const id = Object.keys(stored).sort()[index];
    if (!fields) delete stored[id];
    else for (const [h, v] of Object.entries(fields)) stored[id][encodeKey(h)] = v;
    vm.runInContext("databaseCopy = null; databaseQueues = null;", context);
  };
  // The arena queues by tournament key, from the script property or the database.
  const queued = () => (store === "sheet" ? JSON.parse(props.arenaQueues || "{}")
    : Object.fromEntries(Object.entries(db.root.queues || {}).map(([node, text]) => [node.replace(/:/g, "/"), JSON.parse(text)])));
  return { gs: context, sheets, ratings, cache, props, db, rows, handEdit, queued, store, accounts, lookups };
}

const heading = (sheet) => sheet.data[0];
const rowsOf = (sheet) => sheet.data.slice(1).map((r) => Object.fromEntries(heading(sheet).map((h, i) => [h, r[i] || ""])));

test("fees: the round fee for each round an entry covers, an arena's flat fee, and the card fee", () => {
  const arena = "knightmare-arena-classical/2026-10-31";
  const { gs, sheets } = load({
    Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Category", "Amount", "Paid", "Paid on", "Status", "Token"],
      ["", "knightmare-arena-classical", "2026-10-31", "11111111", "Ann", "Adult", "18", "", "", "registered", "t1"],
      ["", "knightmare-arena-classical", "2026-10-31", "22222222", "Ben", "Under 18", "3", "", "", "registered", "t2"]],
  });
  const night = (date) => ({ event: "monday-club-night-at-peak", kind: "night", first: date });
  gs.clubEvents = () => ({ [arena]: { event: "knightmare-arena-classical", kind: "entry", first: "2026-10-31", format: "arena" },
    "monday-club-night-at-peak/2026-10-12": night("2026-10-12"), "monday-club-night-at-peak/2026-10-19": night("2026-10-19"),
    "monday-club-night-at-peak/2026-10-26": night("2026-10-26"), "monday-club-night-at-peak/2026-11-02": night("2026-11-02") });
  const saturday = { event: "first-saturday-classic", kind: "entry", first: "2026-11-07", format: "swiss", rounds: "4" };
  eq([gs.price(saturday, "Adult"), gs.price(saturday, "Under 18"), gs.price({ ...saturday, rounds: "" }, "Adult")], [17, 2, null]);
  const month = { event: "monday-club-night-at-peak", kind: "month", first: "2026-10-12" };
  eq([gs.price(month, "Senior (65+)"), gs.price(night("2026-10-19"), "Adult"), gs.price(gs.clubEvents()[arena], "Adult"),
    gs.price(gs.clubEvents()[arena], "Under 18")], [11.5, 7.5, 18, 3]);
  eq(gs.entries(arena, true).map((e) => [e.name, e.due, e.card]), [["Ann", "18", "18.95"], ["Ben", "3", "3.58"]]);
  eq([15, 16.5, 17].map((n) => gs.cardTotal(n, { percent: 2.5, fixed: 0.5 })), [15.88, 17.42, 17.93], "any part of a cent rounds up");
  assert.equal(gs.markPaid("t1", "18.95", "card").message, "Ann paid $18.95 by card.");
  eq(rowsOf(sheets.Entries).map((r) => [r.Paid, r["Paid by"]]), [["18.95", "card"], ["", ""]]);
});

test("the script avoids syntax Apps Script can't parse, though node can", () => {
  const source = readFileSync(`${ROOT}scripts/registration.gs`, "utf8");
  assert.doesNotMatch(source, /(\|\||&&|\?\?)=/, "logical assignment, such as ||=");
});

test("the public copies last six hours, every change clears them, and Refresh rebuilds them", () => {
  const { gs, sheets, cache } = load({
    Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Status", "Regular rating", "Token"],
      ["", "classic", "2026-11-07", "11111111", "Ann", "registered", "1900", "t1"]],
    Tournaments: [["Key", "Event", "Name", "Format", "Rounds", "Status"]], Players: [["Key"]], Rounds: [["Key"]], Arena: [["Key"]],
  });
  const events = { "classic/2026-11-07": { event: "classic", name: "Classic", kind: "entry", label: "Saturday", first: "2099-11-07",
    last: "2099-11-07", closes: "2099-11-07T10:00:00-07:00" } };
  gs.clubEvents = () => events;
  let n = 0;
  gs.Utilities.getUuid = () => `version${++n}`;
  const ttl = {};
  const store = gs.CacheService.getScriptCache();
  gs.CacheService.getScriptCache = () => ({ ...store, put: (k, v, seconds) => { cache[k] = v; ttl[k] = seconds; },
    removeAll: (keys) => keys.forEach((k) => delete cache[k]), remove: (k) => delete cache[k] });
  const names = () => gs.allEntries()[0].entries.map((e) => e.name);
  eq(names(), ["Ann"]);
  assert.equal(ttl[gs.allEntriesKey()], 21600);
  assert.equal(ttl[gs.entriesKey("classic/2026-11-07")], 21600);
  const before = gs.allEntriesKey();
  gs.withdraw("t1");
  assert.notEqual(gs.allEntriesKey(), before, "a withdrawal starts a new version");
  eq(names(), []);
  const listed = gs.allEntriesKey();
  events["classic/2026-11-14"] = { ...events["classic/2026-11-07"], label: "Another Saturday", first: "2099-11-14" };
  assert.notEqual(gs.allEntriesKey(), listed, "a new calendar event makes a new copy");
  const tournamentsBefore = gs.allEntriesKey();
  gs.clearTournamentCache("classic/2026-11-07");
  assert.notEqual(gs.allEntriesKey(), tournamentsBefore, "a tournament change clears the lists, which show sections");
  // A hand edit in the Sheet shows only after Refresh.
  names();
  sheets.Entries.data.push(["", "classic", "2026-11-07", "22222222", "Ben", "registered", "1700", "t2"]);
  eq(names(), []);
  assert.match(gs.refreshCaches().message, /Refreshed 2 entry lists and 0 tournaments/);
  eq(JSON.parse(cache[gs.allEntriesKey()])[0].entries.map((e) => e.name), ["Ben"]);
});

test("the database keeps a copy of the Entries page's lists, rebuilt on each change and on a new day's first visit", () => {
  const { gs, sheets, cache, db } = load({
    Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Status", "Regular rating", "Token"],
      ["", "classic", "2099-11-07", "11111111", "Ann", "registered", "1900", "t1"]],
  }, {}, "firebase");
  gs.clubEvents = () => ({ "classic/2099-11-07": { event: "classic", name: "Classic", kind: "entry", label: "Saturday", first: "2099-11-07",
    last: "2099-11-07", closes: "2099-11-07T10:00:00-07:00" } });
  let n = 0;
  gs.Utilities.getUuid = () => `version${++n}`;
  const store = gs.CacheService.getScriptCache();
  gs.CacheService.getScriptCache = () => ({ ...store, remove: (k) => delete cache[k], removeAll: (keys) => keys.forEach((k) => delete cache[k]) });
  const copied = () => JSON.parse(db.root.public.entries)[0].entries.map((e) => e.name);
  gs.allEntries();
  eq(copied(), ["Ann"]);
  const writes = () => db.calls.filter((c) => c.path === "public/entries").length;
  const before = writes();
  gs.allEntries();
  assert.equal(writes(), before, "a cached list isn't written again");
  gs.withdraw("t1");
  eq(copied(), [], "a withdrawal rewrites the copy before the next visit");
  // A hand edit shows on the next build, such as a new day's or Refresh's.
  sheets.Entries.data.push(["", "classic", "2099-11-07", "22222222", "Ben", "registered", "1700", "t2"]);
  gs.refreshCaches();
  eq(copied(), ["Ben"]);
  db.failing = true;
  gs.withdraw("t2");
  db.failing = false;
  eq(rowsOf(sheets.Entries).map((r) => r.Status), ["withdrawn", "withdrawn"], "a database that's down doesn't undo a withdrawal");
});

test("each change gives its kind a new stamp, which the desks poll to reload just that", () => {
  const { gs } = load({
    Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Status", "Amount", "Paid", "Paid on", "Token"],
      ["", "classic", "2026-11-07", "11111111", "Ann", "registered", "15", "", "", "t1"]],
    Contacts: [["Name", "Email", "Phone", "Notes"]],
  });
  gs.clubEvents = () => ({});
  const changed = (act) => {
    const before = gs.changes();
    act();
    const after = gs.changes();
    return Object.keys(after).filter((k) => after[k] !== before[k]);
  };
  eq(gs.changes(), { entries: "", tournaments: "", contacts: "" });
  eq(changed(() => gs.markPaid("t1", "15", "cash")), ["entries"]);
  eq(changed(() => gs.withdraw("t1")), ["entries"]);
  eq(changed(() => gs.clearTournamentCache("classic/2026-11-07")), ["tournaments"]);
  eq(changed(() => gs.saveContact({ fields: JSON.stringify({ Name: "Ann Ash" }) })), ["contacts"]);
  eq(changed(() => gs.refreshCaches()), ["entries", "tournaments", "contacts"]);
  const login = gs.doPost({ parameter: { action: "login", password: "sheet", device: "d1" } });
  eq(login.changes, gs.changes(), "sign-in starts the desk from the stamps");
});

test("the desk's contacts: IDs for rows added by hand, saving by heading, formulas kept as text, and deleting", () => {
  const { gs, sheets } = load({
    Contacts: [["Name", "Email", "Phone", "Notes"], ["Ann Ash", "ann@example.com", "970-555-0100", "Board"], ["", "", "", ""],
      ["Ben Birch", "ben@example.com", "", ""]],
    Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Status", "Email", "Phone"],
      ["", "classic", "2026-11-07", "11111111", "Ann Ash", "registered", "", ""]],
  });
  let n = 0;
  gs.Utilities.getUuid = () => `c${++n}`;
  const book = gs.contacts();
  eq(book.headings, ["Name", "Email", "Phone", "Notes", "US Chess ID"]);
  eq(book.contacts.map((c) => [c.id, c.Name]), [["c1", "Ann Ash"], ["c2", "Ben Birch"]], "a blank row gets no ID");
  eq(heading(sheets.Contacts), ["Name", "Email", "Phone", "Notes", "US Chess ID", "ID"]);
  eq(gs.people().map((p) => [p.name, p.email, p.phone]), [["Ann Ash", "ann@example.com", "970-555-0100"]], "a registration takes its contact's email and phone");

  assert.equal(gs.saveContact({ id: "c2", fields: JSON.stringify({ Name: "Ben Birch", Phone: "+1 970 555 0101", "US Chess ID": "22222222" }) }).ok, true);
  const ben = rowsOf(sheets.Contacts).find((r) => r.ID === "c2");
  eq([ben.Email, ben.Phone, ben["US Chess ID"]], ["ben@example.com", "'+1 970 555 0101", "22222222"], "headings left out keep their values");
  assert.equal(gs.saveContact({ fields: JSON.stringify({ Name: "Cal Cedar", Notes: "=HYPERLINK(1)" }) }).id, "c3");
  eq(rowsOf(sheets.Contacts).at(-1).Notes, "'=HYPERLINK(1)");
  assert.match(gs.saveContact({ fields: JSON.stringify({ Name: " " }) }).error, /needs a name/);
  assert.match(gs.saveContact({ fields: JSON.stringify({ Name: "Dee", "US Chess ID": "123" }) }).error, /eight digits/);
  assert.match(gs.saveContact({ id: "gone", fields: JSON.stringify({ Name: "Dee" }) }).error, /no longer in the Sheet/);
  // contactFor keeps the tab it read for the rest of a request, so a fresh one sees the ID just saved.
  const fresh = load({ Contacts: sheets.Contacts.data }).gs;
  assert.equal(fresh.contactFor("Benjamin Birch", "22222222").email, "ben@example.com", "a contact's US Chess ID finds them whatever the name");
  assert.equal(gs.deleteContact("c1").ok, true);
  eq(gs.contacts().contacts.map((c) => c.Name), ["Ben Birch", "Cal Cedar"]);
});

for (const store of STORES) {
  test(`an arena's queue lives in a script property or the database, and a restart or a finished arena drops it (${store})`, () => {
    const key = "arena/2026-11-07";
    const at = { event: "arena", date: "2026-11-07" };
    const { gs, db, props, handEdit, queued } = load({
      Tournaments: [["Key", "Event", "Name", "Format", "Rounds", "Status", "Started", "Coin", "Finished", "Cutoff", "Sections"],
        [key, "arena", "Arena", "arena", "", "running", "2026-11-07 10:00", "white", "", "", ""],
        ["gone/2026-10-31", "gone", "Gone", "arena", "", "running", "2026-10-31 10:00", "white", "", "", ""]],
      Players: [["Key", "No.", "US Chess ID", "Name", "Rating"], [key, "1", "11111111", "Ann", "1900"], [key, "2", "22222222", "Ben", "1700"]],
      Arena: [["Key", "Game", "White", "Black", "White pact", "Black pact", "Result", "Started", "Ended"]],
    }, {}, store);
    const gone = [{ id: "99999999", since: "x" }];
    if (store === "sheet") props.arenaQueues = JSON.stringify({ "gone/2026-10-31": gone });
    else db.root.queues = { "gone:2026-10-31": JSON.stringify(gone) };
    handEdit("Tournaments", 1, null);
    assert.equal(gs.arenaJoin({ ...at, id: "11111111" }).ok, true);
    assert.match(gs.arenaJoin({ ...at, id: "11111111" }).message, /Ann is available/, "joining again changes nothing");
    assert.equal(gs.arenaJoin({ ...at, id: "22222222" }).ok, true);
    eq(Object.keys(queued()), [key], "a tournament no longer running loses its queue");
    eq(gs.tournament(key, true).queue.map((q) => q.id), ["11111111", "22222222"]);
    assert.equal(gs.arenaPair({ ...at, games: JSON.stringify([{ white: "11111111", black: "22222222" }]) }).ok, true);
    eq(gs.tournament(key, true).queue.map((q) => q.id), ["11111111", "22222222"], "a player stays in the queue through a game");
    eq(gs.tournament(key, true).games.map((g) => [g.game, g.section, g.white, g.black, g.result]), [[1, "", "11111111", "22222222", ""]]);
    assert.match(gs.arenaPair({ ...at, games: JSON.stringify([{ white: "11111111", black: "22222222" }]) }).message, /0 of 1/, "both are in a game");
    assert.equal(gs.arenaResult({ ...at, game: "1", result: "1-0" }).ok, true);
    eq(gs.tournament(key, true).queue.map((q) => q.id), ["11111111", "22222222"], "both wait again after a result");
    assert.equal(gs.arenaLeave({ ...at, id: "22222222" }).ok, true);
    eq(gs.tournament(key, true).queue.map((q) => q.id), ["11111111"]);
    assert.equal(gs.arenaResult({ ...at, game: "1", result: "0F-1F" }).ok, true, "a correction");
    eq(gs.tournament(key, true).queue.map((q) => q.id), ["11111111"], "a correction changes the queue no more");
    assert.equal(gs.restartTournament(key).ok, true);
    eq(queued(), {});
  });

  test(`an arena in sections: players available where they choose, challenges from the Pairings page, and their reports (${store})`, () => {
    // On the day the stand-in clock gives, 2026-10-10 10:00, so the cutoff can pass.
    const key = "arena/2026-10-10";
    const at = { event: "arena", date: "2026-10-10" };
    const sections = [{ name: "Classical", timeControl: "G/30;+30", rated: true }, { name: "Blood Pact", timeControl: "G/15;+15 against G/30;+30", rated: false, pact: true }];
    const { gs, handEdit, rows } = load({
      Tournaments: [["Key", "Event", "Name", "Format", "Rounds", "Status", "Started", "Coin", "Finished", "Cutoff", "Sections"],
        [key, "arena", "Arena", "arena", "", "running", "2026-10-10 09:00", "white", "", "17:30", JSON.stringify(sections)]],
      Players: [["Key", "No.", "US Chess ID", "Name", "Rating"], [key, "1", "11111111", "Ann", "1900"], [key, "2", "22222222", "Ben", "1700"],
        [key, "3", "33333333", "Cal", "1500"]],
      Arena: [["Key", "Game", "White", "Black", "White pact", "Black pact", "Result", "Started", "Ended"]],
    }, {}, store);
    const post = (fields) => gs.doPost({ parameter: fields });
    // Availability, as the Pairings page sends it, with no password.
    assert.match(post({ action: "arenaAvailable", ...at, id: "1111111", sections: "[]" }).error, /eight digits/);
    assert.match(post({ action: "arenaAvailable", ...at, id: "99999999", sections: '["Classical"]' }).error, /not in this arena yet/);
    assert.match(post({ action: "arenaAvailable", ...at, id: "11111111", sections: '["Blitz"]' }).error, /No section is named Blitz/);
    assert.match(post({ action: "arenaAvailable", ...at, id: "11111111", sections: '["Classical", "Blood Pact"]' }).message, /Ann is available in Classical, Blood Pact/);
    assert.match(post({ action: "arenaAvailable", ...at, id: "22222222", sections: '["Blood Pact"]' }).message, /Ben is available in Blood Pact/);
    assert.match(gs.arenaJoin({ ...at, id: "33333333" }).message, /Cal is available in every section/, "the desk's button names no section");
    eq(gs.tournament(key, false).queue.map((q) => [q.id, q.sections]), [["11111111", ["Classical", "Blood Pact"]], ["22222222", ["Blood Pact"]], ["33333333", []]]);
    eq(gs.tournament(key, false).sections, sections);
    // A challenge.
    assert.match(post({ action: "arenaChallenge", ...at, id: "33333333", opponent: "22222222", section: "Classical" }).error, /Ben isn't available in Classical/);
    assert.match(post({ action: "arenaChallenge", ...at, id: "33333333", opponent: "22222222", section: "Blitz" }).error, /No such section/);
    assert.match(gs.arenaChallenge({ ...at, id: "33333333", opponent: "22222222", section: "Blood Pact" }).error, /Who halves their clock/);
    assert.match(gs.arenaChallenge({ ...at, id: "33333333", opponent: "22222222", section: "Blood Pact", pact: "both" }).error, /Who halves their clock/);
    const started = post({ action: "arenaChallenge", ...at, id: "33333333", opponent: "22222222", section: "Blood Pact", pact: "me" });
    eq([started.ok, started.game, started.message], [true, 1, "Game 1, Blood Pact: Ben has white, Cal black."]);
    let t = gs.tournament(key, false);
    eq(t.games.map((g) => [g.game, g.section, g.white, g.black, g.whitePact, g.blackPact, g.result]), [[1, "Blood Pact", "22222222", "33333333", false, true, ""]]);
    assert.match(post({ action: "arenaChallenge", ...at, id: "11111111", opponent: "22222222", section: "Blood Pact" }).error, /Ben is in a game/);
    assert.match(post({ action: "arenaChallenge", ...at, id: "33333333", opponent: "11111111", section: "Classical" }).error, /You're in a game/);
    assert.match(post({ action: "arenaAvailable", ...at, id: "33333333", sections: '["Classical"]' }).message, /Cal is in a game, and available in Classical once it ends/);
    // Reports: the first ends the game; an agreeing or lone report counts until the TD confirms it.
    assert.match(post({ action: "arenaReport", ...at, id: "11111111", game: "1", result: "0-1" }).error, /not in that game/);
    assert.match(post({ action: "arenaReport", ...at, id: "33333333", game: "1", result: "1F-0F" }).error, /Report 1–0/);
    assert.match(post({ action: "arenaReport", ...at, id: "33333333", game: "1", result: "0-1" }).message, /Game 1: 0–1 is reported. It counts unless the TD changes it/);
    t = gs.tournament(key, false);
    eq(t.games[0].reports, { white: "", black: "0-1" });
    assert.equal(t.games[0].result, "");
    assert.ok(t.games[0].ended, "a report ends the game");
    assert.match(post({ action: "arenaChallenge", ...at, id: "11111111", opponent: "33333333", section: "Classical", pact: "me" }).message, /Game 2, Classical: Cal has white, Ann black/, "free again, and Cal had black");
    eq(gs.tournament(key, false).games[1].blackPact, false, "no pact outside the Blood Pact section");
    assert.match(post({ action: "arenaReport", ...at, id: "22222222", game: "1", result: "1-0" }).message, /you reported 1–0 and your opponent 0–1. See the TD/);
    eq(gs.tournament(key, false).games[0].reports, { white: "1-0", black: "0-1" });
    assert.equal(gs.arenaResult({ ...at, game: "1", result: "0-1" }).ok, true, "the TD settles it");
    assert.match(post({ action: "arenaReport", ...at, id: "22222222", game: "1", result: "1-0" }).error, /already entered/);
    assert.equal(gs.ledgerFor(key).games, 0, "a Blood Pact section game isn't rated");
    assert.equal(gs.arenaResult({ ...at, game: "2", result: "1-0" }).ok, true);
    assert.equal(gs.ledgerFor(key).games, 1);
    // The sections change: a rename follows games and the queue, and a section with games stays.
    assert.match(gs.setArenaSections({ ...at, sections: JSON.stringify([{ from: "Classical", name: "Classical", timeControl: "G/30;+30" }]) }).error,
      /Blood Pact has games, so it can't be dropped/);
    assert.match(gs.setArenaSections({ ...at, sections: JSON.stringify([{ from: "Classical", name: "Slow", timeControl: "G/30;+30" },
      { from: "Blood Pact", name: "Pact", rated: true, pact: true }, { name: "Blitz", timeControl: "G/5;+3", rated: "no" }]) }).message, /Sections: Slow, Pact, Blitz/);
    t = gs.tournament(key, true);
    eq(t.sections, [{ name: "Slow", timeControl: "G/30;+30", rated: true }, { name: "Pact", timeControl: "", rated: false, pact: true }, { name: "Blitz", timeControl: "G/5;+3", rated: false }],
      "a Blood Pact section is never rated");
    eq(t.games.map((g) => g.section), ["Pact", "Slow"]);
    eq(t.queue.map((q) => [q.id, q.sections]), [["11111111", ["Slow", "Pact"]], ["22222222", ["Pact"]], ["33333333", ["Slow"]]]);
    assert.match(gs.setArenaSections({ ...at, sections: JSON.stringify([{ from: "Gone", name: "Gone" }]) }).error, /changed since the desk loaded them/);
    assert.match(post({ action: "arenaAvailable", ...at, id: "22222222", sections: "[]" }).message, /Ben is taking a break/);
    eq(gs.tournament(key, true).queue.map((q) => q.id), ["11111111", "33333333"]);
    if (store === "sheet") eq(rows("Arena")[0].Section, "Pact");
    // Past the cutoff, and once US Chess has rated it, nothing starts.
    assert.match(post({ action: "arenaAvailable", ...at, id: "22222222", sections: '["Slow"]' }).message, /Ben is available in Slow/);
    handEdit("Tournaments", 0, { Cutoff: "09:00" });
    assert.match(post({ action: "arenaChallenge", ...at, id: "11111111", opponent: "22222222", section: "Slow" }).error, /No new games start after 09:00/);
    assert.match(gs.arenaPair({ ...at, games: "[]" }).error, /No new games start after 09:00/);
  });

  test(`an arena is started in sections from the desk, and games keep their columns in the Sheet (${store})`, () => {
    const { gs, sheets, rows } = load({
      Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Category", "Amount", "Paid", "Paid on", "Regular rating", "Quick rating",
        "Membership expires", "Email", "Status", "Added by", "Token", "Phone", "Paid by", "Rating fee"],
        ["2026-10-01 10:00", "knightmare-arena-classical", "2026-10-31", "11111111", "Ann", "Adult", "18", "", "", "1900", "", "2027-01-01", "a@x", "", "", "t1", "", "", "3"],
        ["2026-10-01 10:00", "knightmare-arena-classical", "2026-10-31", "22222222", "Ben", "Adult", "18", "", "", "1700", "", "2027-01-01", "b@x", "", "", "t2", "", "", "3"]],
      Tournaments: [], Players: [], Rounds: [], Arena: [],
    }, { clubEvents: JSON.stringify({ "knightmare-arena-classical/2026-10-31": { event: "knightmare-arena-classical", name: "Knightmare Arena Classical",
      label: "Saturday, October 31, 2026", kind: "entry", first: "2026-10-31", last: "2026-10-31", closes: "2026-10-31T10:00:00-06:00", format: "arena" } }) }, store);
    const at = { event: "knightmare-arena-classical", date: "2026-10-31" };
    const bad = gs.startTournament({ ...at, format: "arena", cutoff: "17:30", sections: JSON.stringify([{ name: "A" }, { name: "a" }]) }, null);
    assert.match(bad.error, /Two sections are named a/);
    const started = gs.startTournament({ ...at, format: "arena", cutoff: "17:30", timeControl: "G/30;+30",
      sections: JSON.stringify([{ name: "Classical", timeControl: "G/30;+30", rated: true }, { name: "Blood Pact", timeControl: "G/15;+15 against G/30;+30", rated: true, pact: true }]) }, null);
    assert.equal(started.ok, true, JSON.stringify(started));
    const t = gs.tournament("knightmare-arena-classical/2026-10-31", true);
    eq(t.sections, [{ name: "Classical", timeControl: "G/30;+30", rated: true }, { name: "Blood Pact", timeControl: "G/15;+15 against G/30;+30", rated: false, pact: true }]);
    eq([t.format, t.cutoff, t.timeControl, t.players.length, t.games, t.queue], ["arena", "17:30", "G/30;+30", 2, [], []]);
    // A Blood Pact game by hand needs one player halving their clock; the desk can change who.
    assert.match(gs.arenaPair({ ...at, games: JSON.stringify([{ white: "11111111", black: "22222222", section: "Blood Pact" }]) }).message, /Started 0 of 1 game\(s\).*nobody halves their clock/);
    assert.equal(gs.arenaPair({ ...at, games: JSON.stringify([{ white: "11111111", black: "22222222", section: "Blood Pact", blackPact: true }]) }).ok, true);
    if (store === "sheet") eq(heading(sheets.Arena).slice(-3), ["Section", "White report", "Black report"]);
    eq([rows("Arena")[0].Section, rows("Arena")[0].Game, rows("Arena")[0]["White pact"], rows("Arena")[0]["Black pact"]], ["Blood Pact", "1", "", "yes"]);
    assert.equal(gs.arenaPact({ ...at, game: "1", who: "white" }).ok, true);
    eq([rows("Arena")[0]["White pact"], rows("Arena")[0]["Black pact"]], ["yes", ""]);
    assert.match(gs.arenaPact({ ...at, game: "1", who: "both" }).error, /Which side/);
    assert.equal(gs.arenaResult({ ...at, game: "1", result: "1-0" }).ok, true);
    assert.equal(gs.ledgerFor("knightmare-arena-classical/2026-10-31").games, 0, "a Blood Pact game isn't rated");
    assert.equal(gs.arenaPair({ ...at, games: JSON.stringify([{ white: "11111111", black: "22222222", section: "Classical", whitePact: true }]) }).ok, true);
    eq([rows("Arena")[1].Section, rows("Arena")[1].Game, rows("Arena")[1]["White pact"]], ["Classical", "2", ""], "no pact outside the Blood Pact section");
  });
}

test("five wrong TD passwords in an hour lock out new devices, but never a device that signed in before", () => {
  const { gs, cache, props } = load({});
  props.TD_PASSWORD = "right";
  const mine = "a1b2c3d4-0000-4000-8000-000000000001";
  assert.equal(gs.checkPassword("right", mine), null, "signing in trusts the device");
  assert.deepEqual(JSON.parse(props.TD_DEVICES), [mine]);
  for (let i = 0; i < 5; i++) assert.equal(gs.checkPassword("guess", `stranger-device-${i}-0000`), "Wrong password.");
  assert.match(gs.checkPassword("right", "new-device-0000000000"), /^Too many wrong passwords/, "new devices share one count");
  assert.ok(JSON.parse(cache.failedLogins).until <= Date.now() + 3600 * 1000, "the count clears an hour after its first");
  for (let i = 0; i < 10; i++) assert.equal(gs.checkPassword("typo", mine), "Wrong password.");
  assert.equal(gs.checkPassword("right", mine), null, "a trusted device is never locked out, even by its own typos");
});

// October 2026's club nights, which the month's fee counts.
function clubNights(gs) {
  const nights = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"];
  const event = (kind, first, label) => ({ event: "monday-club-night-at-peak", name: "Monday Club Night", kind, label, first,
    last: kind === "month" ? nights.at(-1) : first, closes: "2099-01-01T19:00:00-07:00" });
  gs.clubEvents = () => ({
    ...Object.fromEntries(nights.map((d) => [`monday-club-night-at-peak/${d}`, event("night", d, d)])),
    "monday-club-night-at-peak/2026-10": event("month", nights[0], "all Mondays in October 2026"),
  });
  let n = 0;
  gs.Utilities.getUuid = () => `token${++n}`;
}

test("a night paid by card, then the whole month: the night moves to the month and its fees, not the card fee, are credited", () => {
  const { gs, sheets } = load({ Entries: [] });
  clubNights(gs);
  const register = (date) => gs.register({ event: "monday-club-night-at-peak", date, id: "11111111", category: "Adult" }, true);
  assert.equal(register("2026-10-05").ok, true);
  assert.equal(gs.markPaid("token1", "8.19", "card").message, " paid $8.19 by card.");
  const month = register("2026-10");
  assert.match(month.message, /Due when you arrive: \$9\.50 \(adult after \$7\.50 already paid for its nights\)/);
  eq(rowsOf(sheets.Entries).map((r) => [r.Date, r.Amount, r["Rating fee"], r.Status]),
    [["2026-10-05", "7.50", "0.50", "moved to month"], ["2026-10", "17", "2", "registered"]]);
  eq(gs.entries("monday-club-night-at-peak/2026-10", true).map((e) => [e.for, e.due, e.credit, e.card]), [["Whole month", "9.50", "7.50", "10.24"]]);
  eq(gs.entries("monday-club-night-at-peak/2026-10-05", false).map((e) => e.for), ["Whole month"], "listed once, for the month");
  eq(gs.entries("monday-club-night-at-peak/2026-10", true).map((e) => e.date), ["2026-10"], "the desk gets the date, to offer a night the month");
  assert.match(register("2026-10-12").error, /already registered for the whole month/);
  assert.match(gs.withdraw("token1"), /moved to the whole month/);

  assert.equal(gs.markPaid("token2", "9.50", "cash").ok, true);
  const ledger = () => rowsOf(sheets.Payments).map((r) => [r["No."], r.Token, r.Type, r.Method, r.Received, r["Entry fee"], r["Rating fee"],
    r["Card fee"], r.Reverses]);
  eq(ledger(), [
    ["1", "token1", "payment", "card", "8.19", "7", "0.50", "0.69", ""],
    ["2", "token1", "credit", "", "0", "-7", "-0.50", "0", ""],
    ["3", "token2", "credit", "", "0", "7", "0.50", "0", ""],
    ["4", "token2", "payment", "cash", "9.50", "8", "1.50", "0", ""],
  ]);
  gs.ratedGames = () => 5;
  eq(gs.ledgerFor("monday-club-night-at-peak/2026-10"), { received: { cash: "9.50", check: "0", card: "8.19", other: "0" },
    entry: "15", rating: "2", card: "0.69", donation: "0", games: 5, uschess: "3" });

  // Marking unpaid cancels the payment with a correction; the credit stays.
  assert.equal(gs.markPaid("token2", "", "").message, " is marked unpaid.");
  eq(ledger().at(-1), ["5", "token2", "correction", "cash", "-9.50", "-8", "-1.50", "0", "4"]);
  eq(gs.entries("monday-club-night-at-peak/2026-10", true).map((e) => [e.paid, e.due]), [["", "9.50"]]);
});

// A whole month registered by 66666666, Ash, who gave ann@example.com; mail holds what was sent.
function monthOfAsh() {
  const t = load({ Entries: [] });
  clubNights(t.gs);
  t.mail = [];
  t.gs.MailApp = { sendEmail: (m) => t.mail.push(m) };
  assert.equal(t.gs.register({ event: "monday-club-night-at-peak", date: "2026-10", id: "66666666", category: "Adult",
    email: "ann@example.com" }, true).ok, true);
  t.ledger = () => rowsOf(t.sheets.Payments).map((r) => [r.Token, r.Type, r.Method, r.Received, r["Entry fee"], r["Rating fee"], r.Reverses]);
  t.public = (fields) => t.gs.doPost({ parameter: { action: "toNight", event: "monday-club-night-at-peak", date: "2026-10-12",
    id: "66666666", last: "Ash", email: "ann@example.com", ...fields } });
  return t;
}

test("a player switches an unpaid whole month to one night from the Entries page, and gets the night's withdraw link", () => {
  const { gs, sheets, mail } = monthOfAsh();
  const post = (fields) => gs.doPost({ parameter: { action: "toNight", event: "monday-club-night-at-peak", date: "2026-10-12",
    id: "66666666", last: "Ash", email: "ann@example.com", ...fields } });
  assert.match(post({ last: "Birch" }).error, /last name doesn't match/);
  assert.match(post({ email: "other@example.com" }).error, /email doesn't match/);
  assert.match(post({ date: "2026-11-02" }).error, /isn't one of the month's nights/);
  const switched = post({ email: "ANN@example.com" });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.match(switched.message, /Due when you arrive: \$7\.50/);
  eq(rowsOf(sheets.Entries).map((r) => [r.Date, r.Amount, r["Rating fee"], r.Status, r.Email, r.Token]),
    [["2026-10", "17", "2", "moved to night", "ann@example.com", "token1"],
      ["2026-10-12", "7.50", "0.50", "registered", "ann@example.com", "token2"]]);
  assert.match(mail.at(-1).body, /withdraw=token2/);
  eq(gs.entries("monday-club-night-at-peak/2026-10-19", false), [], "off the month's other nights");
  assert.match(gs.withdraw("token1"), /switched to one night/);
  assert.match(post({}).error, /No whole-month registration/, "once is all");
  eq(rowsOf(sheets.Payments), [], "nothing paid, so nothing to move");
});

test("a paid month: the player is sent to the TD, who switches it, moving what was paid, and refunds the rest", () => {
  const { gs, sheets, ledger, public: post } = monthOfAsh();
  assert.equal(gs.markPaid("token1", "17", "cash").ok, true);
  assert.match(post({}).error, /has paid for the month, so the TD switches it/);
  // From the desk, which sends the entry's token and its sign-in, not the player's ID.
  const switched = gs.doPost({ parameter: { action: "toNight", event: "monday-club-night-at-peak", date: "2026-10-12", token: "token1",
    password: "sheet" } });
  assert.match(switched.message, /\$9\.50 of what was paid for the month is to be refunded/);
  eq(rowsOf(sheets.Entries).map((r) => [r.Status, r["Added by"]]), [["moved to night", "TD"], ["registered", "TD"]]);
  const night = () => gs.entries("monday-club-night-at-peak/2026-10-12", true).map((e) => [e.due, e.over, e.refundable, e.refunded]);
  eq(night(), [["0", "9.50", "17", ""]]);
  assert.match(gs.refund("token2", "17.01", "cash", null).error, /At most \$17 can be refunded/);
  assert.equal(gs.refund("token2", "9.50", "cash", { name: "Ben Bishop" }).message, "Ann Ash was refunded $9.50 by cash.");
  eq(night(), [["0", "", "7.50", "9.50"]]);
  eq(ledger(), [
    ["token1", "payment", "cash", "17", "15", "2", ""],
    ["token1", "credit", "", "0", "-15", "-2", ""],
    ["token2", "credit", "", "0", "15", "2", ""],
    ["token2", "refund", "cash", "-9.50", "-8", "-1.50", ""],
  ], "the rating fees for the nights not played go back first");
  assert.equal(rowsOf(sheets.Payments).at(-1).Note, "By Ben Bishop");
  eq(gs.ledgerFor("monday-club-night-at-peak/2026-10").received.cash, "7.50");
});

test("what's paid over the fee can be a donation, kept out of the fees and refunds and credited to the player", () => {
  const { gs, sheets } = monthOfAsh();
  const gifts = () => rowsOf(sheets.Payments).map((r) => [r.Type, r.Received, r["Entry fee"], r["Rating fee"], r.Donation, r.Name, r["US Chess ID"]]);
  assert.equal(gs.markPaid("token1", "22", "cash", true).message, "Ann Ash paid $22 by cash, with a $5 donation.");
  eq(gifts(), [["payment", "22", "15", "2", "5", "Ann Ash", "66666666"]]);
  eq(gs.entries("monday-club-night-at-peak/2026-10", true).map((e) => [e.due, e.donation, e.over, e.refundable]), [["17", "5", "", "17"]]);
  eq(gs.ledgerFor("monday-club-night-at-peak/2026-10").donation, "5");
  gs.markPaid("token1", "", "");
  eq(gifts().at(-1), ["correction", "-22", "-15", "-2", "-5", "Ann Ash", "66666666"], "marking unpaid takes the donation back too");
  assert.equal(gs.markPaid("token1", "17", "cash", true).message, "Ann Ash paid $17 by cash.", "nothing over, nothing donated");
  eq(gs.ledgerFor("monday-club-night-at-peak/2026-10").donation, "0");
});

test("a payment short of the fee leaves the rest owed, which a later payment, by any method, collects", () => {
  const { gs, sheets, ledger } = monthOfAsh();
  const owed = () => gs.entries("monday-club-night-at-peak/2026-10", true).map((e) => [e.paid, e.paidBy, e.due, e.balance, e.card]);
  assert.equal(gs.markPaid("token1", "10", "cash").message, "Ann Ash paid $10 by cash. $7 is still due.");
  eq(owed(), [["10", "cash", "17", "7", "7.68"]]);
  assert.equal(gs.markPaid("token1", "7.68", "card").message, "Ann Ash paid $7.68 by card.");
  eq(owed(), [["17.68", "cash, card", "17", "0", ""]]);
  eq(ledger(), [["token1", "payment", "cash", "10", "8", "2", ""], ["token1", "payment", "card", "7.68", "7", "0", ""]],
    "the rating fee came out of the first payment");
  assert.equal(gs.markPaid("token1", "", "").ok, true);
  eq(owed(), [["", "", "17", "17", "17.93"]], "marking unpaid cancels both");
  eq(rowsOf(sheets.Entries).map((r) => r["Paid on"]), [""]);
});

test("a donation apart from any entry, from a contact or anonymous, and each contact's total with what they gave over their fees", () => {
  const { gs, sheets } = monthOfAsh();
  gs.markPaid("token1", "22", "cash", true);
  assert.equal(gs.saveContact({ fields: JSON.stringify({ Name: "Ann Ash", "US Chess ID": "66666666" }) }).ok, true);
  const ash = () => gs.contacts().contacts.find((c) => c.Name === "Ann Ash");
  eq(ash().donated, "5", "found by US Chess ID");
  assert.equal(gs.giveDonation({ contact: ash().id, amount: "20", by: "check", note: "Check 101" }, { name: "Ben Bishop" }).message,
    "Recorded a $20 donation from Ann Ash.");
  const row = rowsOf(sheets.Payments).at(-1);
  eq([row.Type, row.Token, row.Event, row.Name, row["US Chess ID"], row.Method, row.Received, row.Donation, row["Entry fee"], row.Note],
    ["donation", ash().id, "", "Ann Ash", "66666666", "check", "20", "20", "0", "Check 101. By Ben Bishop"]);
  eq(ash().donated, "25");
  assert.match(gs.giveDonation({ amount: "17.42", by: "card" }, null).message, /^Recorded a \$16\.50 donation from Anonymous, after the card fee\.$/);
  eq(gs.contacts().anonymous, "16.50");
  assert.equal(gs.giveDonation({ contact: ash().id, amount: "-5", by: "check" }, null).message, "Took $5 off Ann Ash's donations.");
  eq(rowsOf(sheets.Payments).at(-1).Type, "correction");
  eq(ash().donated, "20");
  eq(gs.ledgerFor("monday-club-night-at-peak/2026-10").donation, "5", "an event's money leaves out donations apart from it");
  assert.match(gs.giveDonation({ amount: "0" }, null).error, /Enter the amount/);
  assert.match(gs.giveDonation({ contact: "gone", amount: "5" }, null).error, /no longer in the Sheet/);
  assert.equal(gs.doPost({ parameter: { action: "donation", password: "sheet", amount: "1" } }).ok, true, "the desk's action");
});

test("a discount lowers what's due, up to the whole fee, and a refund after one can be undone by marking unpaid", () => {
  const { gs, sheets, ledger } = monthOfAsh();
  const due = () => gs.entries("monday-club-night-at-peak/2026-10", true).map((e) => [e.due, e.discount, e.discountNote, e.over]);
  assert.equal(gs.discount("token1", "5", "Hardship", { name: "Ben Bishop" }).message, "Ann Ash has a $5 discount.");
  eq(due(), [["12", "5", "Hardship, by Ben Bishop", ""]]);
  assert.match(gs.discount("token1", "17.50", "", null).error, /can't be more than the fee, \$17/);
  assert.equal(gs.markPaid("token1", "12", "card").ok, true);
  assert.equal(gs.discount("token1", "17", "Scholarship", null).ok, true);
  eq(due(), [["0", "17", "Scholarship", "11.21"]], "what was paid, less the card fee, is now over the fee");
  assert.equal(gs.refund("token1", "11.21", "card", null).ok, true);
  assert.equal(gs.markPaid("token1", "", "").ok, true);
  eq(ledger().slice(-2).map((x) => [x[1], x[3], x[6]]), [["correction", "-12", "1"], ["correction", "11.21", "2"]],
    "marking unpaid cancels the payment and the refund");
  assert.equal(gs.discount("token1", "", "", null).message, "Ann Ash's discount is removed.");
  eq(rowsOf(sheets.Entries).map((r) => [r.Discount, r["Discount note"]]), [["", ""]]);
});

test("a payment covers the rating fee first, and a card payment's card fee is what the card added", () => {
  const { gs } = load({ Entries: [] });
  const card = { percent: 2.5, fixed: 0.5 };
  eq(gs.allocate(1742, "card", 150, 0, card), { "Entry fee": 1500, "Rating fee": 150, "Card fee": 92 });
  eq(gs.allocate(100, "cash", 150, 0, card), { "Entry fee": 0, "Rating fee": 100, "Card fee": 0 }, "a waiver short of the rating fee");
  eq(gs.allocate(1500, "check", null, 0, card), { "Entry fee": 1500, "Rating fee": 0, "Card fee": 0 }, "no rating fee known");
  eq(gs.allocate(40, "card", 150, 0, card), { "Entry fee": 0, "Rating fee": 0, "Card fee": 40 });
});

for (const store of STORES) {
  test(`a quad started before sections, with none of their columns, runs as before (${store})`, () => {
    const key = "alley-cat-quad/2026-10-10";
    const players = [...Array(8)].map((_, i) => [key, String(i + 1), `9000000${i + 1}`, `P${i + 1}`, String(2000 - i * 100), ""]);
    const round1 = Pairing.pairQuadRound(players.map((p) => ({ id: p[2], number: Number(p[1]) })), 1).games
      .map((g) => [key, "1", String(g.board), g.white, g.black, "1-0", "", "2026-10-10 10:05"]);
    const { gs, sheets, rows } = load({
      Tournaments: [["Key", "Event", "Name", "Format", "Rounds", "Status", "Started", "Coin", "Finished"],
        [key, "alley-cat-quad", "Alley Cat Quad", "quad", "3", "running", "2026-10-10 10:00", "white", ""]],
      Players: [["Key", "No.", "US Chess ID", "Name", "Rating", "Out from round"], ...players],
      Rounds: [["Key", "Round", "Board", "White", "Black", "Result", "Bye points", "Posted"], ...round1],
    }, {}, store);
    const t = gs.tournament(key, true);
    eq(t.sections, []);
    assert.ok(t.players.every((p) => p.section === ""));
    assert.equal(t.rounds[0].games.length, 4);
    // The new desk pairs round 2 as the old one did: boards 1 to 4 through both quads, no section.
    const parts = Pairing.pairSections({ ...t, rounds: t.rounds });
    const games = parts.flatMap((s) => s.games.map((g) => ({ ...g, section: s.section })));
    eq(games.map((g) => g.board), [1, 2, 3, 4]);
    eq(games, Pairing.pairQuadRound(t.players, 2).games.map((g) => ({ ...g, section: "" })));
    assert.equal(gs.saveRound({ event: "alley-cat-quad", date: "2026-10-10", number: "2", post: "yes", games: JSON.stringify(games), byes: "[]" }).ok, true);
    // The old desk sends no section; the new one sends "".
    assert.equal(gs.saveResult({ event: "alley-cat-quad", date: "2026-10-10", number: "2", board: "3", result: "0-1" }).ok, true);
    assert.equal(gs.saveResult({ event: "alley-cat-quad", date: "2026-10-10", number: "2", board: "4", section: "", result: "1-0" }).ok, true);
    const r2 = rows("Rounds").filter((r) => r.Round === "2");
    eq(r2.map((r) => [r.Board, r.Result, r.Section]), [["1", "", ""], ["2", "", ""], ["3", "0-1", ""], ["4", "1-0", ""]]);
    if (store === "sheet") {
      eq(heading(sheets.Players), ["Key", "No.", "US Chess ID", "Name", "Rating", "Out from round", "Section", "Floor", "Prior games", "Prior sweep",
        "State", "Byes"]);
      eq(heading(sheets.Tournaments).slice(-5), ["Cutoff", "Sections", "TD", "Round dates", "Time control"]);
    }
    // Its rows are where they were; only headings were added.
    assert.equal(rows("Players")[4]["No."], "5");
    eq(gs.sectionsByKey(), {});
  });
}

for (const store of STORES) {
  test(`a Swiss in two sections: placed by rating, moved up, paired, posted, and scored by section (${store})`, () => {
    const { gs, props, rows } = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    gs.clubEvents = () => ({ "classic/2026-11-07": { event: "classic", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry" } });
    const entrants = [["11111111", "Ann", "1900"], ["22222222", "Ben", "1700"], ["33333333", "Cal", "1450"], ["44444444", "Dee", "1300"],
      ["55555555", "Eve", "1200P"], ["66666666", "Fay", ""]].map(([id, name, rating]) => ({ id, name, rating, out: "" }));
    let registered = entrants.slice(0, 5);
    gs.entries = () => registered;
    const p = { event: "classic", date: "2026-11-07" };
    assert.match(gs.startTournament({ ...p, format: "swiss", rounds: "3", coin: "white", sections: '[{"name":"Open"},{"name":"Open"}]' }).error, /Two sections/);
    assert.match(gs.startTournament({ ...p, format: "swiss", rounds: "3", coin: "white", sections: '[{"name":"Open"},{"name":"U1400","under":"14x"}]' }).error, /rating limit/);
    const started = gs.startTournament({ ...p, format: "swiss", rounds: "3", coin: "white", sections: '[{"name":"Open"},{"name":"Under 1400","under":1400}]' });
    assert.equal(started.ok, true, JSON.stringify(started));
    const sectionOf = () => Object.fromEntries(rows("Players").map((r) => [r.Name, r.Section]));
    eq(sectionOf(), { Ann: "Open", Ben: "Open", Cal: "Open", Dee: "Under 1400", Eve: "Under 1400" });
    registered = entrants;
    gs.syncPlayers("classic/2026-11-07");
    assert.equal(sectionOf().Fay, "Under 1400", "an unrated late entrant goes to the lowest section");
    // Each player's floor and prior record from US Chess, kept two weeks in the registration Sheet.
    eq(rows("Players").map((r) => [r.Name, r.Floor, r["Prior games"], r["Prior sweep"]]),
      [["Ann", "1700", "3", ""], ["Ben", "", "0", ""], ["Cal", "", "0", ""], ["Dee", "", "0", ""], ["Eve", "100", "2", "losses"], ["Fay", "", "0", ""]]);
    eq(JSON.parse(props["player:55555555"]), { Floor: "100", "Prior games": "2", "Prior sweep": "losses", State: "CO",
      "Record checked on": new Date().toISOString().slice(0, 10) });
    const usChess = () => gs.fetched.filter((url) => url.includes("/members/")).length;
    const asked = usChess();
    assert.equal(asked, 12);
    gs.priorRecords(["11111111"]);
    assert.equal(usChess(), asked, "a record checked today isn't asked for again");
    eq(gs.tournament("classic/2026-11-07", true).players.find((x) => x.id === "55555555"), { id: "55555555", number: 5, name: "Eve",
      rating: 1200, out: null, section: "Under 1400", floor: 100, games: 2, sweep: "losses", state: "CO" });
    assert.match(gs.setSection({ ...p, id: "33333333", section: "Under 1400" }).error, /play up, not down/);
    assert.equal(gs.setSection({ ...p, id: "55555555", section: "Open" }).ok, true);
    const t = gs.tournament("classic/2026-11-07", true);
    eq(t.sections, [{ name: "Open" }, { name: "Under 1400", under: 1400 }]);
    const parts = Pairing.pairSections(t, { coin: t.coin });
    const games = parts.flatMap((s) => s.games.map((g) => ({ ...g, section: s.section })));
    const byes = parts.flatMap((s) => s.byes.map((b) => ({ ...b, section: s.section })));
    // Saved, not posted: a section change deletes it, to be paired again.
    gs.saveRound({ ...p, number: "1", post: "no", games: JSON.stringify(games), byes: JSON.stringify(byes) });
    assert.equal(gs.setSection({ ...p, id: "55555555", section: "Under 1400" }).ok, true);
    assert.equal(rows("Rounds").length, 0);
    gs.setSection({ ...p, id: "55555555", section: "Open" });
    gs.saveRound({ ...p, number: "1", post: "yes", games: JSON.stringify(games), byes: JSON.stringify(byes) });
    assert.match(gs.setSection({ ...p, id: "55555555", section: "Under 1400" }).error, /has had a game or a full-point bye in Open/);
    assert.match(gs.setSections({ ...p, sections: '[{"name":"Open"}]' }).error, /posted/);
    const lines = rows("Rounds");
    eq(lines.filter((r) => r.Black).map((r) => [r.Section, r.Board]), [["Open", "1"], ["Open", "2"], ["Under 1400", "1"]]);
    eq(lines.filter((r) => !r.Black).length, 0);
    // Board 1 is in both sections; the result goes to the one named.
    assert.equal(gs.saveResult({ ...p, number: "1", board: "1", section: "Under 1400", result: "0-1" }).ok, true);
    eq(rows("Rounds").filter((r) => r.Black).map((r) => r.Result), ["", "", "0-1"]);
    const back = gs.tournament("classic/2026-11-07", false);
    eq(back.rounds[0].games.map((g) => [g.section, g.board]), [["Open", 1], ["Under 1400", 1], ["Open", 2]]);
    eq(back.rounds[0].games.filter((g) => g.section === "Open").flatMap((g) => [g.white, g.black]).sort(), ["11111111", "22222222", "33333333", "55555555"]);
    assert.equal(gs.sectionsByKey()["classic/2026-11-07"]["44444444"], "Under 1400");
  });
}

for (const store of STORES) {
  test(`a late entrant gets a half-point bye for the first posted round that offers one (28K), can be moved until their first game, and can have it made unplayed (${store})`, () => {
    const { gs, rows } = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    const key = "classic/2026-11-07";
    const event = { event: "classic", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry" };
    gs.clubEvents = () => ({ [key]: event });
    let registered = [["11111111", "Ann", "1900"], ["22222222", "Ben", "1700"], ["33333333", "Cal", "1300"], ["44444444", "Dee", "1200"]]
      .map(([id, name, rating]) => ({ id, name, rating, out: "" }));
    gs.entries = () => registered;
    const p = { event: "classic", date: "2026-11-07" };
    gs.startTournament({ ...p, format: "swiss", rounds: "4", coin: "white", sections: '[{"name":"Open"},{"name":"Under 1400","under":1400}]' });
    const game = (white, black, section, board = 1) => ({ board, white, black, section, result: "1-0" });
    for (const n of [1, 2, 3]) {
      gs.saveRound({ ...p, number: String(n), post: "yes", byes: "[]",
        games: JSON.stringify([game("11111111", "22222222", "Open"), game("33333333", "44444444", "Under 1400")]) });
    }
    const byesOf = (id) => rows("Rounds").filter((r) => r.White === id && !r.Black).map((r) => [r.Round, r.Section, r["Bye kind"], r["Bye points"]]);
    // One, as the event allows, in the first round that offers one; the others are unplayed.
    registered = [...registered, { id: "55555555", name: "Eve", rating: "1250", out: "" }];
    assert.match(gs.syncPlayers(key).message, /^Added 1 player\(s\)\. A late entrant has a half-point bye for the first round they missed that offers one \(28K\)/);
    eq(byesOf("55555555"), [["1", "Under 1400", "half", "0.5"]]);
    const eve = gs.tournament(key, true);
    eq(Pairing.standings(Pairing.sections(eve).find((s) => s.name === "Under 1400")).find((r) => r.id === "55555555").score, 0.5);
    assert.equal(gs.saveByeKind({ ...p, number: "2", id: "55555555", kind: "half", section: "Under 1400" }).error,
      "Eve already has or asked for a half-point bye, in round 1, and the event allows one per player.");
    // Without a page announcing byes, only the first half's rounds have them (22C1).
    assert.equal(gs.saveByeKind({ ...p, number: "1", id: "55555555", kind: "unplayed", section: "Under 1400" }).ok, true);
    assert.match(gs.saveByeKind({ ...p, number: "3", id: "55555555", kind: "half", section: "Under 1400" }).error, /\(22C1\), and round 3 isn't one\.$/);
    assert.equal(gs.saveByeKind({ ...p, number: "2", id: "55555555", kind: "half", section: "Under 1400" }).ok, true);
    // A late entrant who asked for a bye to come has had their one.
    registered = [...registered, { id: "77777777", name: "Gus", rating: "1000", out: "", byes: ["4"] }];
    gs.clubEvents = () => ({ [key]: { ...event, page: "/events/classic/" } });
    gs.syncPlayers(key);
    eq(byesOf("77777777"), []);
    registered = [...registered, { id: "66666666", name: "Fay", rating: "1100", out: "" }];
    gs.syncPlayers(key);
    eq(byesOf("66666666").map((b) => b[0]), ["1"]);
    // Before their first game, a late entrant can play up, and their byes go with them; never down.
    assert.match(gs.setSection({ ...p, id: "11111111", section: "Under 1400" }).error, /play up, not down/);
    assert.equal(gs.setSection({ ...p, id: "66666666", section: "Open" }).ok, true);
    eq(byesOf("66666666").map((b) => b[1]), ["Open"]);
    assert.match(gs.setSection({ ...p, id: "33333333", section: "Open" }).error, /has had a game or a full-point bye in Under 1400/);
    // Revoked on request, a bye is unplayed, and scores nothing.
    assert.equal(gs.saveByeKind({ ...p, number: "1", id: "66666666", kind: "unplayed", section: "Open" }).ok, true);
    eq(byesOf("66666666"), [["1", "Open", "unplayed", "0"]]);
    // Once they've played, or had a full-point bye, they stay.
    gs.saveRound({ ...p, number: "4", post: "yes", byes: JSON.stringify([{ id: "55555555", points: 1, kind: "bye", section: "Under 1400" }]),
      games: JSON.stringify([game("11111111", "66666666", "Open"), game("22222222", "33333333", "Open", 2)]) });
    assert.match(gs.setSection({ ...p, id: "66666666", section: "Under 1400" }).error, /has had a game or a full-point bye in Open/);
    assert.match(gs.setSection({ ...p, id: "55555555", section: "Open" }).error, /has had a game or a full-point bye in Under 1400/);
    // A quad's late entrants get none: the table fixes its games.
    const quad = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    quad.gs.clubEvents = () => ({ "quad/2026-11-14": { event: "quad", name: "Quad", label: "Saturday", kind: "entry", page: "/events/quad/" } });
    let entered = registered.slice(0, 4);
    quad.gs.entries = () => entered;
    quad.gs.startTournament({ event: "quad", date: "2026-11-14", format: "quad", rounds: "3", coin: "white" });
    quad.gs.saveRound({ event: "quad", date: "2026-11-14", number: "1", post: "yes", byes: "[]", games: JSON.stringify([game("11111111", "22222222", "Quad 1")]) });
    entered = registered;
    quad.gs.syncPlayers("quad/2026-11-14");
    eq(quad.rows("Rounds").filter((r) => !r.Black), []);
  });
}

for (const store of STORES) {
  test(`sections are renamed and reordered at any time, with each player's and pairing's section following its name (${store})`, () => {
    const { gs, rows } = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    const key = "classic/2026-11-07";
    gs.clubEvents = () => ({ [key]: { event: "classic", name: "Classic", label: "Saturday", kind: "entry", page: "/events/classic/" } });
    gs.entries = () => [["11111111", "Ann", "1900"], ["22222222", "Ben", "1700"], ["33333333", "Cal", "1300"], ["44444444", "Dee", "1200"]]
      .map(([id, name, rating]) => ({ id, name, rating, out: "" }));
    const p = { event: "classic", date: "2026-11-07" };
    gs.startTournament({ ...p, format: "swiss", rounds: "3", coin: "white", sections: '[{"name":"Open"},{"name":"Under 1400","under":1400}]' });
    gs.saveRound({ ...p, number: "1", post: "yes", byes: "[]", games: JSON.stringify([{ board: 1, white: "11111111", black: "22222222", section: "Open" },
      { board: 1, white: "33333333", black: "44444444", section: "Under 1400" }]) });
    gs.addExtraSection({ ...p, name: "Extra", rounds: "1", players: '["11111111","33333333"]' });
    const names = (list) => gs.setSectionNames({ ...p, sections: JSON.stringify(list.map(([from, name]) => ({ from, name }))) });
    assert.equal(names([["Open", "Open"], ["Under 1400", "open"], ["Extra", "Extra"]]).error, "Two sections are named open.");
    assert.equal(names([["Open", "Open"], ["Extra", "Extra"]]).error, "The sections changed since the desk loaded them. Refresh and try again.");
    assert.equal(names([["Open", ""], ["Under 1400", "U1400"], ["Extra", "Extra"]]).error, "Each section needs a name of up to 30 characters.");
    assert.equal(names([["Extra", "Blitz"], ["Under 1400", " Reserve  U1400 "], ["Open", "Championship"]]).message, "Sections: Blitz, Reserve U1400, Championship.");
    eq(JSON.parse(rows("Tournaments")[0].Sections), [{ name: "Blitz", extra: true, first: 2, last: 2, players: ["11111111", "33333333"] },
      { name: "Reserve U1400", under: 1400, last: 3 }, { name: "Championship", last: 3 }]);
    eq(rows("Players").map((r) => [r.Name, r.Section]), [["Ann", "Championship"], ["Ben", "Championship"], ["Cal", "Reserve U1400"], ["Dee", "Reserve U1400"]]);
    eq(rows("Rounds").map((r) => r.Section), ["Championship", "Reserve U1400"]);
    const t = gs.tournament(key, true);
    eq(Pairing.sections(t).map((s) => [s.name, s.players.length, s.rounds.length]), [["Blitz", 2, 0], ["Reserve U1400", 2, 1], ["Championship", 2, 1]]);
    assert.equal(gs.saveResult({ ...p, number: "1", board: "1", section: "Reserve U1400", result: "1-0" }).ok, true);
  });
}

for (const store of STORES) {
  test(`full-point byes the script refuses whoever asks: two in a section's round (28L1), a second for a player (28L3), and in a quad or an extra games section (${store})`, () => {
    const { gs } = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    const key = "classic/2026-11-07";
    gs.clubEvents = () => ({ [key]: { event: "classic", name: "Classic", label: "Saturday", kind: "entry", page: "/events/classic/" } });
    gs.entries = () => [["11111111", "Ann", "1900"], ["22222222", "Ben", "1700"], ["33333333", "Cal", "1500"]].map(([id, name, rating]) => ({ id, name, rating, out: "" }));
    const p = { event: "classic", date: "2026-11-07" };
    gs.startTournament({ ...p, format: "swiss", rounds: "3", coin: "white", sections: '[{"name":"Open"}]' });
    const round = (number, games, byes) => gs.saveRound({ ...p, number: String(number), post: "yes",
      games: JSON.stringify(games.map(([white, black], i) => ({ board: i + 1, white, black, section: "Open", result: "" }))),
      byes: JSON.stringify(byes.map(([id, kind]) => ({ id, kind, points: 1, section: "Open" }))) });
    assert.equal(round(1, [], [["11111111", "bye"], ["22222222", "bye"], ["33333333", "unplayed"]]).error,
      "Only the odd player has a full-point bye, one in each section's round (28L1).");
    assert.equal(round(1, [["11111111", "22222222"]], [["33333333", "bye"]]).ok, true);
    assert.equal(gs.tournament(key, true).rounds[0].byes[0].points, 1);
    assert.equal(round(2, [["11111111", "22222222"]], [["33333333", "unplayed"]]).ok, true);
    assert.equal(gs.tournament(key, true).rounds[1].byes[0].points, 0, "the points follow the kind, whatever the desk sends");
    assert.equal(gs.saveByeKind({ ...p, number: "2", id: "33333333", kind: "bye", section: "Open" }).error,
      "Cal had a full-point bye in round 1, and 28L3 allows one.");
    assert.equal(gs.addExtraSection({ ...p, name: "Extra", rounds: "1", players: '["11111111","22222222","33333333"]' }).ok, true);
    assert.equal(gs.saveRound({ ...p, number: "4", post: "yes", games: "[]", byes: JSON.stringify([{ id: "11111111", kind: "bye", points: 1, section: "Extra" }]) }).error,
      "An extra games section gives no full-point bye (28M4); make the round unplayed.");
  });
}

for (const store of STORES) {
  test(`an extra games section: the tournament's players again, from the next round, with rounds of its own (${store})`, () => {
    const { gs, rows } = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    gs.clubEvents = () => ({ "classic/2026-11-07": { event: "classic", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry",
      page: "/events/classic/" } });
    let registered = [["11111111", "Ann", "1900"], ["22222222", "Ben", "1700"], ["33333333", "Cal", "1500"], ["44444444", "Dee", "1300"]]
      .map(([id, name, rating]) => ({ id, name, rating, out: "" }));
    gs.entries = () => registered;
    const p = { event: "classic", date: "2026-11-07" };
    gs.startTournament({ ...p, format: "swiss", rounds: "2", coin: "white", sections: '[{"name":"Open"}]', timeControl: "G/30;d5" });
    assert.equal(gs.tournament("classic/2026-11-07", true).timeControl, "G/30;d5", "Start keeps the time control the desk read from the listing");
    const game = (round, board, white, black, section, result) => ({ board, white, black, section, result });
    for (const [n, games] of [[1, [game(1, 1, "11111111", "33333333", "Open"), game(1, 2, "44444444", "22222222", "Open")]],
      [2, [game(2, 1, "22222222", "11111111", "Open"), game(2, 2, "33333333", "44444444", "Open")]]]) {
      gs.saveRound({ ...p, number: String(n), post: "yes", games: JSON.stringify(games), byes: "[]" });
    }
    const all = JSON.stringify(["11111111", "22222222", "33333333", "44444444"]);
    assert.match(gs.addExtraSection({ ...p, name: "", rounds: "1", players: all }).error, /Name the section/);
    assert.match(gs.addExtraSection({ ...p, name: "Extra games", rounds: "x", players: all }).error, /number from 1 to 99/);
    assert.match(gs.addExtraSection({ ...p, name: "open", rounds: "1", players: all }).error, /already a section named open/);
    assert.match(gs.addExtraSection({ ...p, name: "Extra games", rounds: "1", players: '["11111111","99999999"]' }).error, /at least two/);
    const added = gs.addExtraSection({ ...p, name: "Extra games", rounds: "2", players: all });
    assert.equal(added.message, "Extra games: 4 players, 2 rounds from round 3.");
    const info = () => rows("Tournaments")[0];
    eq([JSON.parse(info().Sections), info().Rounds], [[{ name: "Open", last: 2 },
      { name: "Extra games", extra: true, first: 3, last: 4, players: JSON.parse(all) }], "4"]);
    const t = gs.tournament("classic/2026-11-07", true);
    eq(Pairing.sections(t).map((s) => [s.name, s.rounds.length, s.players.length]), [["Open", 2, 4], ["Extra games", 0, 4]]);
    // Each section's rounds change on their own, never below those paired.
    assert.match(gs.setRounds({ ...p, rounds: "3" }).error, /Which section/);
    assert.match(gs.setRounds({ ...p, section: "Open", rounds: "1" }).error, /Open has 2 rounds paired/);
    assert.equal(gs.setRounds({ ...p, section: "Extra games", rounds: "1" }).message, "Extra games plays 1 round.");
    eq([JSON.parse(info().Sections)[1].last, info().Rounds], [3, "3"]);
    const extra = Pairing.pairSections(gs.tournament("classic/2026-11-07", true));
    eq(extra.map((s) => s.section), ["Extra games"]);
    gs.saveRound({ ...p, number: "3", post: "yes", games: JSON.stringify(extra[0].games.map((g) => ({ ...g, section: "Extra games" }))), byes: "[]" });
    // Nobody is moved into it, nor placed in it when they enter late.
    assert.match(gs.setSection({ ...p, id: "11111111", section: "Extra games" }).error, /No such section/);
    registered = [...registered, { id: "55555555", name: "Eve", rating: "1200", out: "" }];
    gs.syncPlayers("classic/2026-11-07");
    assert.equal(rows("Players").find((r) => r.Name === "Eve").Section, "Open");
    eq(gs.sectionsByKey(), {}, "the Entries page doesn't name a section where there's one besides the extra");
    // A player's bye is told apart by section.
    gs.saveRound({ ...p, number: "2", post: "yes", games: JSON.stringify([game(2, 1, "22222222", "11111111", "Open")]),
      byes: JSON.stringify([{ id: "33333333", points: 0, kind: "unplayed", section: "Open" }, { id: "44444444", points: 0, kind: "unplayed", section: "Open" }]) });
    assert.equal(gs.saveByeKind({ ...p, number: "2", id: "33333333", kind: "half", section: "Extra games" }).error, "That round isn't paired yet.");
    assert.equal(gs.saveByeKind({ ...p, number: "2", id: "22222222", kind: "half", section: "Open" }).error, "That player has a game that round, not a bye.");
    assert.equal(gs.saveByeKind({ ...p, number: "2", id: "33333333", kind: "half", section: "Open" }).error,
      "Cal didn't ask for a last-round bye before round 1, so they can't have one (22C4).", "Open's last round is its own");
    assert.equal(gs.saveByeKind({ ...p, number: "2", id: "33333333", kind: "zero", section: "Open" }).ok, true);
    // One added by mistake comes off; one with posted pairings stays.
    assert.match(gs.dropExtraSection({ ...p, section: "Extra games" }).error, /posted pairings/);
    assert.equal(gs.addExtraSection({ ...p, name: "Blitz", rounds: "2", players: all }).message, "Blitz: 4 players, 2 rounds from round 4.");
    assert.equal(info().Rounds, "5");
    assert.equal(gs.dropExtraSection({ ...p, section: "Blitz" }).ok, true);
    eq([JSON.parse(info().Sections).map((s) => s.name), info().Rounds], [["Open", "Extra games"], "3"]);
    assert.match(gs.addExtraSection({ event: "nothing", date: "2026-11-07", name: "X", rounds: "1", players: all }).error, /No such/);
    // The rating report's time control: the tournament's, and a section's own where it differs.
    assert.equal(gs.setTimeControl({ ...p, value: "G/70;d10" }).ok, true);
    assert.equal(gs.setTimeControl({ ...p, section: "Extra games", value: " G/30;+30 " }).ok, true);
    const set = gs.tournament("classic/2026-11-07", true);
    eq([set.timeControl, set.sections.find((s) => s.name === "Extra games").timeControl], ["G/70;d10", "G/30;+30"]);
    gs.setTimeControl({ ...p, section: "Extra games", value: "" });
    assert.equal(gs.tournament("classic/2026-11-07", true).sections.find((s) => s.name === "Extra games").timeControl, undefined);
    assert.match(gs.setTimeControl({ ...p, value: "x".repeat(41) }).error, /40 characters/);
    assert.match(gs.setTimeControl({ ...p, section: "Blitz", value: "G/5;+3" }).error, /No such section/);
  });
}

for (const store of STORES) {
  test(`quads can add an extra games section, whose rounds change though the quads' can't (${store})`, () => {
    const { gs, rows } = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    gs.clubEvents = () => ({ "quad/2026-11-14": { event: "quad", name: "Quad", label: "Saturday", kind: "entry" } });
    gs.entries = () => [...Array(8)].map((_, i) => ({ id: `9000001${i}`, name: `Q${i}`, rating: String(2000 - i * 50), out: "" }));
    const p = { event: "quad", date: "2026-11-14" };
    gs.startTournament({ ...p, format: "quad" });
    assert.match(gs.setRounds({ ...p, rounds: "4" }).error, /Only a Swiss/);
    assert.equal(gs.addExtraSection({ ...p, name: "Extra games", rounds: "2", players: '["90000010","90000014"]' }).message,
      "Extra games: 2 players, 2 rounds from round 1.");
    eq(JSON.parse(rows("Tournaments")[0].Sections).map((s) => [s.name, s.last]), [["Quad 1", 3], ["Quad 2", 3], ["Extra games", 2]]);
    assert.match(gs.setRounds({ ...p, section: "Quad 1", rounds: "4" }).error, /plays everyone/);
    assert.equal(gs.setRounds({ ...p, section: "Extra games", rounds: "4" }).ok, true);
    assert.equal(rows("Tournaments")[0].Rounds, "4");
  });
}

for (const store of STORES) {
  test(`an entrant who isn't in a quad plays in an extra games section only, added with it or later (${store})`, () => {
    const { gs, rows } = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    gs.clubEvents = () => ({ "quad/2026-10-17": { event: "quad", name: "Quad", label: "Saturday", kind: "entry" } });
    let registered = [...Array(4)].map((_, i) => ({ id: `9000001${i}`, name: `Q${i}`, rating: String(2000 - i * 50), out: "" }));
    gs.entries = () => registered;
    const p = { event: "quad", date: "2026-10-17" };
    gs.startTournament({ ...p, format: "quad" });
    const quad = Pairing.sections(gs.tournament("quad/2026-10-17", true))[0];
    for (const n of [1, 2, 3]) {
      const games = Pairing.pairQuadRound(quad.players, n).games.map((g) => ({ ...g, section: "Quad 1", result: "1-0" }));
      gs.saveRound({ ...p, number: String(n), post: "yes", games: JSON.stringify(games), byes: "[]" });
    }
    registered = [...registered, { id: "13802751", name: "Cory Kohler", rating: "1882", out: "" },
      { id: "13802752", name: "Dan Ames", rating: "1500", out: "" }, { id: "13802753", name: "Out Player", rating: "1400", out: "Expelled" }];
    assert.match(gs.addExtraSection({ ...p, name: "Extra games", rounds: "2", players: '["13802753","90000010"]' }).error, /at least two/);
    assert.equal(gs.addExtraSection({ ...p, name: "Extra games", rounds: "2", players: '["90000010","13802751"]' }).message,
      "Extra games: 2 players, 2 rounds from round 4.");
    const cory = rows("Players").find((r) => r["US Chess ID"] === "13802751");
    eq([cory["No."], cory.Name, cory.Rating, cory.Section, cory["Prior games"], cory.State], ["5", "Cory Kohler", "1882", "Extra games", "0", "CO"]);
    const parts = () => Pairing.sections(gs.tournament("quad/2026-10-17", true)).map((s) => [s.name, s.players.map((x) => x.id).sort()]);
    eq(parts(), [["Quad 1", ["90000010", "90000011", "90000012", "90000013"]], ["Extra games", ["13802751", "90000010"]]]);
    eq(Pairing.pairSections(gs.tournament("quad/2026-10-17", true)).map((s) => [s.section, s.games.flatMap((g) => [g.white, g.black]).sort()]),
      [["Extra games", ["13802751", "90000010"]]]);
    // A later entrant joins it before its next round is paired, and so does a quad's player.
    assert.equal(gs.addExtraPlayer({ ...p, section: "Extra games", id: "13802752" }).message, "Dan Ames plays in Extra games from round 4.");
    assert.equal(gs.addExtraPlayer({ ...p, section: "Extra games", id: "90000011" }).message, "Q1 plays in Extra games from round 4.");
    eq(rows("Players").map((r) => [r["No."], r.Section]).slice(4), [["5", "Extra games"], ["6", "Extra games"]]);
    eq(parts(), [["Quad 1", ["90000010", "90000011", "90000012", "90000013"]],
      ["Extra games", ["13802751", "13802752", "90000010", "90000011"]]]);
    assert.match(gs.addExtraPlayer({ ...p, section: "Extra games", id: "13802751" }).error, /in Extra games already/);
    assert.match(gs.addExtraPlayer({ ...p, section: "Extra games", id: "13802753" }).error, /Not a player or a registered entrant/);
    assert.match(gs.addExtraPlayer({ ...p, section: "Quad 1", id: "90000012" }).error, /No such extra games section/);
    // Once its last round is paired, there's nothing left to join.
    const four = Pairing.pairSections(gs.tournament("quad/2026-10-17", true))[0];
    gs.saveRound({ ...p, number: "4", post: "yes", games: JSON.stringify(four.games.map((g) => ({ ...g, section: "Extra games" }))), byes: "[]" });
    assert.equal(gs.addExtraPlayer({ ...p, section: "Extra games", id: "90000012" }).message, "Q2 plays in Extra games from round 5.");
    const five = Pairing.pairSections(gs.tournament("quad/2026-10-17", true))[0];
    eq(five.games.flatMap((g) => [g.white, g.black]).length + five.byes.length, 5);
    gs.saveRound({ ...p, number: "5", post: "no", games: JSON.stringify(five.games.map((g) => ({ ...g, section: "Extra games" }))), byes: "[]" });
    assert.match(gs.addExtraPlayer({ ...p, section: "Extra games", id: "90000013" }).error, /paired all its rounds/);
    // Syncing never puts them in a quad.
    gs.syncPlayers("quad/2026-10-17");
    eq(rows("Players").filter((r) => r.Section === "Extra games").map((r) => r.Name), ["Cory Kohler", "Dan Ames"]);
  });
}

for (const store of STORES) {
  test(`quads are sections Quad 1 and Quad 2, still numbered 1 to 8 across them (${store})`, () => {
    const { gs, rows } = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    gs.clubEvents = () => ({ "quad/2026-11-14": { event: "quad", name: "Quad", label: "Saturday", kind: "entry" } });
    gs.entries = () => [...Array(8)].map((_, i) => ({ id: `9000001${i}`, name: `Q${i}`, rating: String(2000 - i * 50), out: "" }));
    gs.startTournament({ event: "quad", date: "2026-11-14", format: "quad" });
    const players = rows("Players");
    eq(players.map((r) => r.Section), ["Quad 1", "Quad 1", "Quad 1", "Quad 1", "Quad 2", "Quad 2", "Quad 2", "Quad 2"]);
    eq(players.slice(4).map((r) => Number(r["No."])).sort(), [5, 6, 7, 8]);
    assert.equal(rows("Tournaments")[0].Sections, '[{"name":"Quad 1"},{"name":"Quad 2"}]');
    const t = gs.tournament("quad/2026-11-14", true);
    // The old desk's pairing, from numbers across the quads, still works on these rows.
    assert.equal(Pairing.pairQuadRound(t.players, 1).games.length, 4);
    eq(Pairing.pairSections(t).map((s) => [s.section, s.games.map((g) => g.board)]), [["Quad 1", [1, 2]], ["Quad 2", [1, 2]]]);
  });
}

test("a player's contact is found by first and last name, a nickname, or not at all when unclear", () => {
  const { gs } = load({ Contacts: [
    ["Name", "Email", "Phone", "Status"],
    ["Steven Garverick", "steven@example.com", "650-555-0100", "Core member"],
    ["Anthony (Tony) Whitt", "tony@example.com", "970-555-0101", "Core member"],
    ["Sam Lee", "sam1@example.com", "", "Player"],
    ["Sam Lee", "sam2@example.com", "", "Player"],
  ] });
  assert.equal(gs.contactFor("Steven Garverick").email, "steven@example.com");
  assert.equal(gs.contactFor("STEVEN GARVERICK".toLowerCase()).phone, "650-555-0100");
  assert.equal(gs.contactFor("Tony Whitt").email, "tony@example.com");
  assert.equal(gs.contactFor("Anthony Whitt").email, "tony@example.com");
  assert.equal(gs.contactFor("Sam Lee"), null, "two contacts share the name");
  assert.equal(gs.contactFor("Steven Smith"), null);
});

test("a registration fills in its contact, adds a new one, and never overwrites or guesses", () => {
  const { gs, sheets } = load({ Contacts: [
    ["Name", "Email", "Phone", "Status", "Role", "Other emails", "Other phones", "Events", "Last event", "On email list", "Notes", "US Chess ID", "ID"],
    ["Steven Garverick", "steven@example.com", "", "Contact", "", "", "", "3", "", "yes", "", "", "c1"],
    ["Anthony (Tony) Whitt", "", "970-555-0101", "Core member", "Treasurer", "", "", "", "", "", "", "", "c2"],
    ["", "nameless@example.com", "", "Sheridan list", "", "", "", "", "", "", "", "", "c3"],
    ["", "parent@example.com", "", "Sheridan list", "", "", "", "", "", "", "", "", "c4"],
    ["Sam Lee", "sam1@example.com", "", "Player", "", "", "", "", "", "", "", "", "c5"],
    ["Sam Lee", "sam2@example.com", "", "Player", "", "", "", "", "", "", "", "", "c6"],
  ] });
  let n = 0;
  gs.Utilities.getUuid = () => `new${++n}`;
  const contacts = () => rowsOf(sheets.Contacts).map((r) => [r.Name, r.Email, r.Phone, r.Status, r["Other emails"], r["Other phones"], r["US Chess ID"]]);
  const before = contacts();
  gs.noteContact({ name: "Steven Garverick", id: "11111111", email: "STEVEN@example.com", phone: "970-555-0102", minor: false });
  gs.noteContact({ name: "Tony Whitt", id: "22222222", email: "tony@example.com", phone: "970-555-0103", minor: false });
  gs.noteContact({ name: "Dmitry Petrov", id: "33333333", email: "nameless@example.com", phone: "", minor: false });
  gs.noteContact({ name: "Kid Player", id: "44444444", email: "parent@example.com", phone: "", minor: true });
  gs.noteContact({ name: "Sam Lee", id: "55555555", email: "sam3@example.com", phone: "", minor: false });
  gs.noteContact({ name: "Steven Garverick", id: "11111111", email: "steve.g@example.com", phone: "", minor: false });
  eq(contacts(), [
    ["Steven Garverick", "steven@example.com", "970-555-0102", "Player", "steve.g@example.com", "", "11111111"],
    ["Anthony (Tony) Whitt", "tony@example.com", "970-555-0101", "Core member", "", "970-555-0103", "22222222"],
    ["Dmitry Petrov", "nameless@example.com", "", "Player", "", "", "33333333"],
    before[3],
    before[4],
    before[5],
    ["Kid Player", "parent@example.com", "", "Player", "", "", "44444444"],
  ], "found by name, then by ID; a nameless contact only by an adult's email; two Sam Lees, so neither");
  eq(rowsOf(sheets.Contacts).map((r) => [r.Events, r["On email list"], r.Role, r.ID]).slice(0, 2), [["3", "yes", "", "c1"], ["", "", "Treasurer", "c2"]]);
  assert.match(rowsOf(sheets.Contacts).at(-1).Notes, /^Added at registration, \d{4}-\d\d-\d\d; under 18, so the email is a parent's or guardian's\.$/);
  assert.equal(rowsOf(sheets.Contacts).at(-1).ID, "new1");
});

test("the registration form's phone is optional, kept as 970-555-0123, and goes to the contact", () => {
  const { gs, sheets } = load({ Entries: [], Contacts: [["Name", "Email", "Phone", "Status", "US Chess ID", "ID"]] });
  clubNights(gs);
  gs.MailApp = { sendEmail: () => {} };
  const register = (phone, td = true) => gs.register({ event: "monday-club-night-at-peak", date: "2026-10-12", id: "66666666", last: "Ash",
    category: "Adult", email: "ann@example.com", phone }, td);
  assert.match(register("555-0123", false).error, /10-digit phone number/);
  assert.match(register("970-555-0123 ext. 4").error, /10-digit phone number/);
  assert.equal(register("+1 (970) 555.0123").ok, true);
  eq(rowsOf(sheets.Entries).map((r) => r.Phone), ["970-555-0123"]);
  eq(rowsOf(sheets.Contacts).map((r) => [r.Name, r.Email, r.Phone, r.Status, r["US Chess ID"]]),
    [["Ann Ash", "ann@example.com", "970-555-0123", "Player", "66666666"]]);
  eq([gs.phoneNumber(""), gs.phoneNumber("9705550123"), gs.phoneNumber("=9705550123")], ["", "970-555-0123", null]);
});

// A running Swiss without the report columns: round 1 posted, round 2 saved but not posted.
function reporting(cache, store) {
  const key = "classic/2026-11-07";
  const players = [["11111111", "Ann", "1900"], ["22222222", "Ben", "1700"], ["33333333", "Cal", "1500"], ["44444444", "Dee", "1300"]]
    .map(([id, name, rating], i) => [key, String(i + 1), id, name, rating, "", ""]);
  return load({
    Tournaments: [["Key", "Event", "Name", "Format", "Rounds", "Status", "Started", "Coin", "Finished", "Cutoff", "Sections"],
      [key, "classic", "Classic", "swiss", "3", "running", "2026-11-07 10:00", "white", "", "", ""],
      ["arena/2026-11-07", "arena", "Arena", "arena", "", "running", "2026-11-07 10:00", "white", "", "17:30", ""]],
    Players: [["Key", "No.", "US Chess ID", "Name", "Rating", "Out from round", "Section"], ...players],
    Rounds: [["Key", "Round", "Board", "White", "Black", "Result", "Bye points", "Posted", "Section", "Bye kind"],
      [key, "1", "1", "11111111", "33333333", "", "", "2026-11-07 10:05", "", ""],
      [key, "1", "2", "44444444", "22222222", "", "", "2026-11-07 10:05", "", ""],
      [key, "2", "1", "22222222", "11111111", "", "", "", "", ""],
      [key, "2", "2", "33333333", "44444444", "", "", "", "", ""]],
  }, cache, store);
}

for (const store of STORES) {
  test(`a player's report is checked against the posted round, kept apart from the result, and shown as reported (${store})`, () => {
    const { gs, sheets, rows, handEdit } = reporting({}, store);
    const p = { event: "classic", date: "2026-11-07", number: "1", board: "1", section: "" };
    assert.match(gs.reportResult({ ...p, id: "1111111", result: "1-0" }).error, /eight digits/);
    assert.match(gs.reportResult({ ...p, id: "11111111", result: "1F-0F" }).error, /Report 1–0/);
    assert.match(gs.reportResult({ ...p, id: "22222222", result: "1-0" }).error, /isn't on board 1 in round 1/);
    assert.match(gs.reportResult({ ...p, board: "2", id: "11111111", result: "1-0" }).error, /isn't on board 2/);
    assert.match(gs.reportResult({ ...p, number: "2", id: "22222222", result: "1-0" }).error, /isn't on board 1 in round 2/, "round 2 isn't posted");
    assert.match(gs.reportResult({ ...p, event: "arena", id: "11111111", result: "1-0" }).error, /isn't taking results/);
    assert.match(gs.reportResult({ ...p, event: "nothing", id: "11111111", result: "1-0" }).error, /isn't taking results/);
    // Sent as the Pairings page sends it, with no password.
    const sent = gs.doPost({ parameter: { action: "report", ...p, id: "11111111", result: "1-0" } });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.match(sent.message, /1–0 is reported/);
    assert.equal(gs.reportResult({ ...p, id: "33333333", result: "0-1" }).ok, true);
    if (store === "sheet") eq(heading(sheets.Rounds).slice(-2), ["White report", "Black report"]);
    const row = rows("Rounds")[0];
    eq([row.Result, row["White report"], row["Black report"]], ["", "1-0", "0-1"]);
    const t = gs.tournament("classic/2026-11-07", false);
    eq(t.rounds[0].games[0].reports, { white: "1-0", black: "0-1" });
    assert.equal(t.rounds[0].games[0].result, "");
    assert.equal(t.rounds[0].games[1].reports, undefined);
    eq(Pairing.standings(t).map((r) => r.score), [0, 0, 0, 0], "reports don't count in the standings");
    // A board with the TD's result takes no more reports.
    assert.equal(gs.saveResult({ ...p, board: "2", result: "1/2-1/2" }).ok, true);
    assert.match(gs.reportResult({ ...p, board: "2", id: "22222222", result: "0-1" }).error, /already entered/);
    handEdit("Tournaments", 0, { Status: "finished" });
    assert.match(gs.reportResult({ ...p, id: "11111111", result: "1-0" }).error, /isn't taking results/);
  });
}

for (const store of STORES) {
  test(`reports are limited like public registrations (${store})`, () => {
    const minute = Math.floor(Date.now() / 60000);
    const { gs } = reporting({ [`posts:${minute}`]: "20", [`posts:${minute + 1}`]: "20" }, store);
    assert.match(gs.reportResult({ event: "classic", date: "2026-11-07", number: "1", board: "1", section: "", id: "11111111", result: "1-0" }).error,
      /Too many/);
  });
}

for (const store of STORES) {
  test(`the TD confirms agreed reports together, and re-pairing a round clears its reports (${store})`, () => {
    const { gs, rows, ratings, cache } = reporting({}, store);
    const p = { event: "classic", date: "2026-11-07", number: "1" };
    gs.reportResult({ ...p, board: "1", section: "", id: "11111111", result: "1-0" });
    gs.reportResult({ ...p, board: "2", section: "", id: "22222222", result: "0-1" });
    // Reports aren't results, so a posted round with only reports can be paired again.
    const games = [{ board: 1, white: "11111111", black: "22222222", section: "" }, { board: 2, white: "33333333", black: "44444444", section: "" }];
    const again = gs.saveRound({ ...p, post: "yes", games: JSON.stringify(games), byes: "[]" });
    assert.equal(again.ok, true, JSON.stringify(again));
    const round1 = () => rows("Rounds").filter((r) => r.Round === "1");
    eq(round1().map((r) => [r.Board, r.White, r.Black, r["White report"], r["Black report"], Boolean(r.Posted)]),
      [["1", "11111111", "22222222", "", "", true], ["2", "33333333", "44444444", "", "", true]]);
    assert.equal(gs.tournament("classic/2026-11-07", false).rounds[0].games.some((g) => g.reports), false);
    // A list with a bad board or result changes nothing.
    assert.match(gs.saveResults({ ...p, results: JSON.stringify([{ board: 1, section: "", result: "1-0" }, { board: 9, section: "", result: "1-0" }]) }).error,
      /No such board/);
    assert.match(gs.saveResults({ ...p, results: JSON.stringify([{ board: 1, section: "", result: "2-0" }]) }).error, /Not a result/);
    eq(round1().map((r) => r.Result), ["", ""]);
    const both = gs.doPost({ parameter: { action: "results", password: "sheet", ...p,
      results: JSON.stringify([{ board: 1, section: "", result: "1-0" }, { board: 2, section: "", result: "1/2-1/2" }]) } });
    assert.equal(both.ok, true, JSON.stringify(both));
    eq(round1().map((r) => r.Result), ["1-0", "1/2-1/2"]);
    // Once a posted round has a confirmed result, it can't be paired again (29G).
    assert.match(gs.saveRound({ ...p, post: "yes", games: JSON.stringify(games), byes: "[]" }).error, /has results/);
    // Once ratings.json lists it, the desk can't change it, and the public JSON names the rated event.
    ratings["classic/2026-11-07"] = "202611070123";
    delete cache.rated;
    const late = gs.doPost({ parameter: { action: "result", password: "sheet", ...p, board: "1", section: "", result: "0-1" } });
    assert.match(late.error, /US Chess has rated/);
    eq(round1().map((r) => r.Result), ["1-0", "1/2-1/2"]);
    const shown = gs.tournament("classic/2026-11-07", false);
    eq([shown.status, shown.usChessEvent], ["rated", "202611070123"]);
  });
}

for (const store of STORES) {
  test(`a Swiss can add rounds or stop early, but not below the rounds paired, and a restart deletes its rows (${store})`, () => {
    const { gs, rows } = reporting({}, store);
    const p = { event: "classic", date: "2026-11-07" };
    assert.match(gs.setRounds({ ...p, rounds: "1" }).error, /2 rounds are paired already/);
    assert.match(gs.setRounds({ ...p, rounds: "x" }).error, /number from 1 to 99/);
    assert.match(gs.setRounds({ event: "arena", date: "2026-11-07", rounds: "4" }).error, /Only a Swiss/);
    assert.equal(gs.setRounds({ ...p, rounds: "5" }).ok, true);
    assert.equal(rows("Tournaments")[0].Rounds, "5");
    assert.equal(gs.setRounds({ ...p, rounds: "2" }).ok, true);
    assert.equal(gs.tournament("classic/2026-11-07", true).plannedRounds, 2);
    assert.equal(gs.restartTournament("classic/2026-11-07").ok, true);
    for (const tab of ["Tournaments", "Players", "Rounds"]) assert.equal(rows(tab).filter((r) => r.Key === "classic/2026-11-07").length, 0, tab);
    eq(rows("Tournaments").map((r) => r.Key), ["arena/2026-11-07"]);
    assert.match(gs.restartTournament("classic/2026-11-07").error, /No such/);
  });
}

test("the database keeps rows by encoded heading, adds them in order after migrated rows, and costs one read an action", () => {
  const { gs, db, rows } = reporting({}, "firebase");
  assert.equal(db.root.tables.Players.r000002["No%2E"], "1", "No. is stored as No%2E");
  const p = { event: "classic", date: "2026-11-07", number: "3", post: "no", byes: "[]" };
  const games = [{ board: 1, white: "11111111", black: "44444444", section: "" }, { board: 2, white: "33333333", black: "22222222", section: "" }];
  db.calls.length = 0;
  assert.equal(gs.saveRound({ ...p, games: JSON.stringify(games) }).ok, true);
  eq(db.calls.filter((c) => c.method === "GET").map((c) => c.path), ["tables"]);
  const ids = Object.keys(db.root.tables.Rounds).sort();
  assert.ok(ids.slice(-2).every((id) => /^s[0-9a-z]{11}$/.test(id)), ids.join());
  eq(rows("Rounds").slice(-2).map((r) => [r.Round, r.Board, r.Black, r["White report"]]), [["3", "1", "44444444", ""], ["3", "2", "22222222", ""]],
    "each row has every heading, in the order added");
  // Pairing it again replaces the rows.
  assert.equal(gs.saveRound({ ...p, games: JSON.stringify(games.slice(0, 1)) }).ok, true);
  eq(rows("Rounds").filter((r) => r.Round === "3").map((r) => r.Board), ["1"]);
  db.calls.length = 0;
  const results = [{ board: 1, section: "", result: "1-0" }, { board: 2, section: "", result: "1/2-1/2" }];
  assert.equal(gs.saveResults({ event: "classic", date: "2026-11-07", number: "1", results: JSON.stringify(results) }).ok, true);
  eq(db.calls.map((c) => [c.method, c.path]), [["GET", "tables"], ["PATCH", "tables/Rounds"], ["PATCH", ""]],
    "results are one read, one write of the cells, and one of the public copy with the stamp");
  eq(rows("Rounds").slice(0, 2).map((r) => r.Result), ["1-0", "1/2-1/2"]);
});

test("the database's public copy of a tournament shows posted rounds only, follows each change, and goes with a restart", () => {
  const { gs, db } = reporting({}, "firebase");
  const key = "classic/2026-11-07";
  const copy = () => JSON.parse((db.root.public?.tournaments || {})["classic:2026-11-07"] ?? "null");
  assert.equal(copy(), null);
  const p = { event: "classic", date: "2026-11-07" };
  gs.saveResult({ ...p, number: "1", board: "2", section: "", result: "0-1" });
  eq(copy(), gs.tournament(key, false));
  eq(copy().rounds.map((r) => r.games.map((g) => g.result)), [["", "0-1"]], "round 2 is saved, not posted");
  eq(gs.currentTournaments().map((t) => t.key), [key, "arena/2026-11-07"], "?tournaments=current still answers");
  const games = [{ board: 1, white: "22222222", black: "11111111", section: "" }, { board: 2, white: "33333333", black: "44444444", section: "" }];
  gs.saveRound({ ...p, number: "2", post: "yes", games: JSON.stringify(games), byes: "[]" });
  assert.equal(copy().rounds.length, 2);
  assert.ok(copy().rounds[1].posted);
  gs.setOut({ ...p, id: "44444444", from: "3" });
  eq(copy().players.find((x) => x.id === "44444444").out, 3);
  assert.equal(gs.restartTournament(key).ok, true);
  assert.equal(copy(), null);
  eq(Object.keys(db.root.tables.Tournaments).length, 1, "the arena is still there");
});

test("the database keeps an arena's queue as a JSON string, and the public copy shows it", () => {
  const { gs, db } = reporting({}, "firebase");
  const at = { event: "arena", date: "2026-11-07" };
  db.root.tables.Players.r000010 = { Key: "arena/2026-11-07", "No%2E": "1", "US Chess ID": "11111111", Name: "Ann", Rating: "1900" };
  assert.equal(gs.arenaJoin({ ...at, id: "11111111" }).ok, true);
  assert.equal(typeof db.root.queues["arena:2026-11-07"], "string");
  eq(JSON.parse(db.root.queues["arena:2026-11-07"]).map((q) => q.id), ["11111111"]);
  eq(JSON.parse(db.root.public.tournaments["arena:2026-11-07"]).queue.map((q) => q.id), ["11111111"]);
  assert.equal(gs.arenaLeave({ ...at, id: "11111111" }).ok, true);
  assert.equal(db.root.queues, undefined, "an empty queue is removed");
  eq(JSON.parse(db.root.public.tournaments["arena:2026-11-07"]).queue, []);
});

test("change stamps go to the database's /changes too, and the sheet store never calls it", () => {
  const tabs = () => ({
    Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Status", "Amount", "Paid", "Paid on", "Token"],
      ["", "classic", "2026-11-07", "11111111", "Ann", "registered", "15", "", "", "t1"]],
    Contacts: [["Name", "Email", "Phone", "Notes"]],
  });
  const { gs, db } = load(tabs(), {}, "firebase");
  gs.clubEvents = () => ({});
  gs.markPaid("t1", "15", "cash");
  eq(db.root.changes, { entries: gs.changes().entries });
  gs.saveContact({ fields: JSON.stringify({ Name: "Ann Ash" }) });
  gs.clearTournamentCache("classic/2026-11-07");
  db.calls.length = 0;
  gs.refreshCaches();
  eq(db.root.changes, gs.changes());
  eq(db.calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path]), [["PATCH", ""], ["PUT", "public/entries"]],
    "one write for every scope, then the Entries page's copy");

  const sheet = load(tabs());
  sheet.gs.clubEvents = () => ({});
  sheet.gs.markPaid("t1", "15", "cash");
  sheet.gs.refreshCaches();
  eq(sheet.db.calls, []);
});

test("Refresh rebuilds the database's public copies from its tables and removes those of tournaments gone", () => {
  const { gs, db, handEdit } = reporting({}, "firebase");
  gs.clubEvents = () => ({});
  db.root.public = { tournaments: { "gone:2026-01-01": JSON.stringify({ key: "gone/2026-01-01" }) } };
  handEdit("Tournaments", 0, { Status: "finished" });
  assert.match(gs.refreshCaches().message, /2 tournaments/);
  eq(Object.keys(db.root.public.tournaments).sort(), ["arena:2026-11-07", "classic:2026-11-07"]);
  assert.equal(JSON.parse(db.root.public.tournaments["classic:2026-11-07"]).status, "finished");
});

test("a database that's down never turns a registration, payment, or withdrawal into an error", () => {
  const { gs, db, sheets } = load({
    Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Status", "Amount", "Paid", "Paid on", "Token"],
      ["", "classic", "2026-11-07", "11111111", "Ann", "registered", "15", "", "", "t1"]],
  }, {}, "firebase");
  gs.clubEvents = () => ({});
  db.failing = true;
  assert.equal(gs.markPaid("t1", "15", "cash").ok, true);
  assert.match(gs.withdraw("t1"), /withdrawn|no longer/i);
  eq(rowsOf(sheets.Entries).map((r) => r.Paid), ["15"]);
});

test("a database that refuses a write fails the action with the desk's usual error", () => {
  const { gs, db } = reporting({}, "firebase");
  db.failing = true;
  const sent = gs.doPost({ parameter: { action: "result", password: "sheet", event: "classic", date: "2026-11-07", number: "1", board: "1",
    section: "", result: "1-0" } });
  assert.match(sent.error, /Something went wrong/);
  assert.throws(() => gs.tournament("classic/2026-11-07", true), /Firebase GET \/tables: 500/);
});

// An ID token as Firebase makes one: only its payload's exp matters to the script, which leaves the signature to Google.
const idToken = (name, seconds = 3600) => ["header", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))
  .toString("base64url"), name].join(".");

function signIn(tabs = {}) {
  const t = load({ Entries: [HEADER_ROW], ...tabs });
  const account = (email, emailVerified = true) => ({ localId: email, email, emailVerified, displayName: "Google Name", providerUserInfo: [] });
  Object.assign(t.accounts, {
    [idToken("ann")]: account("Ann@Example.org"),
    [idToken("second")]: account("ann.work@example.com"),
    [idToken("rowtwo")]: account("ann@school.edu"),
    [idToken("stranger")]: account("stranger@example.org"),
    [idToken("unverified")]: account("ann@example.org", false),
    [idToken("player")]: account("pat@example.org"),
  });
  const post = (fields) => t.gs.doPost({ parameter: fields });
  return { ...t, post };
}
const HEADER_ROW = ["Registered", "Event", "Date", "US Chess ID", "Name", "Status", "Added by", "Token"];
const TDS = [["Email", "Name", "US Chess ID", "Role"],
  ["ann@example.org; ann.work@example.com", "Ann Ash", "11111111", ""],
  ["ann@school.edu", "Ann Ash", "11111111", "TD"],
  ["pat@example.org", "Pat Pawn", "22222222", "player"]];
const ANN = { email: "Ann@Example.org", name: "Ann Ash", usChessId: "11111111" };

test("a TD signs in with a Firebase ID token from any of their addresses, and the token is checked once", () => {
  const { post, lookups, cache, gs } = signIn({ TDs: TDS });
  const login = post({ action: "login", idToken: idToken("ann"), password: "wrong" });
  eq(login, { ok: true, changes: gs.changes(), td: ANN }, "the password is ignored");
  eq(post({ action: "whoami", idToken: idToken("ann") }), { td: ANN });
  eq(lookups, [idToken("ann")], "one lookup for two requests");
  assert.ok(Object.keys(cache).some((k) => k.startsWith("idToken:")));
  eq(post({ action: "whoami", idToken: idToken("second") }).td, { ...ANN, email: "ann.work@example.com" }, "two addresses in one cell");
  eq(post({ action: "whoami", idToken: idToken("rowtwo") }).td, { ...ANN, email: "ann@school.edu" }, "one person on two rows");
});

test("Firebase sign-ins that aren't a TD's are refused, with what to do", () => {
  const { post } = signIn({ TDs: TDS });
  eq(post({ action: "login", idToken: idToken("stranger") }),
    { error: "stranger@example.org isn't on the club's list of TDs. Ask the president to add you.", login: true });
  eq(post({ action: "login", idToken: idToken("unverified") }),
    { error: "Confirm your email address first; we've sent you a link.", login: true, verify: true });
  eq(post({ action: "login", idToken: idToken("forged") }), { error: "Your sign-in has expired. Sign in again.", login: true });
  eq(post({ action: "login", idToken: "not a token" }), { error: "Your sign-in has expired. Sign in again.", login: true });
  eq(post({ action: "login", idToken: idToken("ann", -60) }), { error: "Your sign-in has expired. Sign in again.", login: true });
  const player = post({ action: "entries", idToken: idToken("player"), event: "classic", date: "2026-11-07" });
  assert.equal(player.login, true);
  assert.match(player.error, /^pat@example\.org is on the club's list, but not as a TD/);
});

test("a token's check is kept no longer than the token lasts, and an unverified one not at all", () => {
  const { gs, post, cache, lookups, accounts } = signIn({ TDs: TDS });
  const ttl = {};
  const store = gs.CacheService.getScriptCache();
  gs.CacheService.getScriptCache = () => ({ ...store, put: (k, v, seconds) => { cache[k] = v; ttl[k] = seconds; } });
  post({ action: "whoami", idToken: idToken("ann") });
  const short = idToken("ann", 600);
  accounts[short] = accounts[idToken("ann")];
  post({ action: "whoami", idToken: short });
  const kept = Object.entries(ttl).filter(([k]) => k.startsWith("idToken:")).map(([, s]) => s);
  assert.ok(kept[0] <= 3600 && kept[0] > 3590, "an hour at most");
  assert.ok(kept[1] <= 600 && kept[1] > 590, "no longer than the token");
  lookups.length = 0;
  post({ action: "whoami", idToken: idToken("unverified") });
  post({ action: "whoami", idToken: idToken("unverified") });
  assert.equal(lookups.length, 2);
  assert.equal(ttl.tds, 300);
});

test("the TDs tab is added when it's missing, and a TD added since it was read is let in", () => {
  const { post, sheets, accounts } = signIn();
  assert.match(post({ action: "login", idToken: idToken("ann") }).error, /isn't on the club's list of TDs/);
  eq(sheets.TDs.data, [["Email", "Name", "US Chess ID", "Role"]]);
  sheets.TDs.data.push(["ANN@example.org", "Ann Ash", "11111111", ""]);
  accounts[idToken("again")] = accounts[idToken("ann")];
  eq(post({ action: "login", idToken: idToken("again") }).td, ANN, "the cached tab is read again before refusing");
});

test("the signed-in TD is recorded where the desk doesn't name one, and the password still signs in without a token", () => {
  const { post, gs, sheets } = signIn({ TDs: TDS });
  gs.clubEvents = () => ({ "classic/2026-11-07": { event: "classic", name: "Classic", kind: "entry", label: "Saturday", first: "2099-11-07",
    last: "2099-11-07", closes: "2099-11-07T10:00:00-07:00" } });
  gs.MailApp = { sendEmail: () => {} };
  const p = { event: "classic", date: "2026-11-07", id: "33333333", action_taken: "Warning", reason: "Phone rang" };
  assert.equal(post({ action: "incident", idToken: idToken("ann"), ...p }).ok, true);
  assert.equal(post({ action: "incident", idToken: idToken("ann"), ...p, td: "Ben Bishop" }).ok, true);
  eq(rowsOf(sheets.Incidents).map((r) => r.TD), ["Ann Ash", "Ben Bishop"]);
  assert.equal(post({ action: "register", idToken: idToken("ann"), event: "classic", date: "2026-11-07", id: "44444444" }).ok, true);
  eq(rowsOf(sheets.Entries).map((r) => r["Added by"]), ["TD (Ann Ash)"]);

  eq(post({ action: "login", password: "sheet", device: "device-0000000000" }), { ok: true, changes: gs.changes() });
  eq(post({ action: "whoami", password: "sheet", device: "device-0000000000" }), { td: null });
  assert.equal(post({ action: "incident", password: "sheet", ...p }).error, "Say what happened and who you are.");
  eq(post({ action: "login", password: "wrong", device: "device-0000000000" }), { error: "Wrong password.", login: true });
});

// Half-point byes asked for in advance. classic/2026-11-07 is a four-round Swiss; quad, arena, and open (a Swiss whose
// format and rounds aren't set) are other tournament dates; October 2099's club nights fall on the dates in NIGHTS, all
// still to come. Ann Ash, 66666666, and Ben Birch, 77777777, register online, their ages already checked.
const NIGHTS = ["2099-10-05", "2099-10-12", "2099-10-19", "2099-10-26"];

function byes(tabs = {}, store = "sheet") {
  const t = load({ Entries: [], ...tabs }, {}, store);
  const day = (event, date, label, fields) => ({ event, name: event, page: `/events/${event}/`, kind: "entry", label, first: date, last: date,
    closes: "2099-01-01T10:00:00-07:00", format: "swiss", rounds: "4", ...fields });
  const club = (kind, first, label) => ({ event: "monday-club-night-at-peak", name: "Monday Club Night", page: "/events/monday-club-night-at-peak/", kind, label, first,
    last: kind === "month" ? NIGHTS.at(-1) : first, closes: "2099-10-26T18:30:00-06:00", format: "swiss", rounds: "" });
  t.events = {
    "classic/2026-11-07": day("classic", "2026-11-07", "Saturday, November 7, 2026"),
    "quad/2026-11-14": day("quad", "2026-11-14", "Saturday, November 14, 2026", { format: "quad", rounds: "" }),
    "arena/2026-10-31": day("arena", "2026-10-31", "Saturday, October 31, 2026", { format: "arena", rounds: "" }),
    "open/2026-11-21": day("open", "2026-11-21", "Saturday, November 21, 2026", { format: "", rounds: "" }),
    ...Object.fromEntries(NIGHTS.map((d) => [`monday-club-night-at-peak/${d}`, club("night", d, d)])),
    "monday-club-night-at-peak/2099-10": club("month", NIGHTS[0], "all Mondays in October 2099"),
  };
  t.gs.clubEvents = () => t.events;
  const cache = t.gs.CacheService.getScriptCache();
  t.gs.CacheService.getScriptCache = () => ({ ...cache, remove: (k) => delete t.cache[k], removeAll: (keys) => keys.forEach((k) => delete t.cache[k]) });
  t.mail = [];
  t.gs.MailApp = { sendEmail: (m) => t.mail.push(m) };
  for (const id of ["66666666", "77777777"]) {
    t.props[`player:${id}`] = JSON.stringify({ Category: "Adult", "Checked on": new Date().toISOString().slice(0, 10) });
  }
  let n = 0;
  t.gs.Utilities.getUuid = () => `token${++n}`;
  // The patterns the messages name dates with. Each date is noon UTC, the same day in Denver.
  const words = { "EEEE, MMMM d": { weekday: "long", month: "long", day: "numeric" }, "MMMM d": { month: "long", day: "numeric" },
    MMMM: { month: "long" } };
  const plain = t.gs.Utilities.formatDate;
  t.gs.Utilities.formatDate = (d, tz, f) => (words[f] ? d.toLocaleDateString("en-US", { timeZone: "UTC", ...words[f] }) : plain(d, tz, f));
  t.register = (fields, td = false) => t.gs.register({ event: "classic", date: "2026-11-07", id: "66666666", last: "Ash",
    email: "ann@example.com", ...fields }, td);
  // As the Entries page sends it, without a sign-in, and as the desk does, by the entry's token.
  t.post = (fields) => t.gs.doPost({ parameter: { action: "byes", event: "classic", date: "2026-11-07", id: "66666666", last: "Ash",
    email: "ann@example.com", ...fields } });
  t.desk = (fields) => t.gs.doPost({ parameter: { action: "byes", password: "sheet", ...fields } });
  t.entryByes = () => rowsOf(t.sheets.Entries).map((r) => r.Byes);
  t.playerByes = () => t.rows("Players").map((r) => r.Byes);
  return t;
}

test("byes asked for when registering: one, online or on the desk, a month's by night, and none for a night, a quad, or an arena", () => {
  const { gs, sheets, mail, register, events } = byes();
  const refused = (fields, td) => register(fields, td).error;
  assert.equal(refused({ byes: "2, 4" }), "One half-point bye per player, as the event's page announces.");
  assert.equal(refused({ byes: "2, 4" }, true), "One half-point bye per player, as the event's page announces.", "the desk too");
  // Without a page announcing them, only the first half's rounds offer byes (22C1).
  delete events["classic/2026-11-07"].page;
  assert.equal(refused({ byes: "3" }), "The event's page offers no half-point byes, so only the first half's rounds have them (22C1), and round 3 isn't one.");
  events["classic/2026-11-07"].page = "/events/classic/";
  assert.equal(refused({ byes: "5" }), "Not a round of this tournament.");
  assert.equal(refused({ byes: "two" }), "Not a round of this tournament.");
  assert.equal(refused({ event: "open", date: "2026-11-21", byes: "2" }), "The number of rounds isn't set yet; tell the TD.");
  assert.equal(refused({ event: "quad", date: "2026-11-14", byes: "2" }), "This tournament has no byes; a game a player misses is forfeited.");
  assert.equal(refused({ event: "arena", date: "2026-10-31", byes: "2" }), "An arena has no byes.");
  assert.equal(refused({ event: "monday-club-night-at-peak", date: "2099-10-12", byes: "2099-10-12" }),
    "A single night has no byes; register for the whole month to miss a night.");
  assert.equal(refused({ event: "monday-club-night-at-peak", date: "2099-10", byes: "2" }), "Not a night of this month.");
  eq(rowsOf(sheets.Entries), [], "nothing refused is saved");

  assert.equal(register({ byes: "3" }).message, "Ann Ash is registered for Saturday, November 7, 2026. Byes asked for: round 3."
    + " The TD will confirm the fee when you arrive. A confirmation is on its way to ann@example.com.");
  assert.equal(mail[0].body.split("\n\n")[1], "Byes asked for: round 3. To change them, go to"
    + " https://larimerchess.org/entries/?event=classic/2026-11-07 on the device you registered from, or email president@larimerchess.org.");
  const desk = gs.register({ event: "classic", date: "2026-11-07", id: "77777777", category: "Adult", email: "ben@example.com", byes: "4, 4" }, true);
  assert.match(desk.message, /^Ben Birch is registered for Saturday, November 7, 2026\. Byes asked for: round 4\. /);
  assert.equal(mail[1].body.split("\n\n")[1], "Byes asked for: round 4. To change them, email president@larimerchess.org.",
    "a player the TD registered has no device that saved them");
  assert.equal(refused({ event: "monday-club-night-at-peak", date: "2099-10", byes: "2099-10-26, 2099-10-19" }, true),
    "One half-point bye per player, as the event's page announces.", "a month's too, as its page announces");
  const month = register({ event: "monday-club-night-at-peak", date: "2099-10", byes: "2099-10-26" }, true);
  assert.match(month.message, /^Ann Ash is registered for all Mondays in October 2099\. Nights you'll miss: Monday, October 26\. /);
  assert.equal(mail[2].body.split("\n\n")[1], "Nights you'll miss: Monday, October 26. To change them, email"
    + " president@larimerchess.org.", "registered at the desk, the email gives no link to the device's Entries page");
  assert.equal(gs.register({ event: "classic", date: "2026-11-07", id: "33333333", category: "Adult" }, true).ok, true, "byes are optional");
  eq(rowsOf(sheets.Entries).map((r) => [r.Date, r["US Chess ID"], r.Byes]), [["2026-11-07", "66666666", "3"], ["2026-11-07", "77777777", "4"],
    ["2099-10", "66666666", "2099-10-26"], ["2026-11-07", "33333333", ""]]);
  eq(gs.entries("classic/2026-11-07", false).map((e) => [e.id, e.byes]), [["33333333", undefined], ["66666666", ["3"]], ["77777777", ["4"]]]);
  eq(gs.entries("monday-club-night-at-peak/2099-10-19", false).map((e) => [e.for, e.byes]), [["Whole month", ["2099-10-26"]]]);
  assert.ok(!("byes" in gs.entries("classic/2026-11-07", true)[0]), "a list without byes has none to show");
});

// A four-round Swiss under way. Ann and Ben registered online; Cal and Dee on the desk, without an email.
function classicRunning(store) {
  const key = "classic/2026-11-07";
  const t = byes({
    Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Email", "Status", "Added by", "Token", "Regular rating", "Byes"],
      ["", "classic", "2026-11-07", "66666666", "Ann Ash", "ann@example.com", "registered", "online", "t1", "1900", ""],
      ["", "classic", "2026-11-07", "77777777", "Ben Birch", "ben@example.com", "registered", "online", "t2", "1700", ""],
      ["", "classic", "2026-11-07", "33333333", "Cal", "", "registered", "TD", "t3", "1500", ""],
      ["", "classic", "2026-11-07", "44444444", "Dee", "", "registered", "TD", "t4", "1300", ""]],
    Tournaments: [["Key", "Event", "Name", "Format", "Rounds", "Status", "Started", "Coin", "Finished", "Cutoff", "Sections", "TD", "Round dates"],
      [key, "classic", "Classic", "swiss", "4", "running", "2026-11-07 10:00", "white", "", "", "", "", ""]],
    Players: [["Key", "No.", "US Chess ID", "Name", "Rating", "Out from round", "Section", "Byes"],
      [key, "1", "66666666", "Ann Ash", "1900", "", "", ""], [key, "2", "77777777", "Ben Birch", "1700", "", "", ""],
      [key, "3", "33333333", "Cal", "1500", "", "", ""], [key, "4", "44444444", "Dee", "1300", "", "", ""]],
    Rounds: [["Key", "Round", "Board", "White", "Black", "Result", "Bye points", "Posted", "Section", "Bye kind"]],
  }, store);
  t.pair = (number, post) => t.gs.saveRound({ event: "classic", date: "2026-11-07", number: String(number), post: post ? "yes" : "no",
    byes: "[]", games: JSON.stringify([{ board: 1, white: "66666666", black: "33333333" }, { board: 2, white: "44444444", black: "77777777" }]) });
  return t;
}

for (const store of STORES) {
  test(`a player changes their byes on the Entries page by last name and email, in the entry and the running tournament, until the round is paired (${store})`, () => {
    const { gs, post, pair, entryByes, playerByes } = classicRunning(store);
    const ben = (fields) => post({ id: "77777777", last: "Birch", email: "ben@example.com", ...fields });
    assert.equal(post({ last: "Birch", byes: "3" }).error, "That last name doesn't match the US Chess ID.");
    assert.equal(post({ email: "ben@example.com", byes: "3" }).error, "That email doesn't match the registration.");
    assert.equal(post({ id: "33333333", last: "", email: "", byes: "3" }).error, "That email doesn't match the registration.",
      "an entry without an email can't be changed online");
    assert.equal(post({ date: "2026-11-14", byes: "3" }).error, "No registration matches.");
    assert.equal(post({ email: " ANN@example.com ", byes: "3" }).message, "Ann Ash's byes: round 3.");
    eq([entryByes(), playerByes()], [["3", "", "", ""], ["3", "", "", ""]]);
    eq(gs.entries("classic/2026-11-07", false).map((e) => e.byes || []), [["3"], [], [], []]);
    const shown = gs.tournament("classic/2026-11-07", false);
    eq(shown.players.map((p) => p.byes || []), [[3], [], [], []]);
    assert.ok(!("roundDates" in shown), "only a month has round dates");
    assert.equal(post({ byes: "2" }).message, "Ann Ash's byes: round 2.", "the new list replaces the old");
    eq([entryByes()[0], playerByes()[0]], ["2", "2"]);

    pair(1, true);
    pair(2, false);
    assert.equal(post({ byes: "" }).error, "Round 2 is already paired, so only the TD can change it.", "saved but not posted counts");
    assert.equal(ben({ byes: "1" }).error, "Round 1 is already paired, so only the TD can change it.");
    assert.equal(ben({ byes: "4" }).error, "A last-round bye is asked for before round 1, so it can't be added now (22C4).");
    assert.equal(ben({ byes: "3" }).message, "Ben Birch's byes: round 3.");
    assert.equal(ben({ byes: "" }).message, "Ben Birch's byes: none.");
    eq([entryByes(), playerByes()], [["2", "", "", ""], ["2", "", "", ""]]);
  });
}

for (const store of STORES) {
  test(`the TD changes an entry's byes by its token, one per player, a last-round one asked for before round 1 and only the TD can cancel, but not a round paired, nor once rated (${store})`, () => {
    const { gs, post, desk, pair, playerByes, ratings, cache } = classicRunning(store);
    assert.equal(desk({ token: "t1", byes: "4" }).message, "Ann Ash's byes: round 4.");
    pair(1, true);
    assert.equal(desk({ token: "t3", byes: "4, 3, 3" }).error, "One half-point bye per player, as the event's page announces.");
    assert.equal(desk({ token: "t3", byes: "3" }).message, "Cal's byes: round 3.");
    assert.equal(desk({ token: "t3", byes: "1, 3" }).error, "Round 1 is already paired, so only the TD can change it.");
    assert.equal(desk({ token: "t2", byes: "4" }).error, "A last-round bye is asked for before round 1, so it can't be added now (22C4).");
    assert.match(post({ byes: "" }).error, /\(22C4\); tell the TD/, "which the player can't drop online");
    assert.equal(desk({ token: "t1", byes: "" }).message, "Ann Ash's byes: none.", "the TD can cancel it (22C5)");
    assert.equal(desk({ token: "gone", byes: "3" }).error, "No registration matches.");
    // A half-point bye given at check-in counts toward the one a player may have, and the last round's needs asking for before round 1.
    const round = (number, byes) => gs.saveRound({ event: "classic", date: "2026-11-07", number: String(number), post: "yes",
      games: "[]", byes: JSON.stringify(byes) });
    assert.equal(round(2, [{ id: "33333333", points: 0.5, kind: "half" }]).error,
      "Cal already has or asked for a half-point bye, in round 3, and the event allows one per player.");
    assert.equal(round(2, [{ id: "44444444", points: 0.5, kind: "half" }]).ok, true);
    assert.equal(desk({ token: "t4", byes: "3" }).error, "There's a half-point bye in round 2 already, and the event allows one per player.");
    assert.equal(round(4, [{ id: "66666666", points: 0.5, kind: "half" }]).error,
      "Ann Ash didn't ask for a last-round bye before round 1, so they can't have one (22C4).");
    eq(playerByes(), ["", "", "3", ""]);
    ratings["classic/2026-11-07"] = "202611070123";
    delete cache.rated;
    assert.equal(desk({ token: "t3", byes: "3" }).error, "US Chess has rated this tournament, so its byes can't change.");
    assert.equal(desk({ token: "t3", event: "classic", date: "2026-11-07", byes: "3" }).error,
      "US Chess has rated this tournament, so it can't change on the desk.");
    assert.equal(post({ byes: "2, 3, 4" }).error, "US Chess has rated this tournament, so its byes can't change.");
    eq(playerByes(), ["", "", "3", ""]);
  });
}

for (const store of STORES) {
  test(`a month's byes are its nights, which its Round dates make rounds, leaving out a night added since Start (${store})`, () => {
    const key = "monday-club-night-at-peak/2099-10";
    const t = byes({
      Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Email", "Status", "Token", "Byes"],
        ["", "monday-club-night-at-peak", "2099-10", "66666666", "Ann Ash", "ann@example.com", "registered", "t1", ""]],
      Tournaments: [["Key", "Event", "Name", "Format", "Rounds", "Status", "Round dates"],
        [key, "monday-club-night-at-peak", "Monday Club Night", "swiss", "3", "running", JSON.stringify(NIGHTS.slice(0, 3))]],
      Players: [["Key", "No.", "US Chess ID", "Name", "Rating", "Byes"], [key, "1", "66666666", "Ann Ash", "1900", ""]],
    }, store);
    const post = (byes) => t.post({ event: "monday-club-night-at-peak", date: "2099-10", byes });
    assert.equal(post("2099-10-19").message, "Ann Ash's byes: October 19.");
    eq(t.playerByes(), ["3"]);
    assert.equal(post("2099-10-26, 2099-10-12").error, "One half-point bye per player, as the event's page announces.");
    assert.equal(t.desk({ token: "t1", byes: "2099-10-26, 2099-10-12" }).error, "One half-point bye per player, as the event's page announces.",
      "on the desk too");
    assert.equal(t.desk({ token: "t1", byes: "2099-10-12" }).ok, true);
    eq([t.entryByes(), t.playerByes()], [["2099-10-12"], ["2"]]);
    assert.equal(post("2099-11-02").error, "Not a night of this month.");
    assert.equal(post("3").error, "Not a night of this month.");
    const shown = t.gs.tournament(key, false);
    eq([shown.roundDates, shown.players[0].byes], [NIGHTS.slice(0, 3), [2]]);
    eq(t.gs.entries("monday-club-night-at-peak/2099-10-19", false).map((e) => e.byes), [["2099-10-12"]]);
    // The TD gives the half-point bye she asked for in round 2.
    t.gs.saveRound({ event: "monday-club-night-at-peak", date: "2099-10", number: "2", post: "yes", games: "[]",
      byes: JSON.stringify([{ id: "66666666", points: 0.5, kind: "half" }]) });
    assert.equal(post("2099-10-26").error, "October 12 is already paired, so only the TD can change it.");
    // 22C4: once round 1 is posted, the month's last night's bye is fixed.
    t.gs.saveRound({ event: "monday-club-night-at-peak", date: "2099-10", number: "1", post: "yes", games: "[]",
      byes: JSON.stringify([{ id: "66666666", points: 0, kind: "unplayed" }]) });
    assert.equal(t.desk({ token: "t1", byes: `2099-10-12, ${NIGHTS.at(-1)}` }).error, "One half-point bye per player, as the event's page announces.");
    // Switched to just one night, she plays no other, so asks for no byes on them.
    const switched = t.gs.doPost({ parameter: { action: "toNight", event: "monday-club-night-at-peak", date: "2099-10-19", id: "66666666",
      last: "Ash", email: "ann@example.com" } });
    assert.equal(switched.ok, true, JSON.stringify(switched));
    eq(t.playerByes(), [""]);
    assert.ok(!("byes" in t.gs.tournament(key, false).players[0]));
  });
}

for (const store of STORES) {
  test(`Start writes a month's Round dates and gives new players the byes they asked for as rounds, as sync does later, but not in a quad (${store})`, () => {
    const t = byes({
      Entries: [["Registered", "Event", "Date", "US Chess ID", "Name", "Email", "Status", "Token", "Regular rating", "Byes"],
        ["", "monday-club-night-at-peak", "2099-10", "66666666", "Ann Ash", "ann@example.com", "registered", "t1", "1900", "2099-10-19, 2099-10-26"],
        ["", "monday-club-night-at-peak", "2099-10-05", "77777777", "Ben Birch", "ben@example.com", "registered", "t2", "1700", ""],
        ["", "classic", "2026-11-07", "66666666", "Ann Ash", "ann@example.com", "registered", "t3", "1900", "2, 4"],
        ["", "open", "2026-11-21", "66666666", "Ann Ash", "ann@example.com", "registered", "t4", "1900", "2"]],
      Tournaments: [], Players: [], Rounds: [],
    }, store);
    const month = "monday-club-night-at-peak/2099-10";
    const start = (event, date, format) => t.gs.startTournament({ event, date, format, rounds: "4", coin: "white" });
    const players = (key) => t.rows("Players").filter((r) => r.Key === key).map((r) => [r.Name, r.Byes]);
    assert.equal(start("monday-club-night-at-peak", "2099-10", "swiss").ok, true);
    eq(t.rows("Tournaments").map((r) => [r.Key, r["Round dates"]]), [[month, JSON.stringify(NIGHTS)]]);
    eq(players(month), [["Ann Ash", "3, 4"], ["Ben Birch", ""]]);
    // A late entrant, added by hand with the nights out of order; Ann's change by hand isn't copied again.
    t.sheets.Entries.data.push(["", "monday-club-night-at-peak", "2099-10", "33333333", "Cal", "", "registered", "t5", "1500", "2099-10-26, 2099-10-05"]);
    t.handEdit("Entries", 0, { Byes: "2099-10-05" });
    t.gs.syncPlayers(month);
    eq(players(month), [["Ann Ash", "3, 4"], ["Ben Birch", ""], ["Cal", "1, 4"]]);
    eq(t.gs.tournament(month, true).players.map((p) => p.nights), [undefined, [1], undefined], "the desk gets the nights of one who entered night by night");
    // Ben, a player from the night he registered for, moves to the whole month with a bye.
    const ben = t.register({ event: "monday-club-night-at-peak", date: "2099-10", id: "77777777", last: "Birch", email: "ben@example.com",
      byes: "2099-10-26" });
    assert.equal(ben.ok, true, JSON.stringify(ben));
    eq(players(month), [["Ann Ash", "3, 4"], ["Ben Birch", "4"], ["Cal", "1, 4"]]);
    eq(t.gs.tournament(month, false).players.map((p) => p.byes || []), [[3, 4], [4], [1, 4]]);
    // Dee enters October 19 and 26 alone after the first night is posted: she plays only those, and has no late bye for it.
    t.gs.saveRound({ event: "monday-club-night-at-peak", date: "2099-10", number: "1", post: "yes", byes: "[]",
      games: JSON.stringify([{ board: 1, white: "66666666", black: "77777777" }]) });
    for (const night of ["2099-10-19", "2099-10-26"]) {
      t.sheets.Entries.data.push(["", "monday-club-night-at-peak", night, "44444444", "Dee", "", "registered", `t${night}`, "1300", ""]);
    }
    t.gs.syncPlayers(month);
    eq(t.rows("Rounds").filter((r) => r.White === "44444444"), [], "no late bye");
    eq(t.gs.tournament(month, true).players.map((p) => p.nights), [undefined, undefined, undefined, [3, 4]], "the month is every night");
    assert.ok(t.gs.tournament(month, false).players.every((p) => !("nights" in p)), "the public copy has no nights");
    assert.equal(start("classic", "2026-11-07", "swiss").ok, true);
    eq(players("classic/2026-11-07"), [["Ann Ash", "2, 4"]]);
    eq(t.rows("Tournaments").map((r) => r["Round dates"]), [JSON.stringify(NIGHTS), ""], "a tournament date has none");
    assert.equal(start("open", "2026-11-21", "quad").ok, true);
    eq(players("open/2026-11-21"), [["Ann Ash", ""]], "a quad's missing player forfeits by the table");
  });
}

test("an Entries tab and a month's tournament from before byes get their columns, and still register and list, with no rounds for its nights", () => {
  const month = "monday-club-night-at-peak/2099-10";
  const old = ["Registered", "Event", "Date", "US Chess ID", "Name", "Category", "Amount", "Paid", "Paid on", "Regular rating", "Quick rating",
    "Membership expires", "Email", "Status", "Added by", "Token", "Phone", "Paid by", "Rating fee", "Discount", "Discount note"];
  const t = byes({
    Entries: [old, ["2026-10-01 09:00", "monday-club-night-at-peak", "2099-10", "66666666", "Ann Ash", "Adult", "", "", "", "1900", "", "",
      "ann@example.com", "registered", "online", "t1"]],
    Tournaments: [["Key", "Event", "Name", "Format", "Rounds", "Status", "Started", "Coin", "Finished", "Cutoff", "Sections", "TD"],
      [month, "monday-club-night-at-peak", "Monday Club Night", "swiss", "4", "running", "2099-10-05 18:30", "white", "", "", "", ""]],
    Players: [["Key", "No.", "US Chess ID", "Name", "Rating", "Out from round", "Section", "Floor", "Prior games", "Prior sweep", "State"],
      [month, "1", "66666666", "Ann Ash", "1900", "", "", "", "", "", "CO"]],
  });
  eq(t.gs.entries("monday-club-night-at-peak/2099-10-05", false).map((e) => [e.name, "byes" in e]), [["Ann Ash", false]]);
  eq(heading(t.sheets.Entries).slice(-2), ["Discount note", "Byes"]);
  assert.equal(t.register({}).ok, true);
  assert.equal(t.register({ event: "open", date: "2026-11-21" }).ok, true);
  eq(rowsOf(t.sheets.Entries).map((r) => [r.Date, r.Email, r.Byes]), [["2099-10", "ann@example.com", ""], ["2026-11-07", "ann@example.com", ""],
    ["2026-11-21", "ann@example.com", ""]]);
  assert.equal(t.post({ event: "monday-club-night-at-peak", date: "2099-10", byes: "2099-10-19" }).message, "Ann Ash's byes: October 19.");
  eq([t.entryByes()[0], t.playerByes()], ["2099-10-19", [""]], "without Round dates, a night has no round");
  const shown = t.gs.tournament(month, false);
  eq(["roundDates" in shown, "byes" in shown.players[0]], [false, false]);
});

test("the desk's New tournament adds a Closed events row by heading, which the desk then lists, and refuses a name taken that day", () => {
  const { gs, sheets, cache } = load({ "Closed events": [["Fee", "Event", "Start", "Name"]] });
  const scriptCache = gs.CacheService.getScriptCache();
  gs.CacheService = { getScriptCache: () => ({ ...scriptCache, remove: (k) => { delete cache[k]; } }) };
  const formatDate = gs.Utilities.formatDate;
  gs.Utilities = { ...gs.Utilities, formatDate: (d, tz, f) => (f === "yyyy-MM-dd'T'HH:mm:ssXXX" ? "2026-10-16T18:05:00-06:00"
    : f === "yyyy-MM-dd" ? "2026-10-16" : formatDate(d, tz, f)) };
  const fetch = gs.UrlFetchApp.fetch;
  gs.UrlFetchApp = { ...gs.UrlFetchApp, fetch: (url, o) => (url.endsWith("/events.json")
    ? { getResponseCode: () => 200, getContentText: () => "[]" } : fetch(url, o)) };
  const made = gs.createEvent({ name: "Friday Blitz: Café Quad!", format: "quad", fee: "$10" });
  eq([made.ok, made.key], [true, "friday-blitz-cafe-quad/2026-10-16"]);
  eq(heading(sheets["Closed events"]), ["Fee", "Event", "Start", "Name", "Format", "Rounds"]);
  eq(rowsOf(sheets["Closed events"]), [{ Fee: "10", Event: "friday-blitz-cafe-quad", Start: "2026-10-16T18:05:00-06:00",
    Name: "Friday Blitz: Café Quad!", Format: "quad", Rounds: "" }]);
  const listed = gs.choices().find((c) => c.key === made.key);
  eq([listed.name, listed.format, listed.closed], ["Friday Blitz: Café Quad!", "quad", true]);
  eq(gs.createEvent({ name: "friday blitz cafe quad", format: "swiss" }), { error: "That name is taken today; choose another." });
  assert.ok(gs.createEvent({ name: " !! ", format: "quad" }).error);
  assert.ok(gs.createEvent({ name: "Blitz", format: "blitz" }).error);
  assert.ok(gs.createEvent({ name: "Blitz", format: "arena", fee: "ten" }).error);
  assert.equal(sheets["Closed events"].data.length, 2);
});

test("the desk lists a past tournament, though the calendar has dropped it, until US Chess has rated it", () => {
  const { gs, ratings, cache } = load({
    "Closed events": [["Fee", "Event", "Start", "Name", "Format", "Rounds"],
      ["10", "alley-cat-quad-2", "2026-10-17T09:00:00-06:00", "Alley Cat Quad 2", "quad", ""],
      ["10", "never-started", "2026-10-17T09:00:00-06:00", "Never Started", "quad", ""]],
    Tournaments: [["Key", "Event", "Name", "Format", "Rounds", "Status", "Round dates"],
      ["alley-cat-quad-2/2026-10-17", "alley-cat-quad-2", "Alley Cat Quad 2, Saturday, October 17, 2026", "quad", "3", "running", ""],
      ["first-saturday-classic/2026-10-03", "first-saturday-classic", "First Saturday Classic, Saturday, October 3, 2026", "swiss", "4", "running", ""],
      ["monday-club-night-at-peak/2026-09", "monday-club-night-at-peak", "Monday Club Night at Peak, all Mondays in September 2026", "swiss", "4",
        "running", '["2026-09-07","2026-09-14","2026-09-21","2026-09-28"]']],
  });
  const formatDate = gs.Utilities.formatDate;
  gs.Utilities = { ...gs.Utilities, formatDate: (d, tz, f) => (f === "yyyy-MM-dd" ? "2026-10-18"
    : f === "EEEE, MMMM d, yyyy" ? d.toLocaleDateString("en-US", { timeZone: "America/Denver", dateStyle: "full" })
    : f === "EEEE" ? d.toLocaleDateString("en-US", { timeZone: "America/Denver", weekday: "long" })
    : f === "MMMM yyyy" ? d.toLocaleDateString("en-US", { timeZone: "America/Denver", month: "long", year: "numeric" }) : formatDate(d, tz, f)) };
  const fetch = gs.UrlFetchApp.fetch;
  gs.UrlFetchApp = { ...gs.UrlFetchApp, fetch: (url, o) => (url.endsWith("/events.json")
    ? { getResponseCode: () => 200, getContentText: () => "[]" } : fetch(url, o)) };
  const listed = () => gs.choices().map((c) => [c.key, c.name, c.label, c.kind]);
  eq(listed(), [
    ["monday-club-night-at-peak/2026-09", "Monday Club Night at Peak", "all Mondays in September 2026", "month"],
    ["first-saturday-classic/2026-10-03", "First Saturday Classic", "Saturday, October 3, 2026", "entry"],
    ["alley-cat-quad-2/2026-10-17", "Alley Cat Quad 2", "Saturday, October 17, 2026", "entry"]]);
  ratings["first-saturday-classic/2026-10-03"] = "202610030001";
  delete cache.rated;
  eq(listed().map(([key]) => key), ["monday-club-night-at-peak/2026-09", "alley-cat-quad-2/2026-10-17"]);
});

test("New tournament makes the Closed events tab when it's missing", () => {
  const { gs, sheets } = load({});
  gs.clubEvents = () => ({});
  const made = gs.createEvent({ name: "Snow Day Swiss", format: "swiss", fee: "" });
  assert.equal(made.ok, true);
  eq(heading(sheets["Closed events"]), ["Event", "Name", "Start", "Format", "Rounds", "Fee"]);
  eq(rowsOf(sheets["Closed events"]).map((r) => [r.Event, r.Format, r.Fee]), [["snow-day-swiss", "swiss", ""]]);
});

for (const store of STORES) {
  test(`any section's format changes until its first round is posted, a round robin drawing its numbers by lot and its rounds from its players (${store})`, () => {
    const { gs, rows } = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    const key = "classic/2026-11-07";
    gs.clubEvents = () => ({ [key]: { event: "classic", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry" } });
    let registered = [["11111111", "Ann", "1900"], ["22222222", "Ben", "1800"], ["33333333", "Cal", "1700"], ["44444444", "Dee", "1600"],
      ["55555555", "Eve", "1500"], ["66666666", "Fay", "1300"], ["77777777", "Gus", "1200"]].map(([id, name, rating]) => ({ id, name, rating, out: "" }));
    gs.entries = () => registered;
    const p = { event: "classic", date: "2026-11-07" };
    const open = ["11111111", "22222222", "33333333", "44444444", "55555555"];
    assert.equal(gs.startTournament({ ...p, format: "swiss", rounds: "4", coin: "white",
      sections: '[{"name":"Open","format":"rr"},{"name":"Under 1400","under":1400}]' }).ok, true);
    const defs = () => JSON.parse(rows("Tournaments")[0].Sections);
    eq([...defs()[0].order].sort(), open, "the Open's players, in an order drawn by lot");
    eq(defs().map((d) => [d.name, d.format ?? "swiss", d.last]), [["Open", "rr", 5], ["Under 1400", "swiss", 4]]);
    assert.equal(rows("Tournaments")[0].Rounds, "5");
    const t = gs.tournament(key, true);
    eq(Pairing.sections(t).map((s) => [s.format, s.size]), [["rr", 5], ["swiss", null]]);
    // A new entrant before round 1 is drawn into the round robin, which plays one more round.
    registered = [...registered, { id: "88888888", name: "Hal", rating: "1450", out: "" }];
    gs.syncPlayers(key);
    eq([defs()[0].order.length, defs()[0].last, rows("Tournaments")[0].Rounds], [6, 5, "5"]);
    // Twice round, and the Under 1400 a round robin too.
    const names = (formats) => JSON.stringify(defs().map((d, i) => ({ from: d.name, name: d.name, format: formats[i] })));
    assert.equal(gs.setSectionNames({ ...p, sections: names(["drr", "rr"]) }).message,
      "Sections: Open (a double round robin), Under 1400 (a round robin).");
    eq(defs().map((d) => [d.format, d.order.length, d.last]), [["drr", 6, 10], ["rr", 2, 1]]);
    assert.equal(rows("Tournaments")[0].Rounds, "10");
    // Once a section has posted a round, it keeps its format, and its table has no room for anyone else.
    const order = defs()[0].order;
    gs.saveRound({ ...p, number: "1", post: "yes", byes: "[]", games: JSON.stringify([
      { board: 1, white: order[0], black: order[5], section: "Open", result: "" }, { board: 1, white: "66666666", black: "77777777", section: "Under 1400", result: "" }]) });
    assert.equal(gs.setSectionNames({ ...p, sections: names(["swiss", "rr"]) }).error, "Open has a posted round, so it stays a double round robin.");
    assert.match(gs.setSection({ ...p, id: "66666666", section: "Open" }).error, /has begun, so its table has no place for another player/);
    assert.match(gs.setRounds({ ...p, section: "Open", rounds: "4" }).error, /plays everyone/);
    // No byes in a round robin: its table pairs everyone.
    assert.equal(gs.saveRound({ ...p, number: "2", post: "no", games: "[]",
      byes: JSON.stringify([{ id: "66666666", kind: "half", points: 0.5, section: "Under 1400" }]) }).error,
      "A round robin has no half-point byes; make the round unplayed.");
  });
}

for (const store of STORES) {
  test(`a quad can become a Swiss, and an extra games section a round robin, which takes no one once it begins (${store})`, () => {
    const { gs, rows } = load({ Tournaments: [], Players: [], Rounds: [] }, {}, store);
    gs.clubEvents = () => ({ "quad/2026-11-14": { event: "quad", name: "Quad", label: "Saturday", kind: "entry" } });
    gs.entries = () => [...Array(8)].map((_, i) => ({ id: `9000001${i}`, name: `Q${i}`, rating: String(2000 - i * 50), out: "" }));
    const p = { event: "quad", date: "2026-11-14" };
    gs.startTournament({ ...p, format: "quad" });
    const defs = () => JSON.parse(rows("Tournaments")[0].Sections);
    const quadOrder = Pairing.sections(gs.tournament("quad/2026-11-14", true))[0].players.map((x) => x.id);
    assert.equal(gs.setSectionNames({ ...p, sections: '[{"from":"Quad 1","name":"Quad 1"},{"from":"Quad 2","name":"Quad 2","format":"swiss"}]' }).ok, true);
    eq(defs().map((d) => [d.name, d.format ?? "", d.last]), [["Quad 1", "", 3], ["Quad 2", "swiss", 3]]);
    eq(defs()[0].order, quadOrder, "Quad 1 keeps the numbers drawn when the quads were made");
    eq(Pairing.sections(gs.tournament("quad/2026-11-14", true)).map((s) => s.format), ["rr", "swiss"]);
    assert.equal(gs.setRounds({ ...p, section: "Quad 2", rounds: "4" }).ok, true);
    assert.equal(gs.addExtraSection({ ...p, name: "Extra games", format: "rr", players: '["90000010","90000014","90000015"]' }).message,
      "Extra games: 3 players, a round robin of 3 rounds from round 1.");
    const extra = defs().find((d) => d.extra);
    eq([extra.format, [...extra.order].sort(), extra.first, extra.last], ["rr", ["90000010", "90000014", "90000015"], 1, 3]);
    assert.equal(gs.addExtraPlayer({ ...p, section: "Extra games", id: "90000016" }).ok, true);
    eq([defs().find((d) => d.extra).order.length, defs().find((d) => d.extra).last], [4, 3]);
    gs.saveRound({ ...p, number: "1", post: "no", byes: "[]", games: JSON.stringify([{ board: 1, white: "90000010", black: "90000014", section: "Extra games" }]) });
    assert.match(gs.addExtraPlayer({ ...p, section: "Extra games", id: "90000017" }).error, /has begun/);
  });
}

test("the desk's messages: Voice's texts, voicemail, and missed calls from Gmail, newest first, with the caller's contact", () => {
  const { gs } = load({ Contacts: [["Name", "Email", "Phone", "Other phones"], ["Cora", "", "970-555-0103", ""], ["Dan", "", "", "(970) 555-0104, 303-555-0000"]] });
  const encoded = (text) => Buffer.from(text).toString("base64url");
  const mail = (id, at, subject, from, body) => ({ id, internalDate: String(Date.parse(at)),
    payload: { mimeType: "multipart/alternative", headers: [{ name: "Subject", value: subject }, { name: "From", value: from }],
      parts: [{ mimeType: "text/html", body: { data: encoded("<p>html</p>") } }, { mimeType: "text/plain", body: { data: encoded(body) } }] } });
  const mails = {
    m1: mail("m1", "2026-10-18T15:00:00Z", "New text message from Cora", "\"Cora (SMS)\" <19702867339.19705550103.abc@txt.voice.google.com>",
      "Running late, save me a board\r\n<https://voice.google.com/>\r\nTo respond to this text message, reply to this email or visit Google Voice.\r\nYOUR ACCOUNT HELP CENTER"),
    m2: mail("m2", "2026-10-19T09:30:00Z", "New voicemail from (970) 555-0104 at 3:30 AM", "Google Voice <voice-noreply@google.com>",
      "Hi, is there a tournament Saturday?\r\nPlay message\r\nhttps://voice.google.com/u/0/voicemail"),
    m3: mail("m3", "2026-10-17T20:00:00Z", "New missed call from (720) 555-0199", "Google Voice <voice-noreply@google.com>", "YOUR ACCOUNT"),
    m4: mail("m4", "2026-10-16T20:00:00Z", "Your Google Voice number is about to expire", "Google Voice <voice-noreply@google.com>", "Use it"),
  };
  const asked = [];
  const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
  const gmail = (url, options) => {
    asked.push([url, options.headers.Authorization]);
    const id = url.match(/messages\/(\w+)\?format=full$/);
    return id ? reply(200, mails[id[1]]) : reply(200, { messages: Object.keys(mails).map((m) => ({ id: m })) });
  };
  gs.UrlFetchApp = { fetch: gmail, fetchAll: (requests) => requests.map((r) => gmail(r.url, r)) };
  const { messages } = gs.voiceMessages();
  eq(messages.map(({ id, kind, phone, from, name, text }) => [id, kind, phone, from, name, text]), [
    ["m2", "Voicemail", "9705550104", "(970) 555-0104", "Dan", "Hi, is there a tournament Saturday?"],
    ["m1", "Text", "9705550103", "(970) 555-0103", "Cora", "Running late, save me a board"],
    ["m3", "Missed call", "7205550199", "(720) 555-0199", "", ""]]);
  assert.equal(messages[0].at, "2026-10-19T09:30:00.000Z");
  assert.ok(decodeURIComponent(asked[0][0]).includes("q=from:(txt.voice.google.com OR voice-noreply@google.com)"), asked[0][0]);
  assert.ok(asked.every(([, auth]) => auth === "Bearer president-token"));
  gs.UrlFetchApp = { fetch: () => reply(403, { error: { message: "Insufficient Permission" } }) };
  const realError = console.error;
  console.error = () => {};
  assert.match(gs.voiceMessages().error, /Gmail didn't answer/);
  console.error = realError;
});
