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
const monthDay = fmt({ month: "long", day: "numeric", year: "numeric" });
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
  button.setAttribute("aria-label", `Add ${event.title}, ${monthDay.format(start)}, to calendar`);
  button.append(
    el("span", "event-month", month.format(start)),
    el("span", "event-day", day.format(start)),
    el("span", "event-year", year.format(start)),
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

// Text sighted readers see but screen readers skip, and the reverse.
const shown = (text) => { const span = el("span", null, text); span.setAttribute("aria-hidden", "true"); return span; };
const spoken = (text) => el("span", "visually-hidden", text);

function renderEvent(event) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const item = el("li", "event");
  item.dataset.tags = ["all", ...(event.tags || [])].join(" ");
  item.dataset.city = event.city ? slug(event.city) : "";

  const [date, menu] = addToCalendar(event, start);

  // The heading carries the full date, so jumping between headings says what and when.
  const body = el("div", "event-body");
  const heading = el("h3", null, event.title);
  heading.append(spoken(`, ${longDate.format(start)}`));
  body.append(heading);
  const when = el("p", "event-meta");
  if (event.allDay) {
    when.append(shown(weekday.format(start)), spoken("All day"));
  } else {
    when.append(shown(`${weekday.format(start)} · `));
    for (const part of timeRange.formatRangeToParts(start, end)) {
      const dash = part.source === "shared" && part.type === "literal" && part.value.match(/^(\s*)([–-])(\s*)$/);
      if (dash) {
        when.append(dash[1], shown(dash[2]), spoken("\u00a0to\u00a0"), dash[3]);
      } else {
        when.append(part.value);
      }
    }
  }
  body.append(when);
  if (event.location) body.append(el("p", "event-meta", event.location.split(",")[0]));
  if (event.organizer && event.organizer !== CLUB) {
    const by = el("p", "event-meta event-organizer", `Run by ${event.organizer}`);
    if (event.url) {
      const details = el("a", null, "Details");
      details.append(spoken(` about ${event.title}`));
      details.href = event.url;
      by.append(shown(" · "), details);
    }
    body.append(by);
  }

  // Card text first, then its button; CSS still shows the date on the left.
  item.append(body, date, menu);
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

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Two independent filters, kind of event and city; the city buttons come from the
// events themselves. The choice is kept in the address as #kind=youth&city=loveland.
function setUpFilters(container, filtersId, events) {
  const panel = document.getElementById(filtersId);
  const kindButtons = [...panel.querySelectorAll("button[data-filter]")];
  const cityGroup = panel.querySelector("[data-city-filters]");
  const cities = [...new Set(events.map((e) => e.city).filter(Boolean))].sort();
  const cityButtons = ["all", ...cities].map((name) => {
    const button = el("button", null, name === "all" ? "All cities" : name);
    button.type = "button";
    button.dataset.city = name === "all" ? "all" : slug(name);
    cityGroup.append(button);
    return button;
  });
  const kinds = new Set(kindButtons.map((b) => b.dataset.filter));
  const cityIds = new Set(cityButtons.map((b) => b.dataset.city));
  const state = { kind: "all", city: "all" };

  const readHash = () => {
    const raw = decodeURIComponent(location.hash.slice(1));
    const params = new URLSearchParams(raw.includes("=") ? raw : `kind=${raw}`);
    state.kind = kinds.has(params.get("kind")) ? params.get("kind") : "all";
    state.city = cityIds.has(params.get("city")) ? params.get("city") : "all";
  };
  const writeHash = () => {
    const params = new URLSearchParams();
    if (state.kind !== "all") params.set("kind", state.kind);
    if (state.city !== "all") params.set("city", state.city);
    const value = params.toString();
    history.replaceState(null, "", value ? `#${value}` : location.pathname);
  };
  const apply = (announce) => {
    for (const b of kindButtons) b.setAttribute("aria-pressed", String(b.dataset.filter === state.kind));
    for (const b of cityButtons) b.setAttribute("aria-pressed", String(b.dataset.city === state.city));
    let count = 0;
    for (const card of container.querySelectorAll(".event")) {
      const match = card.dataset.tags.split(" ").includes(state.kind)
        && (state.city === "all" || card.dataset.city === state.city);
      card.hidden = !match;
      if (match) count++;
    }
    for (const group of container.querySelectorAll(".event-group")) {
      group.hidden = !group.querySelector(".event:not([hidden])");
    }
    container.querySelector(".events-empty").hidden = count > 0;
    if (announce) {
      const labels = [
        kindButtons.find((b) => b.dataset.filter === state.kind),
        cityButtons.find((b) => b.dataset.city === state.city),
      ].filter((b) => (b.dataset.filter ?? b.dataset.city) !== "all").map((b) => b.textContent);
      document.getElementById("filter-status").textContent =
        `Showing ${count} ${count === 1 ? "event" : "events"}${labels.length ? `: ${labels.join(", ")}` : ""}`;
    }
  };

  for (const b of kindButtons) b.addEventListener("click", () => { state.kind = b.dataset.filter; writeHash(); apply(true); });
  for (const b of cityButtons) b.addEventListener("click", () => { state.city = b.dataset.city; writeHash(); apply(true); });
  window.addEventListener("hashchange", () => { readHash(); apply(true); });
  panel.hidden = false;
  readHash();
  apply(false);
}

// schema.org Event data for search engines, for the club's own events only.
function structuredData(events) {
  const club = { "@type": "SportsOrganization", name: CLUB, url: "https://larimerchess.org/" };
  const data = events.filter((e) => e.organizer === CLUB).map((e) => {
    const item = {
      "@context": "https://schema.org",
      "@type": "Event",
      name: e.title,
      startDate: e.start,
      endDate: e.end,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      organizer: club,
      url: EVENTS_PAGE,
      image: "https://larimerchess.org/share.png",
      description: `${e.title}, a US Chess rated event of the Larimer County Chess Club in Fort Collins, Colorado.`,
    };
    if (e.place && e.place.name) {
      item.location = {
        "@type": "Place",
        name: e.place.name,
        address: {
          "@type": "PostalAddress",
          streetAddress: e.place.street,
          addressLocality: e.place.city,
          addressRegion: e.place.region,
          postalCode: e.place.zip,
          addressCountry: "US",
        },
      };
    }
    if (e.price) {
      item.offers = { "@type": "Offer", price: e.price, priceCurrency: "USD", url: EVENTS_PAGE, availability: "https://schema.org/InStock" };
    }
    return item;
  });
  if (data.length === 0) return;
  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.textContent = JSON.stringify(data);
  document.head.append(script);
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
      setUpFilters(list, list.dataset.filters, upcoming);
      structuredData(upcoming);
    } else {
      list.append(...upcoming.map(renderEvent));
    }
    document.getElementById("events-fallback").remove();
  })
  .catch(() => {});
