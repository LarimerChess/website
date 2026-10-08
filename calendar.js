// Renders events.json as cards. The list's data attributes pick the variant:
// data-src (path to events.json), data-calendar (only that calendar),
// data-limit (at most that many), data-filters (id of the filter buttons, which
// also groups the cards by month).
const CLUB = "Larimer County Chess Club";
const tz = { timeZone: "America/Denver" };
const fmt = (opts) => new Intl.DateTimeFormat("en-US", { ...tz, ...opts });
const month = fmt({ month: "short" });
const monthHeading = fmt({ month: "long", year: "numeric" });
const day = fmt({ day: "numeric" });
const weekday = fmt({ weekday: "long" });
const timeRange = fmt({ hour: "numeric", minute: "2-digit" });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function renderEvent(event) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const item = el("li", "event");
  item.dataset.tags = ["all", ...(event.tags || [])].join(" ");

  const date = el("div", "event-date");
  date.append(el("span", "event-month", month.format(start)), el("span", "event-day", day.format(start)));

  const body = el("div", "event-body");
  body.append(el("h3", null, event.title));
  const when = event.allDay
    ? weekday.format(start)
    : `${weekday.format(start)} · ${timeRange.formatRange(start, end)}`;
  body.append(el("p", "event-meta", when));
  if (event.location) {
    const where = el("p", "event-meta");
    const link = el("a", null, event.location.split(",")[0]);
    link.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(event.location);
    where.append(link);
    body.append(where);
  }
  if (event.organizer && event.organizer !== CLUB) {
    const by = el("p", "event-meta event-organizer", `Run by ${event.organizer}`);
    if (event.url) {
      const details = el("a", null, "Details");
      details.href = event.url;
      by.append(" · ", details);
    }
    body.append(by);
  }

  item.append(date, body);
  return item;
}

function renderByMonth(container, events) {
  const sections = new Map();
  for (const event of events) {
    const key = monthHeading.format(new Date(event.start));
    if (!sections.has(key)) {
      const section = el("section", "event-group");
      section.append(el("h2", null, key), el("ol", "events"));
      sections.set(key, section);
      container.append(section);
    }
    sections.get(key).querySelector("ol").append(renderEvent(event));
  }
}

function applyFilter(container, buttons, tag) {
  for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.filter === tag));
  let shown = 0;
  for (const card of container.querySelectorAll(".event")) {
    const match = card.dataset.tags.split(" ").includes(tag);
    card.hidden = !match;
    if (match) shown++;
  }
  for (const group of container.querySelectorAll(".event-group")) {
    group.hidden = !group.querySelector(".event:not([hidden])");
  }
  container.querySelector(".events-empty").hidden = shown > 0;
}

function setUpFilters(container, filtersId) {
  const buttons = [...document.getElementById(filtersId).querySelectorAll("button[data-filter]")];
  const known = new Set(buttons.map((b) => b.dataset.filter));
  const fromHash = () => (known.has(location.hash.slice(1)) ? location.hash.slice(1) : "all");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const tag = button.dataset.filter;
      history.replaceState(null, "", tag === "all" ? location.pathname : `#${tag}`);
      applyFilter(container, buttons, tag);
    });
  }
  window.addEventListener("hashchange", () => applyFilter(container, buttons, fromHash()));
  document.getElementById(filtersId).hidden = false;
  applyFilter(container, buttons, fromHash());
}

const list = document.querySelector("[data-events]");
fetch(list.dataset.src || "events.json")
  .then((response) => response.json())
  .then((events) => {
    const now = new Date();
    let upcoming = events.filter((e) => new Date(e.end) > now);
    if (list.dataset.calendar) upcoming = upcoming.filter((e) => e.calendar === list.dataset.calendar);
    if (list.dataset.limit) upcoming = upcoming.slice(0, Number(list.dataset.limit));

    if (upcoming.length === 0) {
      list.replaceWith(el("p", null, "No upcoming events right now. Check back soon."));
    } else if (list.dataset.filters) {
      renderByMonth(list, upcoming);
      const empty = el("p", "events-empty", "No upcoming events of this kind right now.");
      empty.hidden = true;
      list.append(empty);
      setUpFilters(list, list.dataset.filters);
    } else {
      list.append(...upcoming.map(renderEvent));
    }
    document.getElementById("events-fallback").remove();
  })
  .catch(() => {});
