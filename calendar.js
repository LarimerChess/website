const MAX_EVENTS = 4;
const tz = { timeZone: "America/Denver" };
const fmt = (opts) => new Intl.DateTimeFormat("en-US", { ...tz, ...opts });
const month = fmt({ month: "short" });
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

  item.append(date, body);
  return item;
}

fetch("events.json")
  .then((response) => response.json())
  .then((events) => {
    const now = new Date();
    const upcoming = events.filter((e) => new Date(e.end) > now).slice(0, MAX_EVENTS);
    const list = document.getElementById("events");
    if (upcoming.length === 0) {
      list.replaceWith(el("p", null, "No upcoming events right now. Check back soon."));
    } else {
      list.append(...upcoming.map(renderEvent));
    }
    document.getElementById("events-fallback").remove();
  })
  .catch(() => {});
