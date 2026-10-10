// The Entries page (entries/): the entry list of the upcoming club event the reader picks, from the
// registration script's ?entries=all. It opens on ?event=<key> if given, else the soonest event,
// and the address keeps the choice, so a link can open on one event. ENDPOINT comes from register.js.

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

function eventSection(event) {
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = event.name;
  const when = document.createElement("p");
  when.textContent = `${dateFormat.format(new Date(event.start))}. `
    + (event.entries.length === 1 ? "1 player registered." : `${event.entries.length || "No"} players registered.`);
  const register = document.createElement("a");
  register.className = "button";
  register.href = `${event.page}?date=${event.key.split("/")[1]}#register`;
  register.textContent = "Register";
  const hint = document.createElement("span");
  hint.className = "visually-hidden";
  hint.textContent = ` for ${event.name}, ${dateFormat.format(new Date(event.start))}`;
  register.append(hint);
  section.append(heading, when);
  if (event.entries.length) {
    const table = document.createElement("table");
    table.className = "entries";
    const head = table.createTHead().insertRow();
    const month = event.entries.some((e) => e.for === "Whole month");
    // Players get sections when the tournament starts.
    const sectioned = event.entries.some((e) => e.section);
    for (const label of ["Name", "US Chess ID", "Rating", ...(month ? ["For"] : []), ...(sectioned ? ["Section"] : [])]) {
      cell(head, label, "th").scope = "col";
    }
    const body = table.createTBody();
    for (const e of event.entries) {
      const row = body.insertRow();
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
      if (month) cell(row, e.for === "Whole month" ? "Whole month" : "This night");
      if (sectioned) cell(row, e.section || "");
    }
    section.append(table);
  }
  if (event.closed || !event.page) {
    section.append(Object.assign(document.createElement("p"), { textContent: "Registration is closed." }));
  } else {
    section.append(register);
  }
  return section;
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
  all.replaceChildren(picker, shown);
  show();
}

if (!ENDPOINT) {
  allStatus.textContent = "Entries will be listed here once registration opens.";
} else {
  fetch(`${ENDPOINT}?entries=all`)
    .then((response) => response.json())
    .then(({ events = [] }) => {
      allStatus.textContent = events.length ? "" : "No club events are coming up.";
      if (events.length) showPicker(events);
    })
    .catch(() => { allStatus.textContent = "The entry lists couldn't be loaded. Try again later."; });
}
