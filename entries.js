// The Entries page (entries/): every upcoming club event's entry list, from the registration
// script's ?entries=all. ENDPOINT comes from register.js.

const allStatus = document.querySelector(".entries-all-status");
const all = document.querySelector(".entries-all");
const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "long", month: "long", day: "numeric", year: "numeric" });

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
    for (const label of ["Name", "US Chess ID", "Rating", ...(event.entries.some((e) => e.for === "Whole month") ? ["For"] : [])]) {
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
      if (head.cells.length > 3) cell(row, e.for === "Whole month" ? "Whole month" : "This night");
    }
    section.append(table);
  }
  section.append(register);
  return section;
}

if (!ENDPOINT) {
  allStatus.textContent = "Entries will be listed here once registration opens.";
} else {
  fetch(`${ENDPOINT}?entries=all`)
    .then((response) => response.json())
    .then(({ events = [] }) => {
      allStatus.textContent = events.length ? "" : "No club events are coming up.";
      all.replaceChildren(...events.map(eventSection));
    })
    .catch(() => { allStatus.textContent = "The entry lists couldn't be loaded. Try again later."; });
}
