// The Entries page (entries/): the entry list of the upcoming club event the reader picks, from the
// registration script's ?entries=all. It opens on ?event=<key> if given, else the soonest event,
// and the address keeps the choice, so a link can open on one event. ENDPOINT, byesText, and entryByesText come
// from register.js, and so do the players saved on this device and their list: a saved player
// registered for one club night can switch to its whole month here, which the script treats as
// registering for the month, and one registered for the whole month can switch to just one night,
// until they have paid. A saved player can also change the byes they asked for, half-point or zero-point, in a
// Swiss or a whole month; a player registered on another device is saved here by the US Chess ID, last name,
// and email they registered with. Those two prove who is changing the entry, so a player saved
// with an ID alone, as the Pairings page saves one, is asked for them on the first change.

const allStatus = document.querySelector(".entries-all-status");
const all = document.querySelector(".entries-all");
const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const monthFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", month: "long", year: "numeric" });

function cell(row, text, tag = "td") {
  const c = document.createElement(tag);
  c.textContent = text;
  row.append(c);
  return c;
}

// Club nights, the events.json events that aren't tournaments, as the registration script tells them.
let nights = new Set();
// The rounds of each tournament that takes byes, a Swiss, by the same key.
let swissRounds = new Map();
// Players the form below found on this visit, whether or not they are saved on this device.
const found = new Map();
const players = () => [...found.values(), ...savedPlayers().filter((p) => !found.has(p.id))];
// The reader's own ID: the player they last found or picked, else the first saved here.
let you = null;
const yourId = () => you ?? savedPlayers()[0]?.id;

/** A button that switches the saved player from this night to its whole month, or with toNight, from the
 *  whole month to just this night. */
function switchButton(event, player, toNight) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "td-action entries-switch";
  const month = monthFormat.format(new Date(event.start));
  const who = player.name || player.id;
  button.textContent = toNight ? "Just this night" : "Switch to month";
  button.append(Object.assign(document.createElement("span"), { className: "visually-hidden", textContent: ` for ${who}` }));
  button.addEventListener("click", async () => {
    if (!player.last || !player.email) return askFor(player, "entries-switch");
    const question = toNight ? `Switch ${who} from every night in ${month} to just ${dateFormat.format(new Date(event.start))}?`
      : `Switch ${who} to every night in ${month}? What was paid for this night counts toward the month.`;
    if (!confirm(question)) return;
    button.disabled = true;
    const [name, date] = event.key.split("/");
    const body = new URLSearchParams({ ...(toNight ? { action: "toNight" } : {}), event: name, date: toNight ? date : date.slice(0, 7),
      id: player.id, last: player.last, email: player.email });
    let said;
    try {
      const result = await (await fetch(ENDPOINT, { method: "POST", body })).json();
      said = result.message || result.error;
      if (result.ok) await load();
    } catch {
      said = "The switch didn't go through. Try again, or email president@larimerchess.org.";
    }
    button.disabled = false;
    allStatus.textContent = said;
  });
  return button;
}

/** What an entry can ask to miss: a whole month's nights still to come, or a Swiss's rounds. */
function byeChoices(event, entry) {
  const [name, date] = event.key.split("/");
  if (!nights.has(event.key)) return Array.from({ length: swissRounds.get(event.key) || 0 }, (_, i) => String(i + 1));
  return entry.for !== "Whole month" ? [] : [...nights].map((key) => key.split("/"))
    .filter(([night, day]) => night === name && day.startsWith(date.slice(0, 7)) && day >= today).map(([, day]) => day).sort();
}

/** A button that opens a row under the cell's, as wide as the table so a phone has room, with a menu for each
 *  round or night the saved player can miss, to play or ask for a half-point or zero-point bye, and Save, which
 *  replaces their byes, and Cancel. */
function byesButton(cell, event, entry, player) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "td-action entries-change-byes";
  button.textContent = "Change byes";
  button.append(Object.assign(document.createElement("span"), { className: "visually-hidden", textContent: ` for ${player.name}` }));
  button.addEventListener("click", () => {
    if (!player.last || !player.email) return askFor(player, "entries-change-byes");
    const month = entry.for === "Whole month";
    const choices = byeChoices(event, entry);
    const had = (entry.byes || []).map(String);
    const hadZero = (entry.zeroByes || []).map(String);
    const boxes = Object.assign(document.createElement("div"), { className: "entries-bye-choices" });
    boxes.setAttribute("role", "group");
    boxes.setAttribute("aria-label", `${month ? "Nights" : "Rounds"} ${player.name} will miss`);
    for (const value of choices) {
      const menu = Object.assign(document.createElement("select"), { id: `entries-bye-${player.id}-${value}`, name: value });
      menu.append(new Option("Plays", ""), new Option("½-point bye", "half"), new Option("0-point bye", "zero"));
      menu.value = had.includes(value) ? "half" : hadZero.includes(value) ? "zero" : "";
      const label = Object.assign(document.createElement("label"), { htmlFor: menu.id, textContent: byesText([value]) });
      boxes.append(Object.assign(document.createElement("p"), { className: "entries-bye-choice" }));
      boxes.lastChild.append(label, menu);
    }
    const save = Object.assign(document.createElement("button"), { type: "button", className: "td-action", textContent: "Save" });
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "td-action", textContent: "Cancel" });
    const actions = Object.assign(document.createElement("p"), { className: "td-buttons" });
    actions.append(save, cancel);
    const row = cell.closest("tr");
    const editor = Object.assign(document.createElement("tr"), { className: "entries-bye-editor" });
    Object.assign(editor.insertCell(), { colSpan: row.cells.length }).append(boxes, actions);
    row.after(editor);
    button.hidden = true;
    (boxes.querySelector("select") || save).focus();
    const close = () => {
      editor.remove();
      button.hidden = false;
    };
    cancel.addEventListener("click", () => {
      close();
      button.focus();
    });
    save.addEventListener("click", async () => {
      const controls = editor.querySelectorAll("select, button");
      for (const control of controls) control.disabled = true;
      const [name, date] = event.key.split("/");
      // A month's nights already played aren't offered, and keep their byes.
      const chosen = (kind) => [...boxes.querySelectorAll("select")].filter((m) => m.value === kind).map((m) => m.name);
      const byes = [...had.filter((b) => !choices.includes(b)), ...chosen("half")];
      const zeroByes = [...hadZero.filter((b) => !choices.includes(b)), ...chosen("zero")];
      let said;
      try {
        const body = new URLSearchParams({ action: "byes", event: name, date: month ? date.slice(0, 7) : date, id: player.id,
          last: player.last, email: player.email, byes: byes.join(", "), zeroByes: zeroByes.join(", ") });
        const result = await (await fetch(ENDPOINT, { method: "POST", body })).json();
        said = result.message || result.error;
        if (result.ok) {
          close();
          await load();
        }
      } catch {
        said = "The change didn't go through. Try again, or email president@larimerchess.org.";
      }
      for (const control of controls) control.disabled = false;
      allStatus.textContent = said;
      (editor.isConnected ? save : all.querySelector(`tr[data-id="${CSS.escape(player.id)}"] .entries-change-byes`))?.focus();
    });
  });
  return button;
}

function eventSection(event) {
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  if (event.page) heading.append(Object.assign(document.createElement("a"), { href: event.page, textContent: event.name }));
  else heading.textContent = event.name;
  const when = document.createElement("p");
  when.textContent = `${dateFormat.format(new Date(event.start))}. `
    + (event.entries.length === 1 ? "1 player registered." : `${event.entries.length || "No"} players registered.`);
  const register = document.createElement("a");
  register.className = "button";
  // A club night's Register opens on its whole month, which is what most players come for.
  const night = nights.has(event.key);
  register.href = `${event.page}?date=${event.key.split("/")[1].slice(0, night ? 7 : 10)}#register`;
  register.textContent = "Register";
  const hint = document.createElement("span");
  hint.className = "visually-hidden";
  hint.textContent = ` for ${event.name}, ${night ? `all of ${monthFormat.format(new Date(event.start))}` : dateFormat.format(new Date(event.start))}`;
  register.append(hint);
  section.append(heading, when);
  // Saved players on this list, who can change their entry.
  const editors = !event.closed && event.page ? players().filter((p) => event.entries.some((e) => e.id === p.id)) : [];
  const switchers = nights.has(event.key) ? editors : [];
  const changers = editors.filter((p) => byeChoices(event, event.entries.find((e) => e.id === p.id)).length);
  if (event.closed || !event.page) {
    section.append(Object.assign(document.createElement("p"), { textContent: "Registration is closed." }));
  } else if (!event.entries.some((e) => e.id === yourId())) {
    section.append(document.createElement("p"));
    section.lastChild.append(register);
  }
  if (event.entries.length) {
    const table = document.createElement("table");
    table.className = "entries";
    const head = table.createTHead().insertRow();
    const month = event.entries.some((e) => e.for === "Whole month") || switchers.length;
    // A whole month's byes are its nights, each shown on its own night's list.
    const tonight = (e, kind) => (e[kind] || []).includes(event.key.split("/")[1]);
    const byesColumn = event.entries.some((e) => (night ? tonight(e, "byes") || tonight(e, "zeroByes") : e.byes?.length || e.zeroByes?.length))
      || changers.length;
    // Players get sections when the tournament starts.
    const sectioned = event.entries.some((e) => e.section);
    for (const label of ["Name", "US Chess ID", "Rating", ...(month ? ["For"] : []), ...(byesColumn ? ["Byes"] : []),
      ...(sectioned ? ["Section"] : [])]) {
      cell(head, label, "th").scope = "col";
    }
    const body = table.createTBody();
    for (const e of event.entries) {
      const row = body.insertRow();
      row.dataset.id = e.id;
      cell(row, e.name);
      const link = document.createElement("a");
      link.href = `https://ratings.uschess.org/player/${encodeURIComponent(e.id)}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = e.id;
      const tab = document.createElement("span");
      tab.className = "visually-hidden";
      tab.textContent = " (opens in a new tab)";
      link.append(tab);
      cell(row, "").append(link);
      cell(row, e.rating || "Unrated");
      const player = switchers.find((p) => p.id === e.id);
      if (month || player) cell(row, e.for === "Whole month" ? "Whole month" : "This night");
      if (player) row.lastChild.append(" ", switchButton(event, { ...player, name: e.name }, e.for === "Whole month"));
      const changer = changers.find((p) => p.id === e.id);
      if (byesColumn) {
        cell(row, !night ? entryByesText(e) : tonight(e, "byes") ? "Half-point bye" : tonight(e, "zeroByes") ? "Zero-point bye" : "");
      }
      if (changer) row.lastChild.append(" ", byesButton(row.lastChild, event, e, { ...changer, name: e.name }));
      if (sectioned) cell(row, e.section || "");
    }
    const wrap = Object.assign(document.createElement("div"), { className: "td-table" });
    wrap.append(table);
    section.append(wrap);
  }
  return section;
}

// The lists shown, and a redraw of the event chosen, for the saved players and the form below, which are
// made once so that a redraw keeps what is typed in the form.
let lists = [];
let redraw = () => {};
let savedHere = null;
let finder = null;
// The button a saved player pressed before the form asked for their last name and email.
let resume = null;

function showSavedHere() {
  showSavedIn(savedHere, showEntryOf, (p) => {
    found.delete(p.id);
    if (you === p.id) you = null;
    showSavedHere();
    redraw();
    allStatus.textContent = `${playerName(p)} is no longer saved on this device.`;
  }, finder.querySelector("summary"));
}

/** A saved player's entry: on the list shown if they're on it, else on the soonest one, with the
 *  keyboard on their row's first button. */
function showEntryOf(p) {
  you = p.id;
  const on = lists.filter((e) => e.entries.some((x) => x.id === p.id));
  if (!on.length) {
    redraw();
    return void (allStatus.textContent = `${playerName(p)} isn't registered for an upcoming event.`);
  }
  const select = document.getElementById("entries-event");
  if (!on.some((e) => e.key === select.value)) select.value = on[0].key;
  redraw();
  const button = all.querySelector(`tr[data-id="${CSS.escape(p.id)}"] button`);
  allStatus.textContent = button ? `${playerName(p)}: change the entry with the buttons on its row.`
    : `${playerName(p)} is registered. To change the entry, email president@larimerchess.org.`;
  (button || select).focus();
}

/** Opens the form below on a saved player who has no last name or email, for the button they pressed. */
function askFor(player, button) {
  resume = { id: player.id, button };
  finder.open = true;
  finder.querySelector("#entries-find-id").value = player.id;
  allStatus.textContent = `To change ${player.name}'s entry, enter the last name and email used to register.`;
  finder.querySelector("#entries-find-last").focus();
}

/** A form that saves a player registered on another device as the Register form does, so their rows
 *  get their buttons. */
function findForm() {
  const box = document.createElement("details");
  box.className = "run-sections-edit";
  const form = Object.assign(document.createElement("form"), { className: "register-form" });
  form.append(Object.assign(document.createElement("p"), { className: "register-hint",
    textContent: "To change your byes, or switch between a night and its month, enter what you registered with." }));
  const field = (id, label, attributes) => {
    const input = Object.assign(document.createElement("input"), { id, required: true, ...attributes });
    form.append(Object.assign(document.createElement("label"), { htmlFor: id, textContent: label }), input);
    return input;
  };
  const idInput = field("entries-find-id", "US Chess ID", { name: "uschess-id", type: "text", inputMode: "numeric", pattern: "[0-9]{8}",
    maxLength: 8, autocomplete: "on" });
  const lastInput = field("entries-find-last", "Last name", { name: "last", type: "text", autocomplete: "family-name" });
  const emailInput = field("entries-find-email", "Email", { name: "email", type: "email", autocomplete: "email" });
  const remember = newRemember("entries-find-remember");
  const choice = remember.querySelector("input");
  form.append(remember, Object.assign(document.createElement("button"), { type: "submit", className: "button", textContent: "Find my entries" }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const [id, last, email] = [idInput, lastInput, emailInput].map((input) => input.value.trim());
    const listed = lists.find((e) => e.key === document.getElementById("entries-event")?.value)?.entries.find((e) => e.id === id);
    const entry = listed || lists.flatMap((e) => e.entries).find((e) => e.id === id);
    if (!entry) return void (allStatus.textContent = "Nobody with that US Chess ID is registered for an upcoming event.");
    const saved = savedPlayers();
    // One the Register form saved keeps its phone.
    const player = { ...saved.find((p) => p.id === id), id, last, email, name: entry.name || last };
    found.set(id, player);
    you = id;
    const stored = choice.checked && storePlayers([player, ...saved.filter((p) => p.id !== id)]);
    idInput.value = lastInput.value = "";
    box.open = false;
    showSavedHere();
    redraw();
    const row = all.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    const buttons = (resume?.id === id && row?.querySelector(`.${resume.button}`)) || row?.querySelector("button");
    resume = null;
    allStatus.textContent = `${stored ? `${player.name} is saved on this device.` : `Found ${player.name}.`}${buttons
      ? " Change the entry with the buttons on its row." : listed ? "" : " Pick one of their events to change its entry."}`;
    (buttons || document.getElementById("entries-event")).focus();
  });
  box.append(Object.assign(document.createElement("summary"), { id: "entries-find", textContent: "Registered on another device?" }), form);
  return box;
}

function showPicker(events) {
  const picker = document.createElement("div");
  picker.className = "register-form entries-pick";
  const label = Object.assign(document.createElement("label"), { htmlFor: "entries-event", textContent: "Event" });
  const select = Object.assign(document.createElement("select"), { id: "entries-event" });
  const groups = new Map();
  for (const e of events) {
    const month = monthFormat.format(new Date(e.start));
    if (!groups.has(month)) groups.set(month, Object.assign(document.createElement("optgroup"), { label: month }));
    groups.get(month).append(new Option(`${e.name}, ${dateFormat.format(new Date(e.start))}`, e.key));
  }
  select.append(...groups.values());
  picker.append(label, select);
  const shown = document.createElement("div");
  const wanted = new URLSearchParams(location.search).get("event");
  select.value = events.some((e) => e.key === wanted) ? wanted : events[0].key;
  const show = () => {
    shown.replaceChildren(eventSection(events.find((e) => e.key === select.value)));
    history.replaceState(history.state, "", `?event=${encodeURIComponent(select.value)}`);
  };
  select.addEventListener("change", show);
  redraw = show;
  // Redrawn when the script's lists replace the database's copy, so the reader keeps their place.
  const focused = all.contains(document.activeElement) ? document.activeElement.id : "";
  if (!finder) {
    finder = findForm();
    savedHere = newSavedBox();
    showSavedHere();
  }
  all.replaceChildren(picker, savedHere, finder, shown);
  show();
  if (focused) document.getElementById(focused)?.focus();
}

// The database's copy (see publishEntries in scripts/registration.gs) is shown first, since it comes
// in a tenth of the time the script takes; the script's lists then replace it if they differ. The
// copy keeps the events of the day it was built, so the days since are dropped here.
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date());
let shownLists = null;

function showLists(events) {
  const text = JSON.stringify(events);
  if (text === shownLists) return;
  shownLists = text;
  lists = events;
  allStatus.textContent = events.length ? "" : "No club events are coming up.";
  if (events.length) showPicker(events);
  else all.replaceChildren();
}

function load() {
  const calendar = fetch("/events.json").then((response) => response.json()).catch(() => []).then((calendarEvents) => {
    const club = calendarEvents.filter((e) => e.page).map((e) => [`${e.page.split("/").filter(Boolean).pop()}/${e.start.slice(0, 10)}`, e]);
    nights = new Set(club.filter(([, e]) => !(e.tags || []).includes("tournament")).map(([key]) => key));
    swissRounds = new Map(club.filter(([, e]) => (e.tags || []).includes("tournament") && Number(e.rounds) && !["quad", "arena"].includes(e.pairing))
      .map(([key, e]) => [key, Number(e.rounds)]));
  });
  let answered = false;
  if (LIVE_DB) {
    fetch(`${LIVE_DB}/public/entries.json`).then((response) => response.json())
      .then((text) => text && JSON.parse(text).filter((e) => e.start.slice(0, 10) >= today))
      .then((events) => calendar.then(() => { if (events && !answered) showLists(events); }))
      .catch(() => {});
  }
  return Promise.all([fetch(`${ENDPOINT}?entries=all`).then((response) => response.json()), calendar])
    .then(([{ events = [] }]) => {
      answered = true;
      showLists(events);
    })
    .catch(() => {
      if (!shownLists) allStatus.textContent = "The entry lists couldn't be loaded. Try again later.";
    });
}

if (!ENDPOINT) {
  allStatus.textContent = "Entries will be listed here once registration opens.";
} else {
  load();
}
