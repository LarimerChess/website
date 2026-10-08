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
const year = fmt({ year: "numeric" });
const weekday = fmt({ weekday: "long" });
const timeRange = fmt({ hour: "numeric", minute: "2-digit" });
const longDate = fmt({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
const EVENTS_PAGE = "https://larimerchess.org/events/";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Calendar apps take UTC as YYYYMMDDTHHMMSSZ, or a bare YYYYMMDD for all-day events.
function stamp(iso, allDay) {
  if (allDay) return iso.slice(0, 10).replaceAll("-", "");
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function eventDetails(event) {
  const lines = [];
  if (event.organizer && event.organizer !== CLUB) lines.push(`Run by ${event.organizer}.`);
  if (event.url) lines.push(event.url);
  lines.push(EVENTS_PAGE);
  return lines.join("\n");
}

function googleLink(event) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${stamp(event.start, event.allDay)}/${stamp(event.end, event.allDay)}`,
    details: eventDetails(event),
    location: event.location || "",
    ctz: "America/Denver",
  });
  return "https://calendar.google.com/calendar/render?" + params;
}

function icsLink(event) {
  const escape = (s) => s.replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const value = event.allDay ? ";VALUE=DATE:" : ":";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Larimer County Chess Club//larimerchess.org//EN",
    "BEGIN:VEVENT",
    `UID:${stamp(event.start, event.allDay)}-${event.title.replace(/\W+/g, "-")}@larimerchess.org`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART${value}${stamp(event.start, event.allDay)}`,
    `DTEND${value}${stamp(event.end, event.allDay)}`,
    `SUMMARY:${escape(event.title)}`,
    `LOCATION:${escape(event.location || "")}`,
    `DESCRIPTION:${escape(eventDetails(event))}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return "data:text/calendar;charset=utf-8," + encodeURIComponent(lines.join("\r\n"));
}

function closeMenus(except) {
  for (const open of document.querySelectorAll(".event-date[aria-expanded='true']")) {
    if (open === except) continue;
    open.setAttribute("aria-expanded", "false");
    document.getElementById(open.getAttribute("aria-controls")).hidden = true;
  }
}

let menuCount = 0;
function addToCalendar(event, start) {
  const id = `add-menu-${++menuCount}`;
  const button = el("button", "event-date");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", id);
  button.setAttribute("aria-label", `Add to calendar: ${event.title}, ${longDate.format(start)}`);
  button.append(
    el("span", "event-month", month.format(start)),
    el("span", "event-day", day.format(start)),
    el("span", "event-year", year.format(start)),
    el("span", "event-add", "+ Add"),
  );

  const menu = el("div", "add-menu");
  menu.id = id;
  menu.hidden = true;
  const google = el("a", null, "Google Calendar");
  google.append(el("span", "visually-hidden", " (opens in a new tab)"));
  google.href = googleLink(event);
  google.target = "_blank";
  google.rel = "noopener";
  const ics = el("a", null, "Apple, Outlook, other (.ics file)");
  ics.href = icsLink(event);
  ics.download = `${event.title.replace(/[^\w]+/g, "-")}-${event.start.slice(0, 10)}.ics`;
  menu.append(google, ics);
  for (const link of [google, ics]) link.addEventListener("click", () => closeMenus());
  for (const part of [button, menu]) {
    part.addEventListener("focusout", (e) => {
      if (!button.contains(e.relatedTarget) && !menu.contains(e.relatedTarget) && e.relatedTarget) closeMenus();
    });
  }

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = button.getAttribute("aria-expanded") !== "true";
    closeMenus(button);
    button.setAttribute("aria-expanded", String(opening));
    menu.hidden = !opening;
    if (opening) google.focus();
  });
  return [button, menu];
}

document.addEventListener("click", (e) => { if (!e.target.closest(".add-menu")) closeMenus(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = document.querySelector(".event-date[aria-expanded='true']");
  closeMenus();
  if (open) open.focus();
});

function renderEvent(event) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const item = el("li", "event");
  item.dataset.tags = ["all", ...(event.tags || [])].join(" ");

  const [date, menu] = addToCalendar(event, start);

  const body = el("div", "event-body");
  body.append(el("h3", null, event.title));
  const when = event.allDay
    ? weekday.format(start)
    : `${weekday.format(start)} · ${timeRange.formatRange(start, end)}`;
  body.append(el("p", "event-meta", when));
  if (event.location) body.append(el("p", "event-meta", event.location.split(",")[0]));
  if (event.organizer && event.organizer !== CLUB) {
    const by = el("p", "event-meta event-organizer", `Run by ${event.organizer}`);
    if (event.url) {
      const details = el("a", null, "Details");
      details.href = event.url;
      by.append(" · ", details);
    }
    body.append(by);
  }

  item.append(date, menu, body);
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
