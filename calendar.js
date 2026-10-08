// Renders events.json as cards. The list's data attributes pick the variant:
// data-src (path to events.json), data-calendar (only that calendar), data-only and
// data-without (only, or none, of the events with that tag),
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
  if (event.description) return `${event.description}\n\n${EVENTS_PAGE}`;
  const lines = [];
  if (event.organizer && event.organizer !== CLUB) lines.push(`Run by ${event.organizer}.`);
  if (event.url) lines.push(event.url);
  lines.push(EVENTS_PAGE);
  return lines.join("\n");
}

// iCalendar wants lines of at most 75 octets, continued on lines that start with a space.
const utf8 = new TextEncoder();
function fold(line) {
  const parts = [""];
  let octets = 0;
  for (const char of line) {
    const size = utf8.encode(char).length;
    if (octets + size > 74) {
      parts.push("");
      octets = 0;
    }
    parts[parts.length - 1] += char;
    octets += size;
  }
  return parts.join("\r\n ");
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
  return "data:text/calendar;charset=utf-8," + encodeURIComponent(lines.map(fold).join("\r\n"));
}

// Text sighted readers see but screen readers skip, and the reverse.
const shown = (text) => { const span = el("span", null, text); span.setAttribute("aria-hidden", "true"); return span; };
const spoken = (text) => el("span", "visually-hidden", text);

// "Saturday · 10:00 AM – 1:00 PM", read as "10:00 AM to 1:00 PM".
function whenText(event, start, end) {
  const when = el("p", "event-meta");
  if (event.allDay) {
    when.append(shown(weekday.format(start)), spoken("All day"));
  } else if (longDate.format(start) !== longDate.format(end)) {
    // formatRange would add numeric dates to both ends.
    when.append(`${weekday.format(start)} ${timeRange.format(start)} `, shown("–"), spoken(" to "),
      ` ${weekday.format(end)} ${timeRange.format(end)}`);
  } else {
    when.append(shown(`${weekday.format(start)} · `));
    for (const part of timeRange.formatRangeToParts(start, end)) {
      const dash = part.source === "shared" && part.type === "literal" && part.value.match(/^(\s*)([–-])(\s*)$/);
      if (dash) {
        when.append(dash[1], shown(dash[2]), spoken(" to "), dash[3]);
      } else {
        when.append(part.value);
      }
    }
  }
  return when;
}

// The organizer's line: "Run by X · Details", either part left out when it doesn't apply.
function organizerLine(event) {
  const runBy = event.organizer && event.organizer !== CLUB ? `Run by ${event.organizer}` : "";
  if (!runBy && !event.url) return null;
  const by = el("p", "event-meta event-organizer", runBy);
  if (event.url) {
    const details = el("a", null, "Details");
    details.append(spoken(` about ${event.title}`));
    details.href = event.url;
    if (runBy) by.append(shown(" · "));
    by.append(details);
  }
  return by;
}

// Text with its web addresses made into links, built as nodes so nothing in it is read as HTML.
function linked(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]*[^\s<>".,;:!?)]/g)) {
    nodes.push(text.slice(last, match.index));
    const a = el("a", null, match[0]);
    a.href = match[0];
    nodes.push(a);
    last = match.index + match[0].length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

// The lines every description starts with (see the lccc-events runbook), shown in bold.
const LABEL = /^(?:Cost(?: for [^:]+)?|Time control):/;

// A calendar description as paragraphs, with "•" lines as a list.
function descriptionNodes(text) {
  const nodes = [];
  for (const block of text.trim().split(/\n\s*\n/)) {
    let paragraph = null;
    let list = null;
    for (const line of block.split("\n")) {
      const bullet = line.match(/^\s*[•*-]\s+(.*)/);
      if (bullet) {
        if (!list) nodes.push(list = el("ul"));
        paragraph = null;
        const li = el("li");
        li.append(...linked(bullet[1]));
        list.append(li);
      } else {
        if (!paragraph) nodes.push(paragraph = el("p"));
        else paragraph.append(el("br"));
        list = null;
        const label = line.match(LABEL);
        if (label) paragraph.append(el("strong", null, label[0]));
        paragraph.append(...linked(label ? line.slice(label[0].length) : line));
      }
    }
  }
  return nodes;
}

// One dialog for the page, filled for whichever card opened it. A native modal dialog
// keeps focus inside, closes on Escape, and tells screen readers what it is.
let dialog;
let opener;
function detailsDialog() {
  if (dialog) return dialog;
  dialog = el("dialog", "event-dialog");
  dialog.setAttribute("aria-labelledby", "event-dialog-title");
  dialog.addEventListener("close", () => {
    opener?.setAttribute("aria-expanded", "false");
    opener?.focus();
  });
  // A click on the dimmed page around the dialog closes it.
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  document.body.append(dialog);
  return dialog;
}

function showDetails(event, button) {
  const start = new Date(event.start);
  // An all-day event ends at midnight after its last day.
  const end = new Date(event.allDay ? new Date(event.end) - 1 : event.end);
  const box = detailsDialog();
  const content = el("div", "event-dialog-body");

  const title = el("h2", null, event.title);
  title.id = "event-dialog-title";
  title.tabIndex = -1;
  // showModal focuses it, so screen readers start at the top of the details rather than on a button.
  title.autofocus = true;
  const date = el("p", "event-dialog-date", longDate.format(start));
  if (monthDay.format(start) !== monthDay.format(end)) {
    date.append(shown(" – "), spoken(" to "), longDate.format(end));
  }
  content.append(title, date);
  if (!event.allDay) content.append(whenText(event, start, end));

  const add = el("div", "event-add");
  const google = el("a", "button", "Add to Google Calendar");
  google.append(el("span", "visually-hidden", " (opens in a new tab)"));
  google.href = googleLink(event);
  google.target = "_blank";
  google.rel = "noopener";
  const ics = el("a", "button button-secondary", "Add to Apple, Outlook, or other (.ics)");
  ics.href = icsLink(event);
  ics.download = `${event.title.replace(/[^\w]+/g, "-")}-${event.start.slice(0, 10)}.ics`;
  add.append(google, ics);
  content.append(add);

  if (event.location) content.append(el("p", "event-dialog-place", event.location.replace(/, USA$/, "")));
  const by = organizerLine(event);
  if (by) content.append(by);
  if (event.description) {
    const description = el("div", "event-description");
    description.append(...descriptionNodes(event.description));
    content.append(description);
  }

  const close = el("button", "event-dialog-close", "Close");
  close.type = "button";
  close.addEventListener("click", () => box.close());

  box.replaceChildren(content, close);
  opener = button;
  button.setAttribute("aria-expanded", "true");
  box.showModal();
}

function renderEvent(event) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const item = el("li", "event");
  item.dataset.tags = ["all", ...(event.tags || [])].join(" ");
  const club = (event.tags || []).includes("club");
  if (club) item.classList.add("event-club");
  item.dataset.city = event.city ? slug(event.city) : "";

  // The title's button stretches over the whole card, so a click anywhere opens the details.
  // The heading carries the full date, so jumping between headings says what and when.
  const body = el("div", "event-body");
  const heading = el("h3");
  const open = el("button", "event-open", event.title);
  open.type = "button";
  open.setAttribute("aria-haspopup", "dialog");
  open.setAttribute("aria-expanded", "false");
  if (club) open.append(spoken(", club event"));
  open.append(spoken(`, ${longDate.format(start)}`));
  open.addEventListener("click", () => showDetails(event, open));
  heading.append(open);
  if (club) {
    // The heading already says it.
    const label = el("p", "event-club-label", "Club event");
    label.setAttribute("aria-hidden", "true");
    body.append(label);
  }
  body.append(heading, whenText(event, start, end));
  if (event.location) body.append(el("p", "event-meta", event.location.split(",")[0]));
  const by = organizerLine(event);
  if (by) body.append(by);

  // The heading already says the date.
  const date = el("div", "event-date");
  date.setAttribute("aria-hidden", "true");
  date.append(
    el("span", "event-month", month.format(start)),
    el("span", "event-day", day.format(start)),
    el("span", "event-year", year.format(start)),
  );

  item.append(body, date);
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

// Independent groups of filter buttons, each in a menu under a chip: kind of event, age, how
// often, cost, time control, and city. A card shows when it matches every group. The
// time control and city buttons come from the events themselves, so a page with no timed events
// has no time control menu. The choice is kept in the address, e.g.
// #kind=youth&schedule=weekly&city=loveland.
// US Chess's rating categories, from the speed metadata in update_calendar.py.
const SPEEDS = { regular: "Regular", quick: "Quick", blitz: "Blitz" };
const MATCHES = {
  kind: (card, value) => card.dataset.tags.split(" ").includes(value),
  age: (card, value) => card.dataset.tags.split(" ").includes(value),
  schedule: (card, value) => card.dataset.tags.split(" ").includes("weekly") === (value === "weekly"),
  cost: (card, value) => card.dataset.tags.split(" ").includes(value),
  speed: (card, value) => card.dataset.tags.split(" ").includes(value),
  city: (card, value) => card.dataset.city === value,
};

function setUpFilters(container, filtersId, events) {
  const panel = document.getElementById(filtersId);
  const speedGroup = panel.querySelector('[data-filter-group="speed"]');
  const speeds = Object.keys(SPEEDS).filter((s) => events.some((e) => (e.tags || []).includes(s)));
  if (speeds.length === 0) {
    panel.querySelector('[popovertarget="filter-speed"]')?.remove();
    speedGroup?.remove();
  }
  for (const value of speeds.length ? ["all", ...speeds] : []) {
    const button = el("button", null, value === "all" ? "Any time control" : SPEEDS[value]);
    button.type = "button";
    button.dataset.value = value;
    speedGroup.append(button);
  }
  const cityGroup = panel.querySelector('[data-filter-group="city"]');
  const cities = [...new Set(events.map((e) => e.city).filter(Boolean))].sort();
  for (const name of ["all", ...cities]) {
    const button = el("button", null, name === "all" ? "All cities" : name);
    button.type = "button";
    button.dataset.value = name === "all" ? "all" : slug(name);
    cityGroup.append(button);
  }
  const groups = [...panel.querySelectorAll("[data-filter-group]")].map((node) => ({
    name: node.dataset.filterGroup,
    buttons: [...node.querySelectorAll("button[data-value]")],
    node,
    menu: panel.querySelector(`[popovertarget="${node.id}"]`),
  }));
  for (const g of groups) g.menu.dataset.label = g.menu.textContent;
  const state = Object.fromEntries(groups.map((g) => [g.name, "all"]));

  const readHash = () => {
    const raw = decodeURIComponent(location.hash.slice(1));
    // Older links name a single value, like #youth; find the group that has it.
    const bare = !raw.includes("=") && groups.find((g) => g.buttons.some((b) => b.dataset.value === raw));
    const params = new URLSearchParams(bare ? `${bare.name}=${raw}` : raw);
    for (const g of groups) {
      const value = params.get(g.name);
      state[g.name] = g.buttons.some((b) => b.dataset.value === value) ? value : "all";
    }
  };
  const writeHash = () => {
    const params = new URLSearchParams();
    for (const g of groups) if (state[g.name] !== "all") params.set(g.name, state[g.name]);
    const value = params.toString();
    history.replaceState(null, "", value ? `#${value}` : location.pathname);
  };
  const apply = (announce) => {
    for (const g of groups) {
      for (const b of g.buttons) b.setAttribute("aria-pressed", String(b.dataset.value === state[g.name]));
      const chosen = state[g.name] !== "all" && g.buttons.find((b) => b.dataset.value === state[g.name]);
      g.menu.classList.toggle("filter-menu-set", Boolean(chosen));
      g.menu.replaceChildren(...(chosen
        ? [el("span", "visually-hidden", `${g.menu.dataset.label}: `), chosen.textContent]
        : [g.menu.dataset.label]));
    }
    let count = 0;
    for (const card of container.querySelectorAll(".event")) {
      const match = groups.every((g) => state[g.name] === "all" || MATCHES[g.name](card, state[g.name]));
      card.hidden = !match;
      if (match) count++;
    }
    for (const group of container.querySelectorAll(".event-group")) {
      group.hidden = !group.querySelector(".event:not([hidden])");
    }
    container.querySelector(".events-empty").hidden = count > 0;
    if (announce) {
      const labels = groups.filter((g) => state[g.name] !== "all")
        .map((g) => g.buttons.find((b) => b.dataset.value === state[g.name]).textContent);
      document.getElementById("filter-status").textContent =
        `Showing ${count} ${count === 1 ? "event" : "events"}${labels.length ? `: ${labels.join(", ")}` : ""}`;
    }
  };

  for (const g of groups) {
    for (const b of g.buttons) {
      b.addEventListener("click", () => {
        state[g.name] = b.dataset.value;
        writeHash();
        apply(true);
        g.node.hidePopover();
        g.menu.focus();
        // Once the bar is stuck under the navigation, bring the list's start back under it
        // rather than leave the reader somewhere in the middle of a list that just changed.
        const top = container.getBoundingClientRect().top + scrollY - panel.getBoundingClientRect().bottom;
        if (scrollY > top) scrollTo(0, top);
      });
    }
    // Menus open in the top layer, above the sticky bar and the cards, so they are placed
    // under their chip by hand.
    const place = () => {
      const chip = g.menu.getBoundingClientRect();
      g.node.style.top = `${chip.bottom + 6}px`;
      g.node.style.left = `${Math.max(8, Math.min(chip.left, innerWidth - g.node.offsetWidth - 8))}px`;
    };
    g.node.addEventListener("toggle", (event) => {
      if (event.newState !== "open") return removeEventListener("scroll", place);
      place();
      addEventListener("scroll", place, { passive: true });
    });
  }
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

// The navigation sticks to the top, and it wraps on a phone, so what docks under it and what
// in-page links scroll to need its height as it is.
const nav = document.querySelector(".site-nav");
new ResizeObserver(() => document.documentElement.style.setProperty("--nav-height", `${nav.offsetHeight}px`)).observe(nav);

const list = document.querySelector("[data-events]");
fetch(list.dataset.src || "events.json", { cache: "no-cache" })
  .then((response) => response.json())
  .then((events) => {
    const now = new Date();
    let upcoming = events.filter((e) => new Date(e.end) > now);
    if (list.dataset.calendar) upcoming = upcoming.filter((e) => e.calendar === list.dataset.calendar);
    if (list.dataset.only) upcoming = upcoming.filter((e) => (e.tags || []).includes(list.dataset.only));
    if (list.dataset.without) upcoming = upcoming.filter((e) => !(e.tags || []).includes(list.dataset.without));
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
