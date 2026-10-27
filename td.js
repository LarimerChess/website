// The TD desk (td/): register players by US Chess ID or name, and remove entries. Once FIREBASE
// (register.js) is set, TDs sign in with Firebase Authentication, with Google or a link sent by
// email, and every call carries the Firebase ID token, which the Apps Script
// (scripts/registration.gs) checks; until then every call carries the shared password, which it
// checks against its TD_PASSWORD property. ENDPOINT, LIVE_DB, and FIREBASE come from register.js,
// listenLive from live.js.

const login = document.querySelector(".td-login");
const loginStatus = login.querySelector(".td-login-status");
const desk = document.querySelector(".td-desk");
// The event menu is in the menu bar, since the whole desk shows that one event.
const navEvent = document.querySelector(".td-nav-event");
const registerForm = document.querySelector(".td-register");
const choice = document.getElementById("td-event");
const playerInput = document.getElementById("td-player");
const playerList = document.getElementById("td-players");
const chosen = document.querySelector(".td-chosen");
const tdByes = document.querySelector(".td-byes");
const deskStatus = document.querySelector(".td-register-status");
const tdEntriesStatus = document.querySelector(".td-entries-status");
const tdTable = document.querySelector(".td-entries");
const incidentDialog = document.querySelector(".td-incident");
const incidentForm = incidentDialog.querySelector("form");
const incidentList = document.querySelector(".td-incidents");
const incidentsStatus = document.querySelector(".td-incidents-status");
const ledgerList = document.querySelector(".td-ledger");

// The ? buttons show their explanation on hover or focus. A tap keeps it open until another tap
// anywhere, and Escape hides any shown until the pointer or focus comes to it again.
document.addEventListener("click", (event) => {
  const button = event.target.closest(".hint-button");
  for (const open of document.querySelectorAll('.hint-button[aria-expanded="true"]')) {
    if (open !== button) open.setAttribute("aria-expanded", "false");
  }
  if (button) button.setAttribute("aria-expanded", String(button.getAttribute("aria-expanded") !== "true"));
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const hint of document.querySelectorAll(".hint")) {
    hint.dataset.dismissed = "";
    hint.querySelector(".hint-button").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("pointerenter", (event) => {
  if (event.target.classList?.contains("hint")) event.target.removeAttribute("data-dismissed");
}, true);
document.addEventListener("focusin", (event) => event.target.closest?.(".hint")?.removeAttribute("data-dismissed"));
let password = "";
let signedIn = false;
// The Firebase Auth instance and the SDK's functions, once FIREBASE has loaded them.
let firebase = null;
// The TD the script recognized from the Firebase sign-in: { email, name, usChessId }.
let td = null;
let incidentPlayer = null;
let player = null;
let choices = [];
// Everyone who has registered, and the club's contacts ({ headings, contacts }), loaded at sign-in so
// the player search runs here as the TD types. They stay in this page's memory only.
let people = [];
let contactBook = { headings: [], contacts: [] };

async function loadPeople() {
  const [{ players = [] }, book] = await Promise.all([call("people"), call("contacts")]);
  people = players;
  if (book.contacts) contactBook = book;
  document.dispatchEvent(new Event("td-contacts"));
}

function deskButton(text, spoken) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "td-action";
  button.textContent = text;
  button.append(hidden(spoken));
  return button;
}

function hidden(text) {
  const span = document.createElement("span");
  span.className = "visually-hidden";
  span.textContent = text;
  return span;
}

function remembered() {
  try { return sessionStorage.getItem("tdPassword") || ""; } catch { return ""; }
}

function remember(value) {
  try { value ? sessionStorage.setItem("tdPassword", value) : sessionStorage.removeItem("tdPassword"); } catch {}
}

// A random ID that stays on this device, so the registration script can trust a device that has
// signed in before and not lock it out for anyone else's wrong passwords.
function deviceId() {
  try {
    let id = localStorage.getItem("lccc-td-device");
    if (!id) localStorage.setItem("lccc-td-device", id = crypto.randomUUID());
    return id;
  } catch {
    return "";
  }
}

async function credentials() {
  if (!FIREBASE) return { password, device: deviceId() };
  const user = firebase?.auth.currentUser;
  return user ? { idToken: await user.getIdToken() } : {};
}

/** The script's answer to a desk action, without call's handling of a sign-in it refused. */
async function ask(action, fields = {}) {
  const response = await fetch(ENDPOINT, {
    method: "POST", body: new URLSearchParams({ action, ...(await credentials()), ...fields }),
  });
  return response.json();
}

// Sign-in shows its own errors beside its form, and the background check for changes stays quiet.
const QUIET = new Set(["login", "changes"]);
const refusedDialog = document.querySelector(".td-refused");

/** Pops up why something wasn't done: a status line is often out of sight, as from the entries list at the
 *  bottom of the page. The status line keeps it too, when given, and a dialog already open shows its own. */
function refuse(message, status) {
  if (status) status.textContent = message;
  if (document.querySelector("dialog[open]")) return;
  refusedDialog.querySelector(".td-refused-message").textContent = message;
  refusedDialog.showModal();
}

async function call(action, fields = {}) {
  const result = await ask(action, fields).catch((error) => {
    if (!QUIET.has(action)) refuse("Couldn't reach the registration service, so nothing was saved. Try again.");
    throw error;
  });
  const user = firebase?.auth.currentUser;
  if (result.verify && user) {
    await firebase.sendEmailVerification(user, { url: deskAddress() }).catch(() => {});
    signOut("Check your email for a link to confirm your address, then sign in again.");
  } else if (result.login) {
    signOut(result.error);
  } else if (result.error && !QUIET.has(action)) {
    refuse(result.error);
  }
  return result;
}

function signOut(message = "") {
  password = "";
  remember("");
  signedIn = false;
  td = null;
  if (firebase?.auth.currentUser) firebase.signOut(firebase.auth).catch(() => {});
  desk.hidden = navEvent.hidden = true;
  showLogin(message);
}

/** Shows the sign-in form's status, and its buttons only when ask is set: the desk shows them only
 *  once it knows the TD has to sign in, not while it is still checking a sign-in. */
function showLogin(message = loginStatus.textContent, ask = true) {
  login.hidden = false;
  loginStatus.textContent = message;
  for (const part of login.querySelectorAll(".td-login-password, .td-login-accounts")) part.hidden = !ask;
}

async function signIn(value = "") {
  password = value;
  // Each call to the script takes a second or more, so with Firebase the event list is asked for
  // alongside the sign-in. A password's isn't, since a wrong one would count twice toward the lockout.
  const early = FIREBASE ? ask("choices").catch(() => ({})) : null;
  const result = await call("login");
  if (!result.ok) {
    if (FIREBASE && !result.login && !result.verify) signOut(result.error || "Sign-in didn't work. Try again.");
    return false;
  }
  signedIn = true;
  seen = result.changes || null;
  checked = Date.now();
  if (!FIREBASE) remember(value);
  td = result.td || null;
  const who = document.querySelector(".td-who");
  who.textContent = td ? `Signed in as ${td.name || td.email}` : "";
  who.hidden = !td;
  login.hidden = true;
  desk.hidden = navEvent.hidden = false;
  const { choices: list } = await (early || call("choices"));
  fillChoices(list);
  showRegisterByes();
  showDeskEntries();
  loadPeople();
  return true;
}

function fillChoices(list) {
  choices = list || [];
  const groups = new Map();
  for (const c of choices) {
    if (!groups.has(c.name)) groups.set(c.name, []);
    groups.get(c.name).push(c);
  }
  choice.replaceChildren(...[...groups].map(([name, items]) => {
    const group = document.createElement("optgroup");
    group.label = name;
    for (const c of items) group.append(new Option(`${c.name}, ${c.label}`, c.key));
    return group;
  }));
}

// The sign-in never leaves the page, so the browser may not notice it succeeded; handing it the
// password once it has worked lets Chrome and others offer to save it.
function offerToSave(value) {
  if (!window.PasswordCredential || !navigator.credentials?.store) return;
  navigator.credentials.store(new PasswordCredential({ id: "TD desk", password: value, name: "Larimer County Chess Club TD desk" }))
    .catch(() => {});
}

login.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (firebase) return emailLink();
  loginStatus.textContent = "Signing in…";
  try {
    const value = login.elements.password.value;
    if (await signIn(value)) {
      offerToSave(value);
      login.reset();
    }
  } catch {
    loginStatus.textContent = "Couldn't reach the registration service. Try again.";
  }
});

document.querySelector(".td-sign-out").addEventListener("click", () => signOut("Signed out."));
const refreshButton = document.querySelector(".td-refresh");
refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  deskStatus.textContent = "Refreshing…";
  const result = await call("refresh");
  deskStatus.textContent = result.message || result.error;
  refreshButton.disabled = false;
});

// The player search: a combobox whose list fills as you type, by ID or name.
let searchCount = 0;
let active = -1;

function setActive(index) {
  const options = [...playerList.children];
  active = Math.max(-1, Math.min(index, options.length - 1));
  options.forEach((o, i) => o.setAttribute("aria-selected", String(i === active)));
  if (active >= 0) {
    playerInput.setAttribute("aria-activedescendant", options[active].id);
    options[active].scrollIntoView({ block: "nearest" });
  } else {
    playerInput.removeAttribute("aria-activedescendant");
  }
}

function closeList() {
  playerList.hidden = true;
  playerInput.setAttribute("aria-expanded", "false");
  setActive(-1);
}

function choose(p) {
  // A contact who hasn't registered is looked up at US Chess, by ID if the contact has one.
  if (p.contact) {
    playerInput.value = p.name;
    return searchUsChess(p.id || p.name, `US Chess has no member ${p.id ? "with that ID" : "by that name"}.`);
  }
  player = p;
  playerInput.value = `${p.name} (${p.id})`;
  const current = choices.find((c) => c.key === choice.value);
  const lapsed = p.expires && current && p.expires < current.first;
  chosen.textContent = `${p.name}, US Chess ID ${p.id}, ${p.state ? `${p.state}, ` : ""}rating ${p.rating || "unrated"}, `
    + (p.expires ? `membership ${lapsed ? "expires before the event: " : "until "}${p.expires}.` : "no membership on record.")
    + (p.phone ? ` Phone: ${p.phone}.` : "");
  // A past registration or the club's contacts give the email; the TD can change or clear it.
  if (p.email && !registerForm.elements.email.value) registerForm.elements.email.value = p.email;
  closeList();
}

const uschessRow = document.querySelector(".td-uschess");
const uschessButton = document.querySelector(".td-search-uschess");

function showPlayers(players, empty) {
  playerList.replaceChildren(...players.map((p, i) => {
    const option = document.createElement("li");
    option.id = `td-player-${i}`;
    option.setAttribute("role", "option");
    option.textContent = p.contact ? `${p.name} · ${p.id || "no US Chess ID"} · contact, look up at US Chess`
      : `${p.name} · ${p.id} · ${p.rating || "unrated"}` + (p.known ? " · registered before" : ` · ${p.state || "–"}`);
    option.addEventListener("mousedown", (e) => { e.preventDefault(); choose(p); });
    option.player = p;
    return option;
  }));
  if (!players.length) {
    const none = document.createElement("li");
    none.className = "td-none";
    none.textContent = empty;
    playerList.replaceChildren(none);
  }
  playerList.hidden = false;
  playerInput.setAttribute("aria-expanded", "true");
  setActive(-1);
}

/** Past registrations, then contacts not among them, matching an ID's digits or every word of a name. */
function localMatches(q) {
  const words = q.toLowerCase().split(/\s+/);
  const digits = /^\d+$/.test(q);
  const hit = (name, id) => (digits ? (id || "").startsWith(q) : words.every((w) => name.toLowerCase().includes(w)));
  const known = new Set(people.map((p) => p.id));
  const contacts = contactBook.contacts
    .filter((c) => c.Name && !known.has(c["US Chess ID"]) && hit(c.Name, c["US Chess ID"]))
    .map((c) => ({ name: c.Name, id: c["US Chess ID"] || "", email: c.Email || "", phone: c.Phone || "", contact: true }));
  return [...people.filter((p) => hit(p.name, p.id)), ...contacts].slice(0, 12);
}

async function searchUsChess(q, empty) {
  const mine = ++searchCount;
  uschessButton.disabled = true;
  try {
    const { players = [] } = await call("search", { q });
    if (mine === searchCount) showPlayers(players, empty);
  } finally {
    uschessButton.disabled = false;
  }
}

// US Chess is asked only for a full eight-digit ID nobody here has registered with, for a contact
// picked from the list, or when the TD presses Search US Chess for a name; everything else is
// searched here, in what loaded at sign-in.
playerInput.addEventListener("input", () => {
  player = null;
  chosen.textContent = "";
  uschessRow.hidden = true;
  const q = playerInput.value.trim();
  ++searchCount;
  if (q.length < 2) return closeList();
  if (/^\d{9,}$/.test(q)) return showPlayers([], "A US Chess ID is eight digits.");
  const found = localMatches(q);
  if (/^\d{8}$/.test(q) && !found.some((p) => p.id === q)) return searchUsChess(q, "US Chess has no member with that ID.");
  showPlayers(found, /^\d+$/.test(q) ? "Keep typing: a US Chess ID is eight digits." : "Nobody by that name has registered here or is a contact.");
  if (!/^\d+$/.test(q)) {
    uschessButton.textContent = `Search US Chess for “${q}”`;
    uschessRow.hidden = false;
  }
});

uschessButton.addEventListener("click", async () => {
  await searchUsChess(playerInput.value.trim(), "US Chess has nobody by that name.");
  playerInput.focus();
});

playerInput.addEventListener("keydown", (event) => {
  if (playerList.hidden) return;
  if (event.key === "ArrowDown") { event.preventDefault(); setActive(active + 1); }
  else if (event.key === "ArrowUp") { event.preventDefault(); setActive(active - 1); }
  else if (event.key === "Enter" && active >= 0) { event.preventDefault(); choose(playerList.children[active].player); }
  else if (event.key === "Escape") closeList();
});
playerInput.addEventListener("blur", closeList);

choice.addEventListener("change", () => {
  if (player) choose(player);
  loadedTournament = null;
  showRegisterByes();
  showDeskEntries();
});

// The tournament td-run.js last loaded for the chosen event, kept while it loads again: once it has
// started, its rounds and nights are the ones a bye can be asked for.
let loadedTournament = null;
const andList = new Intl.ListFormat("en-US");

/** "October 19" for 2026-10-19, in UTC, since a date alone is read as midnight UTC. */
function byeDate(date) {
  return new Date(date).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric" });
}

/** A month's nights in words: "October 19 and 26". */
function nightsInWords(dates) {
  const [first, ...rest] = [...dates].sort();
  return andList.format([byeDate(first), ...rest.map((date) => String(Number(date.slice(8))))]);
}

/** The rounds a bye can be asked for in key's event, [{ value, label, paired }]: a one-day Swiss's
 *  rounds, or a month's nights, and none for a night, a quad, or an arena. */
function byeRounds(key) {
  const item = choices.find((c) => c.key === key);
  const t = loadedTournament?.key === key ? loadedTournament : null;
  if (!item || item.kind === "night" || ["quad", "arena"].includes(t ? t.format : item.format)) return [];
  const paired = (i) => i < (t?.rounds.length || 0);
  if (item.kind === "month") {
    // Past nights have left the choices, so a started month goes by its own dates.
    if (t?.roundDates) return t.roundDates.map((date, i) => ({ value: date, label: byeDate(date), paired: paired(i) }));
    return choices.filter((c) => c.kind === "night" && c.key.startsWith(`${key}-`)).map((c) => c.key.split("/")[1])
      .map((date) => ({ value: date, label: byeDate(date), paired: false }));
  }
  return [...Array(Number(t?.plannedRounds || item.rounds) || 0)]
    .map((_, i) => ({ value: String(i + 1), label: `Round ${i + 1}`, paired: paired(i) }));
}

/** The register form's Byes for the chosen event, keeping the boxes checked when keep is set, as when its
 *  tournament loads again. A round already paired isn't offered: the TD gives it under Byes and unplayed rounds. */
function showRegisterByes(keep = false) {
  const kept = new Set(keep ? [...tdByes.querySelectorAll(":checked")].map((box) => box.value) : []);
  const rounds = byeRounds(choice.value).filter((r) => !r.paired);
  tdByes.querySelector(".td-byes-boxes").replaceChildren(...rounds.map(({ value, label }) => {
    const wrap = document.createElement("label");
    wrap.append(Object.assign(document.createElement("input"), { type: "checkbox", value, checked: kept.has(value) }), ` ${label}`);
    return wrap;
  }));
  tdByes.hidden = !rounds.length;
}

/** An entry's Byes: a menu for each round or night it can ask to miss, to play or ask for a half-point or zero-point
 *  bye, saved as soon as it changes, then in words any asked for that no menu shows, as when the rounds aren't known.
 *  A paired round's menu is shown but fixed. */
function showEntryByes(cell, e) {
  const [eventName] = choice.value.split("/");
  const month = e.date?.length === 7;
  const rounds = month ? byeRounds(`${eventName}/${e.date}`)
    : choices.find((c) => c.key === choice.value)?.kind === "entry" ? byeRounds(choice.value) : [];
  const asked = e.byes || [], zeros = e.zeroByes || [];
  const menus = rounds.map(({ value, label, paired }) => {
    const menu = Object.assign(document.createElement("select"), { disabled: paired });
    menu.append(option("", "–", false), option("half", "½", false), option("zero", "0", false));
    menu.value = asked.includes(value) ? "half" : zeros.includes(value) ? "zero" : "";
    menu.dataset.round = value;
    menu.dataset.was = menu.value;
    menu.setAttribute("aria-label", `${label} bye for ${e.name}`);
    menu.addEventListener("change", () => saveEntryByes(cell, e, menu));
    const wrap = document.createElement("label");
    // The script refuses a paired round's change from here, even the TD's.
    if (paired) wrap.title = "Already paired: change it under Standings and byes, in Give a bye.";
    // A round shows its number alone, to keep the table narrow.
    wrap.append(`${month ? label : value} `, menu);
    return wrap;
  });
  const inWords = (list, kind) => {
    const unshown = list.filter((b) => !rounds.some((r) => r.value === b));
    if (!unshown.length) return "";
    return `${month ? nightsInWords(unshown) : `${unshown.length > 1 ? "Rounds" : "Round"} ${andList.format(unshown)}`}${zeros.length ? ` (${kind})` : ""}`;
  };
  const words = [inWords(asked, "half-point"), inWords(zeros, "zero-point")].filter(Boolean).join("; ");
  cell.replaceChildren(...menus.flatMap((wrap) => [wrap, " "]), words);
}

/** Saves an entry's byes with menu changed, or puts the menu back if the script refuses. The lists
 *  sent keep what no menu shows. */
async function saveEntryByes(cell, e, menu) {
  const menus = cell.querySelectorAll("select:enabled");
  const round = menu.dataset.round;
  const sorted = (list) => list.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const byes = sorted([...(e.byes || []).filter((b) => b !== round), ...(menu.value === "half" ? [round] : [])]);
  const zeroByes = sorted([...(e.zeroByes || []).filter((b) => b !== round), ...(menu.value === "zero" ? [round] : [])]);
  for (const m of menus) m.disabled = true;
  const result = await call("byes", { token: e.token, byes: byes.join(", "), zeroByes: zeroByes.join(", ") })
    .catch(() => ({ error: "Couldn't reach the registration service. Try again." }));
  deskStatus.textContent = result.message || result.error;
  if (result.ok) {
    Object.assign(e, { byes, zeroByes });
    menu.dataset.was = menu.value;
  } else {
    menu.value = menu.dataset.was;
  }
  for (const m of menus) m.disabled = false;
  // The tournament has a copy, which check-in starts from.
  if (result.ok) {
    pending.add("run");
    applyChanges();
  }
}

// The event and the rounds offered when the entries were last drawn: a tournament that loads,
// starts, or changes its rounds after that can change the entries' boxes.
let entriesDrawn = null;
const byeShape = (key) => byeRounds(key).map((r) => r.value).join();

document.addEventListener("td-tournament", (event) => {
  loadedTournament = event.detail;
  showRegisterByes(true);
  if (entriesDrawn?.key === choice.value && entriesDrawn.shape !== byeShape(choice.value)) {
    pending.add("entries");
    applyChanges();
  }
});

// Saving takes a few seconds, so Register hands the player off and clears the form at once: the
// TD can fill in the next player while earlier ones save. Each shows in the list below the form
// until the script answers, then says how it went; one that failed can be tried again.
const saving = document.querySelector(".td-saving");

function save(job, item) {
  item.className = "td-save-pending";
  item.replaceChildren(`Saving ${job.player.name} (${job.player.id}) for ${job.label}…`);
  call("register", job.fields)
    .then((result) => {
      item.className = result.ok ? "td-save-done" : "td-save-failed";
      item.replaceChildren(result.message || result.error);
      deskStatus.textContent = result.message || result.error;
      if (result.ok) {
        showDeskEntries();
        loadPeople();
      }
      else retry(job, item);
    })
    .catch(() => {
      item.className = "td-save-failed";
      item.replaceChildren(`${job.player.name} didn't go through.`);
      deskStatus.textContent = `${job.player.name} didn't go through.`;
      retry(job, item);
    });
}

function retry(job, item) {
  const again = document.createElement("button");
  again.type = "button";
  again.className = "td-action";
  again.textContent = "Try again";
  again.append(hidden(` for ${job.player.name}`));
  again.addEventListener("click", () => save(job, item));
  item.append(" ", again);
}

registerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!player) {
    playerInput.focus();
    return refuse("Pick a player from the list first.", deskStatus);
  }
  const [eventName, date] = choice.value.split("/");
  const byes = [...tdByes.querySelectorAll(":checked")].map((box) => box.value).join(", ");
  const job = {
    player, label: choice.selectedOptions[0]?.textContent || choice.value,
    fields: { event: eventName, date, id: player.id, category: registerForm.elements.category.value,
      email: registerForm.elements.email.value, phone: player.phone || "", ...(byes ? { byes } : {}) },
  };
  const item = document.createElement("li");
  saving.prepend(item);
  save(job, item);
  deskStatus.textContent = `Saving ${player.name}. You can fill in the next player.`;
  player = null;
  playerInput.value = "";
  chosen.textContent = "";
  registerForm.elements.email.value = "";
  registerForm.elements.category.value = "";
  for (const box of tdByes.querySelectorAll(":checked")) box.checked = false;
  playerInput.focus();
});

/** Shows the chosen event's entries, ledger, and incidents, and has the tournament follow; quietly,
 *  for another desk's change, it leaves the status line and the tournament alone. */
async function showDeskEntries(quiet = false) {
  const key = choice.value;
  if (!key) {
    tdEntriesStatus.textContent = "No club events are open.";
    return;
  }
  const [eventName, date] = key.split("/");
  if (!quiet) tdEntriesStatus.textContent = "Loading entries…";
  // None of these waits on the entries, which take the script longest.
  showLedger(eventName, date);
  showIncidents(eventName, date);
  if (!quiet) document.dispatchEvent(new Event("td-choice"));
  const { entries = [] } = await call("entries", { event: eventName, date });
  if (key !== choice.value) return;
  document.dispatchEvent(new CustomEvent("td-entries", { detail: { key, entries } }));
  const total = (field) => entries.reduce((sum, e) => sum + (Number(e[field]) || 0), 0);
  // A script from before part payments sends no balance.
  for (const e of entries) if (!("balance" in e)) e.balance = e.paid ? "0" : e.due;
  const owed = total("balance");
  const dollars = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  tdEntriesStatus.textContent = entries.length
    ? `${entries.length} ${entries.length === 1 ? "player" : "players"}. Collected: $${dollars(total("paid") - total("refunded"))}. Still owed: $${dollars(owed)}.`
    : "No entries yet.";
  const current = choices.find((c) => c.key === key);
  entriesDrawn = { key, shape: byeShape(key) };
  tdTable.tBodies[0].replaceChildren(...entries.map((e) => {
    const row = document.createElement("tr");
    const lapsed = e.expires && current && e.expires < current.first;
    const off = [e.credit && `$${e.credit} credit`, e.discount && `$${e.discount} discount`].filter(Boolean).join(" and ");
    for (const text of [e.name, e.id, e.rating || "Unrated", e.for]) row.insertCell().textContent = text;
    showEntryByes(row.insertCell(), e);
    for (const text of [e.category || "?", e.due === "" ? "?" : `$${e.due}${off ? ` after ${off}` : ""}`]) {
      row.insertCell().textContent = text;
    }
    const send = async (button, action, fields) => {
      button.disabled = true;
      const result = await call(action, { token: e.token, ...fields });
      deskStatus.textContent = result.message || result.error;
      showDeskEntries();
    };
    // A discount lowers the fee, for a hardship or a scholarship; the club turns no one away.
    const discount = deskButton("Discount", ` for ${e.name}`);
    discount.addEventListener("click", () => {
      const amount = prompt(`Discount for ${e.name} in dollars, up to the fee${e.amount ? `, $${e.amount}` : ""}. 0 removes it.`,
        e.discount || e.due);
      if (amount === null) return;
      const note = Number(amount) ? prompt("Reason, such as hardship (optional)", "") : "";
      if (note === null) return;
      send(discount, "discount", { amount, note });
    });
    row.insertCell().append(discount);
    // On a night's list, a whole month can become just this night, as when a player decides at the end
    // of the night not to come back; what was paid moves to the night, and the rest is refunded.
    if (e.date?.length === 7 && current?.kind === "night") {
      const toNight = deskButton("This night only", ` for ${e.name}`);
      toNight.addEventListener("click", () => {
        if (!confirm(`Switch ${e.name} from the whole month to ${current.label} only? What was paid moves to the night.`)) return;
        send(toNight, "toNight", { event: eventName, date });
      });
      row.cells[3].append(" ", toNight);
    }
    // On the month's list, the TD picks the night. Only nights still to come can be picked, since the
    // script knows a night from events.json, which drops it once it has passed.
    const nights = e.date?.length === 7 && current?.kind === "month"
      ? choices.filter((c) => c.kind === "night" && c.key.startsWith(`${eventName}/${e.date}-`)) : [];
    if (nights.length) {
      const night = document.createElement("select");
      night.setAttribute("aria-label", `Night for ${e.name}`);
      for (const c of nights) night.add(new Option(c.label.replace(/^\w+, |, \d{4}$/g, ""), c.key.split("/")[1]));
      const toNight = deskButton("One night only", ` for ${e.name}`);
      toNight.addEventListener("click", () => {
        if (!confirm(`Switch ${e.name} from the whole month to ${night.selectedOptions[0].text} only? What was paid moves to the night.`)) return;
        send(toNight, "toNight", { event: eventName, date: night.value });
      });
      row.cells[3].append(" ", night, " ", toNight);
    }
    // A club night's entry can become its month's, which moves the night and credits what was paid for it.
    const month = e.date?.length === 10 && choices.find((c) => c.key === `${eventName}/${e.date.slice(0, 7)}` && c.kind === "month");
    if (month) {
      const toMonth = document.createElement("button");
      toMonth.type = "button";
      toMonth.className = "td-action td-month";
      toMonth.textContent = "Whole month";
      toMonth.append(hidden(` for ${e.name}`));
      toMonth.addEventListener("click", async () => {
        if (!confirm(`Change ${e.name} to ${month.label}?`)) return;
        toMonth.disabled = true;
        const [, date] = month.key.split("/");
        const result = await call("register", { event: eventName, date, id: e.id, category: e.category, email: e.email, phone: e.phone || "" });
        deskStatus.textContent = result.message || result.error;
        showDeskEntries();
      });
      row.cells[3].append(" ", toMonth);
    }
    // Marking paid asks for the amount, which can differ from the fee under the hardship waiver; by
    // card, it starts from the fee with the card fee. Paying less leaves the rest owed, for another payment.
    const paidCell = row.insertCell();
    if (e.paid) {
      const unpaid = deskButton(`$${e.paid}${e.paidBy ? ` ${e.paidBy}` : ""} ✓`, ` paid by ${e.name}; mark unpaid`);
      unpaid.addEventListener("click", () => {
        if (confirm(`Mark ${e.name} unpaid?`)) send(unpaid, "paid", { amount: "", by: "" });
      });
      paidCell.append(unpaid);
    }
    if (!e.paid || Number(e.balance) > 0) {
      const method = document.createElement("select");
      method.className = "td-method";
      method.setAttribute("aria-label", `How ${e.name} paid`);
      for (const m of ["Cash", "Check", "Card", "Other"]) method.add(new Option(m, m.toLowerCase()));
      const pay = deskButton(e.paid ? "Add payment" : "Mark paid", ` for ${e.name}`);
      pay.addEventListener("click", () => {
        const by = method.value;
        const owed = by === "card" ? e.card || e.balance : e.balance;
        const amount = prompt(`Amount ${e.name} paid by ${by}`, owed);
        if (amount === null) return;
        const over = Number(amount.replace(/^\$/, "")) - Number(owed);
        const donate = owed !== "" && over > 0.005
          && confirm(`That is $${dollars(over)} more than the $${owed} due. OK records it as ${e.name}'s donation to the club;`
            + " Cancel counts it toward the fee, to refund.") ? "1" : "";
        send(pay, "paid", { amount, by, donate });
      });
      if (e.paid) paidCell.append(` $${e.balance} due `);
      paidCell.append(method, " ", pay);
    }
    if (e.donation) paidCell.append(` + $${e.donation} donation`);
    if (e.refunded) paidCell.append(` refunded $${e.refunded}`);
    // A refund goes back the way they paid; the card fee isn't refunded, since the processor keeps it.
    if (e.refundable) {
      const refund = deskButton(e.over ? `Refund $${e.over}` : "Refund", ` to ${e.name}`);
      refund.addEventListener("click", () => {
        const by = e.paidBy.split(", ").at(-1) || "cash";
        const amount = prompt(`Amount refunded to ${e.name} by ${by}, up to $${e.refundable}`, e.over || e.refundable);
        if (amount === null) return;
        send(refund, "refund", { amount, by });
      });
      paidCell.append(" ", refund);
    }
    for (const text of [lapsed ? `Expires ${e.expires}` : e.expires ? "Current" : "None", e.email || ""]) {
      row.insertCell().textContent = text;
    }
    if (e.out) {
      row.classList.add("td-out");
      row.cells[0].append(` (${e.out})`);
    }
    const report = document.createElement("button");
    report.type = "button";
    report.className = "td-action";
    report.textContent = "Incident";
    report.append(hidden(` for ${e.name}`));
    report.addEventListener("click", () => openIncident(e));
    row.insertCell().append(report);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "td-action";
    remove.textContent = "Remove";
    remove.append(hidden(` ${e.name}`));
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove ${e.name}?`)) return;
      remove.disabled = true;
      const result = await call("remove", { token: e.token });
      deskStatus.textContent = result.message || result.error;
      showDeskEntries();
    });
    row.insertCell().append(remove);
    return row;
  }));
  tdTable.hidden = !entries.length;
}

async function showLedger(eventName, date) {
  const { ledger } = await call("ledger", { event: eventName, date });
  if (!ledger || `${eventName}/${date}` !== choice.value) return;
  const r = ledger.received;
  const lines = [
    `Received: cash $${r.cash}, check $${r.check}, card $${r.card}, other $${r.other}.`,
    `Entry fees, Peak's facility donation: $${ledger.entry}.`,
    `Rating fees: $${ledger.rating}.`
      + (ledger.games === null ? "" : ` US Chess charges $${ledger.uschess} for the ${ledger.games} rated ${ledger.games === 1 ? "game" : "games"} played so far.`),
    `Card fees, for the processor: $${ledger.card}.`,
    ...(Number(ledger.donation) ? [`Donations to the club: $${ledger.donation}.`] : []),
  ];
  ledgerList.replaceChildren(...lines.map((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
  }));
}

async function showIncidents(eventName, date) {
  const { incidents = [] } = await call("incidents", { event: eventName, date });
  if (`${eventName}/${date}` !== choice.value) return;
  incidentsStatus.textContent = incidents.length ? "" : "Nothing logged for this.";
  incidentList.replaceChildren(...incidents.map((i) => {
    const item = document.createElement("li");
    item.textContent = `${i.logged} · ${i.name} (${i.id}) · ${i.action}`
      + (i.round ? `, round ${i.round}` : "") + (i.until ? `, until ${i.until}` : "")
      + ` · ${i.date} · ${i.td}: ${i.reason}`;
    return item;
  }));
}

function openIncident(entry) {
  incidentPlayer = entry;
  incidentForm.reset();
  incidentDialog.querySelector(".td-until").hidden = true;
  incidentDialog.querySelector(".td-incident-player").textContent =
    `${entry.name}, US Chess ID ${entry.id}. ${choice.selectedOptions[0]?.textContent || ""}`;
  incidentDialog.querySelector(".td-incident-status").textContent = "";
  incidentForm.elements.td.value = td?.name || "";
  try { incidentForm.elements.td.value ||= localStorage.getItem("tdName") || ""; } catch {}
  incidentDialog.showModal();
}

incidentForm.elements.action_taken.addEventListener("change", () => {
  incidentDialog.querySelector(".td-until").hidden = incidentForm.elements.action_taken.value !== "Barred from club events";
});
incidentForm.querySelector('[value="cancel"]').addEventListener("click", () => incidentDialog.close());
incidentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [eventName, date] = choice.value.split("/");
  const status = incidentDialog.querySelector(".td-incident-status");
  status.textContent = "Logging…";
  const fields = Object.fromEntries(new FormData(incidentForm));
  try { localStorage.setItem("tdName", fields.td); } catch {}
  const result = await call("incident", { ...fields, event: eventName, date, id: incidentPlayer.id });
  if (!result.ok) {
    status.textContent = result.error;
    return;
  }
  incidentDialog.close();
  deskStatus.textContent = result.message;
  showDeskEntries();
});

const createDialog = document.querySelector(".td-create");
const createForm = createDialog.querySelector("form");
document.querySelector(".td-new-event").addEventListener("click", () => {
  createForm.reset();
  createDialog.querySelector(".td-create-status").textContent = "";
  createDialog.showModal();
});
createForm.querySelector('[value="cancel"]').addEventListener("click", () => createDialog.close());
createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = createDialog.querySelector(".td-create-status");
  const button = createForm.querySelector('[type="submit"]');
  status.textContent = "Creating…";
  button.disabled = true;
  try {
    const result = await call("createEvent", Object.fromEntries(new FormData(createForm)));
    if (!result.ok) {
      status.textContent = result.error;
      return;
    }
    const { choices: list } = await call("choices");
    fillChoices(list);
    choice.value = result.key;
    createDialog.close();
    deskStatus.textContent = result.message;
    choice.dispatchEvent(new Event("change"));
  } catch {
    status.textContent = "Couldn't reach the registration service. Try again.";
  } finally {
    button.disabled = false;
  }
});

// Changes from another desk or the website show without a reload: the desk follows the change
// stamps in the live database (LIVE_DB), or else every few seconds asks the script for them
// (changes), and reloads what has a new one, holding back what the TD is in the middle of: a menu
// or field in the entries, or unsaved work in the tournament (runBusy). While the stream is
// down for longer than a check's wait, or has stopped, the desk asks the script again, and asks
// once a minute even while it's up, in case a stamp is missed.
const CHECK_EVERY = 10000;
const CHECK_LIVE_EVERY = 60000;
let seen = null;
let checked = 0;
const pending = new Set();

let checking = false;

function noteChanges(changes) {
  if (changes && seen) {
    for (const [kind, stamp] of Object.entries(changes)) {
      if (String(stamp) === String(seen[kind])) continue;
      if (kind === "entries") pending.add("entries").add("people").add("run");
      if (kind === "tournaments") pending.add("run");
      if (kind === "contacts") pending.add("people");
    }
  }
  if (changes) seen = changes;
  applyChanges();
}

async function checkChanges() {
  if (!signedIn || document.hidden || checking) return;
  checking = true;
  checked = Date.now();
  try {
    const { changes } = await call("changes");
    noteChanges(changes);
  } catch {
  } finally {
    checking = false;
  }
}

function applyChanges() {
  const field = document.activeElement?.matches("input, select, textarea") ? document.activeElement : null;
  if (pending.delete("people")) loadPeople();
  if (pending.has("entries") && !tdTable.contains(field)) {
    pending.delete("entries");
    showDeskEntries(true);
  }
  if (pending.has("run") && !runBusy()) {
    pending.delete("run");
    loadRun();
  }
}

// When the stream dropped (null while it's up), or 0 once it has stopped for good.
let streamDown = LIVE_DB ? null : 0;
if (LIVE_DB) {
  listenLive("/changes", (changes) => {
    streamDown = null;
    if (signedIn && changes) noteChanges(changes);
  }, (final) => {
    if (final) streamDown = 0;
    else streamDown ??= Date.now();
  });
}
const streaming = () => streamDown === null || Date.now() - streamDown < CHECK_EVERY;

setInterval(() => {
  if (!streaming() || Date.now() - checked >= CHECK_LIVE_EVERY) checkChanges();
}, CHECK_EVERY);
document.addEventListener("visibilitychange", () => {
  if (!streaming()) checkChanges();
});
// What was held back loads once the TD leaves the field.
document.addEventListener("focusout", () => setTimeout(applyChanges));

// Sign-in with Firebase. The SDK keeps the session in this browser and refreshes the ID token, so a
// reload signs the desk in again through onAuthStateChanged.
const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/12.19.0";
const EMAIL_KEY = "lccc-td-email";
const SIGN_IN_PATIENCE = 6000;
// The page's address without the sign-in link's query, for links back to it.
const deskAddress = () => new URL(location.pathname, location.href).href;

function authProblem(error) {
  const code = String(error?.code || "").replace(/^auth\//, "");
  if (["popup-closed-by-user", "cancelled-popup-request", "user-cancelled"].includes(code)) return "Sign-in was cancelled.";
  if (code === "account-exists-with-different-credential") return "That email address signs in with a different button. Use the one you signed in with before.";
  if (code === "invalid-email") return "That email address isn't valid.";
  if (["invalid-action-code", "expired-action-code"].includes(code)) return "That sign-in link has expired or was already used. Ask for a new one.";
  if (code === "network-request-failed") return "Couldn't reach the sign-in service. Try again.";
  return "Sign-in didn't work. Try again.";
}

async function signInWith(provider) {
  // Club laptops are shared, so the provider asks which account rather than using the last TD's.
  provider.setCustomParameters({ prompt: "select_account" });
  loginStatus.textContent = "Signing in…";
  try {
    await firebase.signInWithPopup(firebase.auth, provider);
  } catch (error) {
    if (error?.code !== "auth/popup-blocked") {
      loginStatus.textContent = authProblem(error);
      return;
    }
    await firebase.signInWithRedirect(firebase.auth, provider).catch((e) => { loginStatus.textContent = authProblem(e); });
  }
}

/** Sends a sign-in link, or, when the page was opened from one on a device that didn't ask for it,
 *  completes it with the address typed in. */
async function emailLink() {
  const email = login.elements.email.value.trim();
  const button = login.querySelector(".td-email-link");
  button.disabled = true;
  try {
    if (firebase.isSignInWithEmailLink(firebase.auth, location.href)) {
      loginStatus.textContent = "Signing in…";
      await finishEmailLink(email).catch(spentLink);
    } else {
      loginStatus.textContent = "Sending…";
      await firebase.sendSignInLinkToEmail(firebase.auth, email, { url: deskAddress(), handleCodeInApp: true });
      try { localStorage.setItem(EMAIL_KEY, email); } catch {}
      loginStatus.textContent = `Check ${email} for a sign-in link, and open it to sign in.`;
    }
  } catch (error) {
    loginStatus.textContent = authProblem(error);
  }
  button.disabled = false;
}

async function finishEmailLink(email) {
  await firebase.signInWithEmailLink(firebase.auth, email, location.href);
  try { localStorage.removeItem(EMAIL_KEY); } catch {}
  leaveEmailLink();
}

function leaveEmailLink() {
  history.replaceState(history.state, "", deskAddress());
  login.querySelector(".td-email-link").textContent = "Email me a sign-in link";
}

/** Rethrows error, first dropping a link that can't be used again, so the form can send a new one. */
function spentLink(error) {
  if (/^auth\/(invalid|expired)-action-code$/.test(error?.code)) leaveEmailLink();
  throw error;
}

async function startFirebase() {
  login.querySelector(".td-login-password").remove();
  // The form waits for Firebase to say whether this browser is still signed in, which on a phone can
  // never come: Safari's storage can hang after the tab has slept. So after a while it says so.
  const stalled = setTimeout(() => {
    if (!login.hidden || signedIn) return;
    showLogin("Sign-in is taking too long. Reload the page, or close this tab and open the desk again.", false);
  }, SIGN_IN_PATIENCE);
  try {
    const [app, sdk] = await Promise.all([import(`${FIREBASE_SDK}/firebase-app.js`), import(`${FIREBASE_SDK}/firebase-auth.js`)]);
    firebase = { ...sdk, auth: sdk.getAuth(app.initializeApp(FIREBASE)) };
  } catch {
    clearTimeout(stalled);
    showLogin("Couldn't load the sign-in service. Check the connection, then reload the page.", false);
    return;
  }
  login.querySelector(".td-google").addEventListener("click", () => signInWith(new firebase.GoogleAuthProvider()));
  // Firebase can report no one signed in before a Google redirect or an emailed link has finished
  // signing someone in, so the buttons wait for those.
  const finishing = [firebase.getRedirectResult(firebase.auth).catch((error) => { loginStatus.textContent = authProblem(error); })];
  if (firebase.isSignInWithEmailLink(firebase.auth, location.href)) {
    let email = "";
    try { email = localStorage.getItem(EMAIL_KEY) || ""; } catch {}
    if (email) {
      finishing.push(finishEmailLink(email).catch(spentLink).catch((error) => { loginStatus.textContent = authProblem(error); }));
    } else {
      loginStatus.textContent = "Enter the email address the sign-in link was sent to, to finish signing in.";
      login.querySelector(".td-email-link").textContent = "Finish signing in";
    }
  }
  firebase.onAuthStateChanged(firebase.auth, async (user) => {
    clearTimeout(stalled);
    // Firebase ends a session itself when the account is disabled, or when another tab signs out.
    if (!user) {
      if (signedIn) return signOut("Your sign-in has ended. Sign in again.");
      await Promise.all(finishing);
      if (!firebase.auth.currentUser) showLogin();
      return;
    }
    if (signedIn) return;
    showLogin("Signing in…", false);
    try {
      if (await signIn()) loginStatus.textContent = "";
    } catch {
      signOut("Couldn't reach the registration service. Try again.");
    }
  });
}

if (FIREBASE) {
  startFirebase();
} else {
  login.querySelector(".td-login-accounts").remove();
  (async () => {
    const saved = remembered();
    if (!saved || !(await signIn(saved).catch(() => false))) showLogin(saved ? undefined : "");
  })();
}
