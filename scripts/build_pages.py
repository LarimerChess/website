"""Write the pages that come from events.json, so search engines read them without running JavaScript.

    python scripts/build_pages.py          # update the pages and sitemap.xml
    python scripts/build_pages.py --check  # fail if any is out of date with events.json

- events/index.html gets schema.org Event data for every club event.
- Each club event gets its own page at its "page" path (events/<name>/), with its
  next date, its calendar description, a Register form and entry list (register.js), and its
  Event data. A page whose event has left
  events.json is deleted.
- sitemap.xml lists those pages, and gives each page that events.json fills a lastmod:
  the day what it shows last changed. Every other page's lastmod is the day of the last
  commit that changed its text, or today if the working copy changes it; the styles and
  script stamp that sync_assets.py writes, and whitespace, don't count. That needs the
  full git history, and --check leaves those dates as they are.

The Update calendar Action runs this after scripts/update_calendar.py, and the Date pages
Action after every push to main.
"""

import hashlib
import html
import json
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://larimerchess.org"
EVENTS_PAGE = SITE + "/events/"
CLUB = "Larimer County Chess Club"
TZ = ZoneInfo("America/Denver")
GENERATED = "<!-- Written by scripts/build_pages.py from events.json; don't edit by hand. -->"
EVENT_DATA = re.compile(r'<script type="application/ld\+json" id="club-events">.*?</script>', re.S)
# Which events each listing page shows, so its lastmod moves only when they change.
LISTINGS = {
    "events/": lambda e: "youth" not in e["tags"],
    "scholastic/": lambda e: "youth" in e["tags"],
}
LABEL = re.compile(r"^(?:Cost(?: for [^:]+)?|Time control):")
LINK = re.compile(r"https?://[^\s<>\"]*[^\s<>\".,;:!?)]|[\w.+-]+@[\w-]+\.[\w.-]*\w")
STREET_ABBREVIATIONS = {"St", "Ave", "Rd", "Dr", "Blvd", "Ln", "Ct", "Pl", "Pkwy"}
NAV = [("/events/", "Events"), ("/entries/", "Entries"), ("/pairings/", "Pairings"),
       ("/scholastic/", "Scholastic"), ("/minutes/", "Board minutes"), ("/#join", "Join")]


def time_text(t):
    return f"{t.hour % 12 or 12}:{t.minute:02d} {'AM' if t.hour < 12 else 'PM'}"


def day_text(e):
    """'Saturday, November 7, 2026'"""
    start = datetime.fromisoformat(e["start"]).astimezone(TZ)
    return f"{start:%A}, {start:%B} {start.day}, {start.year}"


def when_text(e):
    """'Saturday, November 7, 2026, 10:00 AM – 7:00 PM', by docs/style.md's rules for dates and times."""
    start, end = datetime.fromisoformat(e["start"]).astimezone(TZ), datetime.fromisoformat(e["end"]).astimezone(TZ)
    day = day_text(e)
    if e["allDay"]:
        return day
    if start.date() != end.date():
        return f"{day}, {time_text(start)} – {end:%A}, {end:%B} {end.day}, {time_text(end)}"
    first = time_text(start)
    if (start.hour < 12) == (end.hour < 12):
        first = first[:-3]
    return f"{day}, {first} – {time_text(end)}"


def escaped(s):
    return html.escape(s, quote=False)


def linked(s):
    """Escaped text with its web and email addresses made into links, shown without scheme or fragment."""
    out, last = [], 0
    for match in LINK.finditer(s):
        out.append(escaped(s[last:match.start()]))
        href, shown = html.escape(match[0]), escaped(re.sub(r"^https?://|#.*$", "", match[0]))
        if "@" in match[0] and not match[0].startswith("http"):
            out.append(f'<a href="mailto:{href}">{shown}</a>')
        elif match[0].startswith(SITE):
            out.append(f'<a href="{href}">{shown}</a>')
        else:
            out.append(f'<a href="{href}" target="_blank" rel="noopener">{shown}'
                       '<span class="visually-hidden"> (opens in a new tab)</span></a>')
        last = match.end()
    out.append(escaped(s[last:]))
    return "".join(out)


def description_html(text):
    """A calendar description as paragraphs, with "•" lines as a list, as calendar.js shows it."""
    out = []
    for block in re.split(r"\n\s*\n", text.strip()):
        paragraph, items = [], []
        for line in block.split("\n"):
            if line.strip() == "larimerchess.org":
                continue
            bullet = re.match(r"^\s*[•*-]\s+(.*)", line)
            if bullet:
                if paragraph:
                    out.append("<p>" + "<br>".join(paragraph) + "</p>")
                    paragraph = []
                items.append(f"<li>{linked(bullet[1])}</li>")
                continue
            if items:
                out.append("<ul>" + "".join(items) + "</ul>")
                items = []
            label = LABEL.match(line)
            paragraph.append(f"<strong>{escaped(label[0])}</strong>{linked(line[label.end():])}" if label
                             else linked(line))
        if paragraph:
            out.append("<p>" + "<br>".join(paragraph) + "</p>")
        if items:
            out.append("<ul>" + "".join(items) + "</ul>")
    return "\n      ".join(out)


def summary(e):
    """The first sentence of what the event is: the description's first block that isn't Cost or Time control."""
    for block in re.split(r"\n\s*\n", e["description"].strip()):
        if block and not LABEL.match(block):
            match = re.match(r"(.+?[.!?])(?:\s|$)", block.split("\n")[0])
            return match[1] if match else block.split("\n")[0]
    return ""


def cost(e):
    match = re.search(r"^Cost: (.+)$", e["description"], re.M)
    return match[1].split(". ")[0].rstrip(".") + "." if match else ""


def street(place):
    words = place["street"].split()
    return place["street"] + ("." if words and words[-1] in STREET_ABBREVIATIONS else "")


def event_data(e):
    url = SITE + e["page"] if e.get("page") else EVENTS_PAGE
    item = {
        "@context": "https://schema.org",
        "@type": "Event",
        "name": e["title"],
        "startDate": e["start"],
        "endDate": e["end"],
        "eventStatus": "https://schema.org/EventScheduled",
        "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
        "organizer": {"@type": "SportsOrganization", "name": CLUB, "url": SITE + "/"},
        "url": url,
        "image": SITE + "/share.png",
        "description": summary(e) or f"{e['title']}, a US Chess rated event of the {CLUB} in Fort Collins, Colorado.",
    }
    if e["place"].get("name"):
        p = e["place"]
        item["location"] = {
            "@type": "Place",
            "name": p["name"],
            "address": {"@type": "PostalAddress", "streetAddress": p["street"], "addressLocality": p["city"],
                        "addressRegion": p["region"], "postalCode": p["zip"], "addressCountry": "US"},
        }
    if e["price"]:
        item["offers"] = {"@type": "Offer", "price": e["price"], "priceCurrency": "USD", "url": url,
                          "availability": "https://schema.org/InStock"}
    return item


def data_script(events):
    data = json.dumps([event_data(e) for e in events], ensure_ascii=False).replace("</", "<\\/")
    return f'<script type="application/ld+json" id="club-events">{data}</script>'


def fee(prices, event, kind, value):
    """The prices.json row for an event's date or month: the most specific "applies" wins. None if none applies."""
    rank = lambda applies: 3 if applies == value else 2 if applies == value[:7] else 1 if applies == "all" else 0
    rows = [r for r in prices.get(event, []) if r["kind"] == kind and rank(r["applies"])]
    return max(rows, key=lambda r: rank(r["applies"]), default=None)


def fee_text(row):
    """'$15, free under 18', or '$15 adults, $10 seniors (65+), free under 18'."""
    if not row:
        return "fee to be announced"
    money = lambda n: "free" if n == 0 else f"${n:.0f}" if n == int(n) else f"${n:.2f}"
    if row["adult"] == row["senior"] == row["youth"] == 0:
        return "free"
    youth = "free under 18" if row["youth"] == 0 else f"{money(row['youth'])} under 18"
    if row["senior"] == row["adult"]:
        return f"{money(row['adult'])}, {youth}"
    return f"{money(row['adult'])} adults, {money(row['senior'])} seniors (65+), {youth}"


def register_choices(events, prices):
    """What a player registers for, as (group, [(value, shown, phrase)]): a tournament's dates, or
    each month of a club night, whole or by the night, each shown with its fee. The phrase
    finishes "registered for …"."""
    name = events[0]["page"].strip("/").split("/")[-1]
    with_fee = lambda value, kind, shown: f"{shown} · {fee_text(fee(prices, name, kind, value))}"
    if "tournament" in events[0]["tags"]:
        return [(None, [(e["start"][:10], with_fee(e["start"][:10], "entry", day_text(e)), day_text(e))
                        for e in events])]
    months = {}
    for e in events:
        start = datetime.fromisoformat(e["start"]).astimezone(TZ)
        month = months.setdefault(f"{start:%B} {start.year}", [(
            e["start"][:7], with_fee(e["start"][:7], "month", f"All {start:%A}s in {start:%B}"),
            f"all {start:%A}s in {start:%B} {start.year}")])
        month.append((e["start"][:10], with_fee(e["start"][:10], "night", f"{start:%A}, {start:%B} {start.day}"),
                      day_text(e)))
    return list(months.items())


def register_html(events, prices):
    """The Register form and entry list, which register.js brings to life; one choice or a menu of them."""
    name = events[0]["page"].strip("/").split("/")[-1]
    groups = register_choices(events, prices)
    tournament = "tournament" in events[0]["tags"]
    option = lambda value, shown, phrase: (f'<option value="{value}" data-day="{html.escape(phrase)}">'
                                           f"{escaped(shown)}</option>")
    if tournament and len(groups[0][1]) == 1:
        value, shown, phrase = groups[0][1][0]
        date = (f'<input type="hidden" name="date" value="{value}" data-day="{html.escape(phrase)}">'
                f'\n        <p class="register-for"><strong>{escaped(shown)}</strong></p>')
    else:
        options = "".join(f'<optgroup label="{html.escape(group)}">{"".join(option(*c) for c in choices)}</optgroup>'
                          if group else "".join(option(*c) for c in choices) for group, choices in groups)
        label = "Date" if tournament else "Night or month"
        date = f'<label for="register-date">{label}</label>\n        <select id="register-date" name="date">{options}</select>'
    for_column = "" if tournament else '<th scope="col">For</th>'
    return f"""<section id="register">
      <h2>Register</h2>
      <p class="register-closed" hidden>Online registration isn't open yet. To register, email <a href="mailto:president@larimerchess.org">president@larimerchess.org</a>.</p>
      <noscript><p>Online registration needs JavaScript. To register, email <a href="mailto:president@larimerchess.org">president@larimerchess.org</a>.</p></noscript>
      <form class="register-form" hidden>
        <p>Register online, then pay when you arrive. Your confirmation email says how much.</p>
        <input type="hidden" name="event" value="{name}">
        {date}
        <label for="register-id">US Chess ID</label>
        <input id="register-id" name="id" type="text" inputmode="numeric" pattern="[0-9]{{8}}" maxlength="8" required autocomplete="off" aria-describedby="register-id-hint">
        <p id="register-id-hint" class="register-hint">Eight digits. Every player needs a current US Chess membership; <a href="https://new.uschess.org/join-us-chess#:~:text=Individual%20Membership%20Options" target="_blank" rel="noopener">join or renew<span class="visually-hidden"> (opens in a new tab)</span></a> first.</p>
        <label for="register-last">Last name</label>
        <input id="register-last" name="last" type="text" required autocomplete="family-name">
        <label for="register-email">Email</label>
        <input id="register-email" name="email" type="email" required autocomplete="email" aria-describedby="register-email-hint">
        <p id="register-email-hint" class="register-hint">For a player under 18, a parent's or guardian's. It isn't shown on the entry list.</p>
        <div class="register-trap" aria-hidden="true">
          <label for="register-website">Leave this empty</label>
          <input id="register-website" name="website" type="text" tabindex="-1" autocomplete="off">
        </div>
        <button class="button" type="submit">Register</button>
        <p class="register-status" role="status"></p>
      </form>
    </section>

    <section id="entries">
      <h2>Entries</h2>
      <p class="entries-status" role="status"></p>
      <table class="entries" hidden>
        <thead><tr><th scope="col">Name</th><th scope="col">US Chess ID</th><th scope="col">Rating</th>{for_column}</tr></thead>
        <tbody></tbody>
      </table>
    </section>"""


def series_page(events, prices):
    """The page for one club event, from its upcoming dates; the next date's description is shown."""
    e = events[0]
    name = e["title"].removeprefix(CLUB).strip()
    p = e["place"]
    city = p.get("city") or e["city"] or "Fort Collins"
    url = SITE + e["page"]
    kind = "tournament" if "tournament" in e["tags"] else "club night"
    title = f"{name} | {city} Chess {kind.title()}"
    if len(title) > 70:
        title = name
    what = summary(e)
    description = " ".join(x for x in [what, f"Next: {when_text(e).rsplit(', ', 1)[0]}.", cost(e)] if x)
    if p.get("name"):
        query = quote(f"{p['name']}, {p['street']}, {p['city']}, {p['region']} {p['zip']}")
        where = (f'<address><a href="https://www.google.com/maps/search/?api=1&amp;query={query}" target="_blank" '
                 f'rel="noopener"><span class="visually-hidden">Map: </span>{escaped(p["name"])}<br>'
                 f'{escaped(street(p))}<br>{escaped(p["city"])}, {p["region"]} {p["zip"]}'
                 '<span class="visually-hidden"> (opens in a new tab)</span></a></address>')
    else:
        where = f"<p>{escaped(e['location'])}</p>"
    main = f"""<h1>{escaped(name)}</h1>
    <p>A US Chess rated {kind} of the {CLUB} in {escaped(city)}, Colorado.
      Next: <time datetime="{e["start"]}">{escaped(when_text(e))}</time>.</p>

    <section id="details">
      <h2>Details</h2>
      {description_html(e["description"])}
    </section>

    {register_html(events, prices)}

    <section id="where">
      <h2>Where</h2>
      {where}
    </section>

    <p><a href="/events/">All chess events in Fort Collins and Larimer County</a></p>"""
    stamp = hashlib.sha256((ROOT / "register.js").read_bytes()).hexdigest()[:10]
    return page_html(title, description, url, main, head=data_script(events),
                     scripts=f'<script src="../../register.js?v={stamp}" defer></script>')


def page_html(title, description, url, main, head="", scripts="", depth=2, current=None, main_attributes="",
              generated=GENERATED):
    """A page in the site's shell, with style.css inlined as sync_assets.py keeps it. current is
    the navigation link to mark as this page."""
    css = (ROOT / "style.css").read_text(encoding="utf-8")
    up = "../" * depth
    nav = "\n".join(f'        <li><a href="{href}"{' aria-current="page"' if href == current else ''}>{text}</a></li>'
                    for href, text in NAV)
    head = f"\n  {head}" if head else ""
    scripts = f"\n  {scripts}" if scripts else ""
    return f"""<!DOCTYPE html>
{generated}
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escaped(title)}</title>
  <meta name="description" content="{html.escape(description)}">
  <link rel="canonical" href="{url}">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="{CLUB}">
  <meta property="og:title" content="{html.escape(title)}">
  <meta property="og:description" content="{html.escape(description)}">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{SITE}/share.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Larimer County Chess Club, Fort Collins, Colorado: Monday club nights and US Chess rated Saturday tournaments. larimerchess.org">
  <meta name="twitter:card" content="summary_large_image">{head}
  <link rel="preload" href="{up}fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="{up}fonts/fraunces-latin.woff2" as="font" type="font/woff2" crossorigin>
  <style>
{css}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  <nav class="site-nav" aria-label="Main">
    <div class="wrap">
      <a class="brand" href="/"><span aria-hidden="true">♞ </span>{CLUB}</a>
      <ul>
{nav}
      </ul>
    </div>
  </nav>
  <main id="main" class="wrap"{main_attributes}>
    {main}
  </main>

  <footer class="wrap">
    <address>Larimer County Chess Club, 500 Mathews St., Fort Collins, Colorado 80524</address>
    <p><a href="https://new.uschess.org/club-search-and-affiliate-directory?display_name=larimer" target="_blank" rel="noopener">US Chess affiliate A4003249<span class="visually-hidden"> (opens in a new tab)</span></a></p>
    <p>© 2026 Larimer County Chess Club</p>
  </footer>{scripts}
</body>
</html>
"""


def committed_events():
    """events.json as last committed, to tell whether a listing page's events changed; None if unknown."""
    try:
        shown = subprocess.run(["git", "show", "HEAD:events.json"], cwd=ROOT, capture_output=True, check=True)
        return json.loads(shown.stdout)
    except (OSError, subprocess.CalledProcessError, ValueError):
        return None


# What sync_assets.py and this script write into hand-written pages, left out when telling whether one changed.
NOT_CONTENT = re.compile(r'<style>.*?</style>|<link rel="stylesheet"[^>]*>|\?v=[0-9a-f]+|' + EVENT_DATA.pattern, re.S)


def git_text(spec):
    try:
        return subprocess.run(["git", "show", spec], cwd=ROOT, capture_output=True, check=True).stdout.decode()
    except (OSError, subprocess.CalledProcessError):
        return None


def content_changed(path, today):
    """The day a hand-written page's text last changed; None if git can't tell."""
    content = lambda text: text and " ".join(NOT_CONTENT.sub("", text).split())
    if content((ROOT / path).read_text(encoding="utf-8")) != content(git_text(f"HEAD:{path}")):
        return today
    try:
        log = subprocess.run(["git", "log", "--format=%H %cI", "--", path], cwd=ROOT,
                             capture_output=True, check=True, text=True).stdout.split("\n")
    except (OSError, subprocess.CalledProcessError):
        return None
    for line in filter(None, log):
        commit, when = line.split()
        if content(git_text(f"{commit}:{path}")) != content(git_text(f"{commit}^:{path}")):
            return datetime.fromisoformat(when).astimezone(TZ).date().isoformat()
    return None


def sitemap(text, pages, changed, today, date_pages=True):
    """sitemap.xml with the series pages listed after events/, and lastmod moved for the pages that changed."""
    entries = re.findall(r"<url><loc>([^<]+)</loc>(?:<lastmod>([^<]+)</lastmod>)?</url>", text)
    old = dict(entries)
    static = [loc for loc, _ in entries if not re.fullmatch(re.escape(SITE) + r"/events/[^/]+/", loc)]
    locs = []
    for loc in static:
        locs.append(loc)
        if loc == EVENTS_PAGE:
            locs += sorted(SITE + "/" + path for path in pages)
    lines = []
    for loc in locs:
        path = loc.removeprefix(SITE + "/")
        if path in changed:
            lastmod = today
        elif path in pages:
            lastmod = old.get(loc) or today
        else:
            file = path + "index.html" if path == "" or path.endswith("/") else path
            edited = (date_pages and content_changed(file, today)) or old.get(loc) or today
            lastmod = max(edited, old.get(loc) or today) if path in LISTINGS else edited
        lines.append(f"  <url><loc>{loc}</loc>" + (f"<lastmod>{lastmod}</lastmod>" if lastmod else "") + "</url>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "\n".join(lines) + "\n</urlset>\n")


def main(check):
    events = json.loads((ROOT / "events.json").read_text(encoding="utf-8"))
    club = [e for e in events if e["organizer"] == CLUB]
    writes = {}

    listing = (ROOT / "events/index.html").read_text(encoding="utf-8")
    if not EVENT_DATA.search(listing):
        sys.exit("events/index.html has no <script type=\"application/ld+json\" id=\"club-events\"> to fill.")
    writes["events/index.html"] = EVENT_DATA.sub(lambda _: data_script(club), listing)

    series = defaultdict(list)
    for e in club:
        if e.get("page"):
            series[e["page"].removeprefix("/")].append(e)
    prices = json.loads((ROOT / "prices.json").read_text(encoding="utf-8"))
    pages = {path: series_page(dated, prices) for path, dated in series.items()}
    changed = {}
    for path, text in pages.items():
        file = ROOT / path / "index.html"
        writes[f"{path}index.html"] = text
        if not file.exists() or file.read_text(encoding="utf-8") != text:
            changed[path] = True
    before = committed_events()
    for path, shows in LISTINGS.items():
        if before is None or [e for e in before if shows(e)] != [e for e in events if shows(e)]:
            changed[path] = True
    for page in ROOT.rglob("*.html"):
        if ("node_modules" in page.parts or any(part.startswith(".") for part in page.relative_to(ROOT).parts)
                or GENERATED in page.read_text(encoding="utf-8")):
            continue
        for link in re.findall(r'href="/(events/[^/"#]+/)', page.read_text(encoding="utf-8")):
            if link not in pages:
                sys.exit(f"{page.relative_to(ROOT)} links to /{link}, but events.json has no club event there. "
                         "Fix the link, or the event's title in Google Calendar.")
    gone = [d for d in (ROOT / "events").iterdir()
            if d.is_dir() and f"events/{d.name}/" not in pages and (d / "index.html").exists()
            and GENERATED in (d / "index.html").read_text(encoding="utf-8")]

    shallow = subprocess.run(["git", "rev-parse", "--is-shallow-repository"], cwd=ROOT, capture_output=True, text=True)
    if not check and shallow.stdout.strip() == "true":
        sys.exit("The git history is shallow, so pages can't be dated; check out with fetch-depth: 0.")
    sitemap_text = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
    today = datetime.now(TZ).date().isoformat()
    writes["sitemap.xml"] = sitemap(sitemap_text, pages, changed if not check else {}, today, date_pages=not check)

    stale = [path for path, text in writes.items()
             if not (ROOT / path).exists() or (ROOT / path).read_text(encoding="utf-8") != text]
    stale += [f"events/{d.name}/" for d in gone]
    if check:
        for path in stale:
            print(f"FAIL {path}: out of date with events.json; run python scripts/build_pages.py")
        if stale:
            sys.exit(1)
        print(f"ok   pages match events.json ({len(club)} club events, {len(pages)} event pages)")
        return
    for path in stale:
        if path.endswith("/"):
            shutil.rmtree(ROOT / path)
            continue
        (ROOT / path).parent.mkdir(parents=True, exist_ok=True)
        (ROOT / path).write_text(writes[path], encoding="utf-8")
    print(f"updated {len(stale)} file(s): {', '.join(stale) or 'none'}")


if __name__ == "__main__":
    main("--check" in sys.argv)
