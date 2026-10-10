// The Entries page (entries/): every upcoming club event's entry list, from the registration
// script's ?entries=all, a month at a time: this month first, then each next month as the reader
// scrolls to the end or presses Show next month, as on the events page. ENDPOINT comes from register.js.

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
  const heading = document.createElement("h3");
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

function showByMonth(events) {
  const months = [];
  for (const e of events) {
    const name = monthFormat.format(new Date(e.start));
    if (months.at(-1)?.name !== name) months.push({ name, events: [] });
    months.at(-1).events.push(e);
  }
  // How many months are showing is kept in the history entry, so a reload or Back comes back to them.
  let shown = Math.min(history.state?.months ?? 1, months.length);
  const more = Object.assign(document.createElement("button"), { type: "button", className: "button button-secondary events-more" });
  const monthSection = (m) => {
    const section = document.createElement("section");
    section.className = "entries-month";
    const heading = Object.assign(document.createElement("h2"), { textContent: m.name, tabIndex: -1 });
    section.append(heading, ...m.events.map(eventSection));
    return section;
  };
  const update = () => {
    more.hidden = shown >= months.length;
    if (!more.hidden) more.textContent = `Show ${months[shown].name}`;
  };
  const showNext = () => {
    if (shown >= months.length) return null;
    const section = monthSection(months[shown++]);
    more.before(section);
    history.replaceState({ ...history.state, months: shown }, "");
    update();
    return section;
  };
  all.replaceChildren(...months.slice(0, shown).map(monthSection), more);
  update();
  // The button moves down past the new month, so focus goes to its heading.
  more.addEventListener("click", () => showNext()?.querySelector("h2").focus());
  // Scrolling near the end shows the next month without a click, but only once the reader scrolls:
  // a short month leaves the button in view from the start, and the page opens on this month alone.
  // The observer only reports changes, so it is restarted after each month and on the first scroll.
  let scrolled = false;
  const nearEnd = new IntersectionObserver((seen) => {
    if (!scrolled || !seen.some((e) => e.isIntersecting) || more.hidden) return;
    showNext();
    nearEnd.unobserve(more);
    nearEnd.observe(more);
  }, { rootMargin: "0px 0px 600px 0px" });
  nearEnd.observe(more);
  addEventListener("scroll", () => {
    scrolled = true;
    nearEnd.unobserve(more);
    nearEnd.observe(more);
  }, { once: true, passive: true });
}

if (!ENDPOINT) {
  allStatus.textContent = "Entries will be listed here once registration opens.";
} else {
  fetch(`${ENDPOINT}?entries=all`)
    .then((response) => response.json())
    .then(({ events = [] }) => {
      allStatus.textContent = events.length ? "" : "No club events are coming up.";
      showByMonth(events);
    })
    .catch(() => { allStatus.textContent = "The entry lists couldn't be loaded. Try again later."; });
}
