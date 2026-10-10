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
  if (event.description) return `${event.description}\n\n${event.page ? `https://larimerchess.org${event.page}` : EVENTS_PAGE}`;
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

// Other sites open in a new tab, so the calendar stays where the reader left it.
function external(a, href) {
  a.href = href;
  if (a.hostname === "larimerchess.org" || a.origin === location.origin) return a;
  a.target = "_blank";
  a.rel = "noopener";
  a.append(spoken(" (opens in a new tab)"));
  return a;
}

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
// A club event's Details go to its own page on this site.
function organizerLine(event) {
  const runBy = event.organizer && event.organizer !== CLUB ? `Run by ${event.organizer}` : "";
  const href = event.url || event.page;
  if (!runBy && !href) return null;
  const by = el("p", "event-meta event-organizer", runBy);
  if (href) {
    const details = el("a", null, "Details");
    details.append(spoken(` about ${event.title}`));
    external(details, href);
    if (runBy) by.append(shown(" · "));
    by.append(details);
  }
  return by;
}

// Registering is the site's main call to action, so every club event offers it: on the card,
// and at the top and bottom of the details. It opens the Register form on the event's page.
function registerLink(event, className) {
  if (!event.page || event.organizer !== CLUB) return null;
  const link = el("a", className, "Register");
  link.append(spoken(` for ${event.title}, ${longDate.format(new Date(event.start))}`));
  link.href = `${event.page}?date=${event.start.slice(0, 10)}#register`;
  return link;
}

// Text with its web addresses made into links, built as nodes so nothing in it is read as HTML.
function linked(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]*[^\s<>".,;:!?)]/g)) {
    nodes.push(text.slice(last, match.index));
    nodes.push(external(el("a", null, match[0]), match[0]));
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
  const registerTop = registerLink(event, "button event-register");
  if (registerTop) content.append(registerTop);

  const add = el("div", "event-add");
  const google = el("a", "button", "Add to Google Calendar");
  external(google, googleLink(event));
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
  const registerBottom = registerLink(event, "button event-register");
  if (registerBottom) content.append(registerBottom);

  const close = el("button", "event-dialog-close", "Close");
  close.type = "button";
  close.addEventListener("click", () => box.close());
  // Stays in the corner while a long description scrolls, where a thumb finds it on a phone.
  const corner = el("button", "event-dialog-x", "×");
  corner.type = "button";
  corner.setAttribute("aria-label", "Close");
  corner.addEventListener("click", () => box.close());

  box.replaceChildren(corner, content, close);
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
  const register = registerLink(event, "button event-card-register");
  if (register) body.append(register);

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
  // At most this many matching cards show at once; laying out all of them made each filter
  // change slow on an older laptop or phone. How many are showing is kept in the history entry,
  // so a reload or Back comes back to the same list.
  const PAGE = 30;
  let shown = history.state?.shown ?? PAGE;
  const more = el("button", "button button-secondary events-more", "Show more events");
  more.type = "button";
  container.append(more);

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
    history.replaceState({ shown }, "", value ? `#${value}` : location.pathname);
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
    const matches = [];
    for (const card of container.querySelectorAll(".event")) {
      const match = groups.every((g) => state[g.name] === "all" || MATCHES[g.name](card, state[g.name]));
      card.hidden = !match || matches.length >= shown;
      if (match) matches.push(card);
    }
    const count = matches.length;
    more.hidden = count <= shown;
    for (const group of container.querySelectorAll(".event-group")) {
      group.hidden = !group.querySelector(".event:not([hidden])");
    }
    container.querySelector(".events-empty").hidden = count > 0;
    if (announce) {
      const labels = groups.filter((g) => state[g.name] !== "all")
        .map((g) => g.buttons.find((b) => b.dataset.value === state[g.name]).textContent);
      document.getElementById("filter-status").textContent =
        `Showing ${count > shown ? `${shown} of ` : ""}${count} ${count === 1 ? "event" : "events"}${labels.length ? `: ${labels.join(", ")}` : ""}`;
    }
    return matches;
  };

  const showMore = () => {
    const first = shown;
    shown += PAGE;
    writeHash();
    return apply(true)[first];
  };
  // The button moves down past the new cards, so focus goes to the first of them.
  more.addEventListener("click", () => showMore()?.querySelector(".event-open").focus());
  // Scrolling near the end of the list shows more without a click. The observer only reports
  // changes, so it is restarted after each page in case the button is still in view.
  const nearEnd = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting) || more.hidden) return;
    showMore();
    nearEnd.unobserve(more);
    nearEnd.observe(more);
  }, { rootMargin: "0px 0px 600px 0px" });
  nearEnd.observe(more);

  for (const g of groups) {
    for (const b of g.buttons) {
      b.addEventListener("click", () => {
        state[g.name] = b.dataset.value;
        shown = PAGE;
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
  window.addEventListener("hashchange", () => { readHash(); shown = PAGE; apply(true); });
  panel.hidden = false;
  readHash();
  apply(false);
}

// The navigation sticks to the top, and it wraps on a phone, so what docks under it and what
// in-page links scroll to need its height as it is.
const nav = document.querySelector(".site-nav");
new ResizeObserver(() => document.documentElement.style.setProperty("--nav-height", `${nav.offsetHeight}px`)).observe(nav);

// On a reload or Back, Chrome restores the scroll position before the cards exist, while the
// page is still short, and the cards then push everything in view far down. So the position
// is put back once they are drawn, unless the reader has started scrolling by then. The scroll
// waits a frame after the cards are drawn: in the same frame, Chrome counts what scrolls into
// view as having moved.
history.scrollRestoration = "manual";
const scrollKey = `scroll ${location.pathname}`;
addEventListener("pagehide", () => { try { sessionStorage.setItem(scrollKey, String(scrollY)); } catch {} });
let readerMoved = false;
for (const type of ["wheel", "touchstart", "keydown"]) {
  addEventListener(type, () => { readerMoved = true; }, { once: true, passive: true });
}
function restoreScroll() {
  if (readerMoved) return;
  const how = performance.getEntriesByType("navigation")[0]?.type;
  let saved = null;
  try { saved = sessionStorage.getItem(scrollKey); } catch {}
  if ((how === "reload" || how === "back_forward") && saved !== null) {
    scrollTo(0, Number(saved));
    return;
  }
  // A link to a section below the cards, like /events/#subscribe, landed before they pushed it down.
  const target = location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (target) target.scrollIntoView();
}

const list = document.querySelector("[data-events]");

// A reader who scrolled past the list while it loaded would see the cards push everything
// down, which the browser's own scroll anchoring doesn't prevent here. So whatever below the
// list is on screen is held where it is, by scrolling as far as the cards moved it.
function holdInView() {
  const after = [...document.querySelectorAll("main > *, footer")].find((node) =>
    node.id !== "events-fallback" && (list.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
    && node.getBoundingClientRect().bottom > 0 && node.getBoundingClientRect().top < innerHeight);
  if (!after) return () => {};
  const top = after.getBoundingClientRect().top;
  return () => scrollBy(0, after.getBoundingClientRect().top - top);
}

// The home page's two calls to action: the next Monday Club Night and the next Saturday
// tournament. Through a month's second Monday, the club night card asks players to register
// for the month; after it, to drop in.
function nextUp(events, now) {
  const club = events.filter((e) => e.organizer === CLUB && e.page && new Date(e.start) > now);
  const monday = club.find((e) => !e.tags.includes("tournament"));
  const saturday = club.find((e) => e.tags.includes("tournament"));
  const name = (e) => e.title.replace(CLUB, "").trim();
  const when = (e) => `${longDate.format(new Date(e.start))}, ${timeRange.format(new Date(e.start))}`
    + (e.place?.name ? ` at ${e.place.name}` : "");
  const fill = (id, card) => {
    const link = document.getElementById(id);
    if (!link) return;
    if (!card) { link.hidden = true; return; }
    for (const part of ["kicker", "title", "when", "button"]) link.querySelector(`.next-${part}`).textContent = card[part];
    link.href = card.href;
  };
  let mondayCard = null;
  if (monday) {
    const start = new Date(monday.start);
    const monthName = fmt({ month: "long" }).format(start);
    mondayCard = Math.ceil(Number(day.format(start)) / 7) <= 2
      ? { kicker: name(monday), title: `Register for ${monthName}`, when: `Starts ${when(monday)}`,
          button: `Register for ${monthName}`, href: `${monday.page}?date=${monday.start.slice(0, 7)}#register` }
      : { kicker: name(monday), title: `Drop in ${weekday.format(start)}`, when: when(monday),
          button: "Club night details", href: monday.page };
  }
  fill("next-monday", mondayCard);
  fill("next-saturday", saturday && { kicker: "Next tournament", title: name(saturday), when: when(saturday),
    button: "Register", href: `${saturday.page}?date=${saturday.start.slice(0, 10)}#register` });
}

fetch(list.dataset.src || "events.json", { cache: "no-cache" })
  .then((response) => response.json())
  .then((events) => {
    const held = holdInView();
    const now = new Date();
    nextUp(events, now);
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
    } else {
      list.append(...upcoming.map(renderEvent));
    }
    document.getElementById("events-fallback").remove();
    held();
  })
  .catch(() => {})
  .then(() => requestAnimationFrame(() => requestAnimationFrame(restoreScroll)));
