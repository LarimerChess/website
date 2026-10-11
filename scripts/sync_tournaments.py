#!/usr/bin/env python3
"""Keep Colorado's weekend tournaments on the club calendar, so the club can plan around them.

    ~/.local/share/lccc/venv/bin/python scripts/sync_tournaments.py [--dry-run]

Reads the Colorado State Chess Association's upcoming tournaments and the Denver
Chess Club's, keeps those that span two to fourteen days, and gives each an
event on the club calendar, timed from its round times when it can be, otherwise all-day, tagged source=coloradochess with a key, plus website
metadata: the card links to the listing and has no "Run by" line. Events are
added, corrected when the listing changes, and deleted before they start if the
listing drops them. A tournament on both sites gets one event, from the
association's listing. If either page can't be read or parsed, nothing is changed. See docs/events/weekend-tournaments.md.
"""
import argparse
import html
import json
import re
import sys
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

from googleapiclient.discovery import build

from update_calendar import CALENDARS
from google_auth import credentials
from sync_chessmates import fetch

CALENDAR = CALENDARS["club"]
SOURCE = "coloradochess"
TZ = ZoneInfo("America/Denver")
CSCA_PAGE = "https://coloradochess.com/tournaments/view-upcoming/"
CSCA_POST = "https://coloradochess.com/wp-json/wp/v2/tournament/{}"
DCC_SITE = "https://denverchess.com"
DCC = "Denver Chess Club"
MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
# "October 24 - 25, 2026", "October 31 - November 1, 2026", "January 5 - 26, 2027", "November 7, 2026";
# the Denver Chess Club leaves out the year when its month heading gives it.
DATES = re.compile(rf"(?:\w+, )?({MONTHS}) (\d{{1,2}})(?:st|nd|rd|th)?(?:, (\d{{4}}))?"
                   rf"(?: - (?:({MONTHS}) )?(\d{{1,2}})(?:st|nd|rd|th)?(?:, (\d{{4}}))?)?$")
MIN_DAYS, MAX_DAYS = 2, 14
WEEKDAYS = {name: i for i, names in enumerate([("monday", "mon"), ("tuesday", "tues", "tue"),
                                                ("wednesday", "wed"), ("thursday", "thurs", "thu"),
                                                ("friday", "fri"), ("saturday", "sat"), ("sunday", "sun")])
            for name in names}
ROUND_TIME = re.compile(rf"\b({'|'.join(WEEKDAYS)})\b|\b(\d{{1,2}})(?::(\d{{2}}))?\s*([ap])\.?\s*m\b\.?|\b(noon)\b",
                        re.I)
# The moves a game is assumed to last when adding up increments.
MOVES = 60


def parse_dates(text, default_year=None):
    """(first day, last day) of a listing's date text, or exit if it isn't a date."""
    match = DATES.match(text.strip())
    if not match:
        sys.exit(f"Can't read the date {text!r}. Has the page changed? Nothing was changed.")
    month1, day1, year1, month2, day2, year2 = match.groups()
    year = year1 or year2 or default_year
    if not year:
        sys.exit(f"No year for the date {text!r}. Nothing was changed.")
    first = datetime.strptime(f"{month1} {day1} {year}", "%B %d %Y").date()
    if not day2:
        return first, first
    last = datetime.strptime(f"{month2 or month1} {day2} {year2 or year}", "%B %d %Y").date()
    # A range over New Year gives one year: the first day's (a month heading) or the last day's.
    if last < first:
        if year2 and not year1:
            first = first.replace(year=first.year - 1)
        else:
            last = last.replace(year=last.year + 1)
    return first, last


def weekend(first, last):
    return MIN_DAYS <= (last - first).days + 1 <= MAX_DAYS


def round_starts(text, first, last):
    """Every round start a listing names, as datetimes.

    Empty unless each time follows a weekday in the tournament and no other number comes between them,
    since "Saturday 10, 2:30, 7 pm" would otherwise read as one round at 7 PM."""
    if (last - first).days >= 7:
        return []
    days = {(first + timedelta(days=n)).weekday(): first + timedelta(days=n) for n in range((last - first).days + 1)}
    starts, day, after = [], None, 0
    for match in ROUND_TIME.finditer(text):
        name, hour, minute, half, noon = match.groups()
        skipped, after = text[after:match.start()], match.end()
        if day and re.search(r"\d", skipped):
            return []
        if name:
            day = days.get(WEEKDAYS[name.lower()])
            if not day:
                return []
            continue
        if not day:
            return []
        hour = 12 if noon else int(hour) % 12 + (12 if half.lower() == "p" else 0)
        starts.append(datetime(day.year, day.month, day.day, hour, int(minute or 0), tzinfo=TZ))
    return starts


def game_minutes(time_control):
    """The longest a game can run, both clocks, from a listing's time control; None if there's no base time.

    Takes the largest of each part (moves control 40/120, sudden death G/90 or SD/30, increment +30),
    so a listing with one control per section gets its longest. A delay adds nothing."""
    moves = [int(m) for n, m in re.findall(r"\b(\d{2})\s*/\s*(\d{2,3})\b", time_control) if int(n) >= 20]
    sudden = [int(m) for m in re.findall(r"\b(?:(?:G|SD|Game)\s*/\s*|Game in\s+)(\d{1,3})\b", time_control, re.I)]
    increment = [int(s) for s in re.findall(r"(?:\+\s*|\binc(?:rement)?\.?\s*)(\d{1,2})\b", time_control, re.I)]
    increment += [int(s) for s in re.findall(r"\b(\d{1,2})\s*(?:s|sec|seconds?)\.?\s+inc", time_control, re.I)]
    if not sudden and not moves:
        return None
    return 2 * (max(moves, default=0) + max(sudden, default=0) + max(increment, default=0) * MOVES / 60)


def speed(time_control):
    """The website's speed metadata (US Chess rating categories) for a listing's time control, or None.

    US Chess adds the base minutes to the increment or delay seconds: 5 to 10 is blitz, under 30
    quick, 30 to 65 both regular and quick, above that regular."""
    base = [int(m) for m in re.findall(r"\b(?:(?:G|SD|Game)\s*/\s*|Game in\s+)(\d{1,3})\b", time_control, re.I)]
    base += [int(m) for n, m in re.findall(r"\b(\d{2})\s*/\s*(\d{2,3})\b", time_control) if int(n) >= 20]
    if not base:
        return None
    added = [int(s) for s in re.findall(r"(?:\+\s*|\binc(?:rement)?\.?\s*|\bd(?:elay)?\s*/?\s*)(\d{1,2})\b",
                                        time_control, re.I)]
    added += [int(s) for s in re.findall(r"\b(\d{1,2})\s*(?:s|sec|seconds?)\.?\s+(?:inc|delay)", time_control, re.I)]
    total = max(base) + max(added, default=0)
    if total < 5:
        return None
    return "blitz" if total <= 10 else "quick" if total < 30 else "regular,quick" if total <= 65 else "regular"


def schedule(round_times, time_control, first, last):
    """(first round, likely finish) from a listing, or None to keep the event all-day.
    See Start and end times in docs/events/weekend-tournaments.md."""
    starts = round_starts(round_times, first, last)
    minutes = game_minutes(time_control)
    if not starts or minutes is None:
        return None
    start, last_round = min(starts), max(starts)
    if start.date() != first or last_round.date() != last:
        return None
    end = last_round + timedelta(minutes=-(-minutes // 15) * 15)
    return start, end


def same_name(a, b):
    def squash(title):
        return re.sub(r"[^a-z0-9]", "", title.lower().replace("denver chess club", ""))
    a, b = squash(a), squash(b)
    return a in b or b in a


class Rows(HTMLParser):
    """The association's listing: one <tr class="tournament-row"> per tournament, its fields in data- attributes."""

    def __init__(self):
        super().__init__()
        self.rows = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "tr" and "tournament-row" in (attrs.get("class") or ""):
            self.rows.append({k.removeprefix("data-"): html.unescape(v or "") for k, v in attrs.items()})


def csca_tournaments():
    parser = Rows()
    parser.feed(fetch(CSCA_PAGE).decode("utf-8", "replace"))
    if not parser.rows:
        sys.exit(f"No tournaments found on {CSCA_PAGE}. Has the page changed? Nothing was changed.")
    found = []
    for row in parser.rows:
        first, last = parse_dates(row["date"])
        if not weekend(first, last):
            continue
        post = json.loads(fetch(CSCA_POST.format(row["id"])))
        listing = " ".join(row.values())
        found.append({
            "key": f"csca-{row['id']}",
            "title": row["title"].strip(),
            "first": first, "last": last,
            "schedule": schedule(row["round_times"], row["time_control"], first, last),
            "time_control": " ".join(row["time_control"].split()),
            "speed": speed(row["time_control"]),
            "organizer": DCC if row["title"].startswith(DCC) else row["contact_name"].strip(),
            "site": row["site"].strip().splitlines()[0].strip() if row["site"].strip() else "",
            "city": row["city"].strip().removesuffix(", CO").removesuffix(", Colorado"),
            "link": post["link"],
            "rated": "yes" if re.search(r"\bUSCF\b|\bUS Chess\b", listing) else "no",
            "cost": "paid" if "$" in row["entry_fee"] else "unknown",
        })
    return found


def dcc_tournaments():
    page = fetch(f"{DCC_SITE}/tournaments/upcoming").decode("utf-8", "replace")
    upcoming = page.split("Completed Tournaments")[0]
    headings = list(re.finditer(rf"<h3>\s*({MONTHS}), (\d{{4}})\s*</h3>", upcoming))
    if not headings:
        sys.exit(f"No months found on {DCC_SITE}/tournaments/upcoming. Has the page changed? Nothing was changed.")
    found = []
    for heading, following in zip(headings, headings[1:] + [None]):
        block = upcoming[heading.end():following.start() if following else len(upcoming)]
        for path, title, when in re.findall(r'<a href="(/tournaments/upcoming/\d+)">\s*(.*?)\s*<small>(.*?)</small>',
                                            block, re.S):
            first, last = parse_dates(html.unescape(when), int(heading.group(2)))
            if weekend(first, last):
                found.append({"key": f"dcc-{first}", "title": html.unescape(title).strip(), "first": first,
                              "last": last, "schedule": None, "time_control": "", "speed": None, "organizer": DCC, "site": "", "city": "Denver",
                              "link": DCC_SITE + path, "rated": "yes", "cost": "paid"})
    return found


def times(t):
    """Start and end from the round times, else all day. The unused field is None, so a patch can switch kinds."""
    if t["schedule"]:
        return {k: {"dateTime": when.isoformat(), "timeZone": str(TZ), "date": None}
                for k, when in zip(("start", "end"), t["schedule"])}
    return {"start": {"date": t["first"].isoformat(), "dateTime": None, "timeZone": None},
            "end": {"date": (t["last"] + timedelta(days=1)).isoformat(), "dateTime": None, "timeZone": None}}


def event_body(t):
    location = t["site"] or t["city"]
    if t["city"] and t["city"] not in location:
        location += f", {t['city']}"
    location += ", CO" if not re.search(r",\s*(CO|Colorado)\b", location) else ""
    # The listings' fee text is free-form and often long, so the description points to it.
    cost = "entry fee; amounts on the tournament page" if t["cost"] == "paid" else "not listed; see the tournament page"
    name, _, address = location.partition(", ")
    place = f"{name}\n{address}" if address.count(",") >= 1 else location
    time_control = f"\nTime control: {t['time_control']}" if t["time_control"] else ""
    description = (f"Cost: {cost}.{time_control}\n\n{t['title']}, a weekend chess tournament.\n\n"
                   f"Run by {t['organizer']}. Not organized by the Larimer County Chess Club.\n\n"
                   f"Details and registration: {t['link']}\n\n{place}")
    return {
        "summary": t["title"],
        "location": location,
        "description": description,
        **times(t),
        "extendedProperties": {"private": {
            "source": SOURCE, "key": t["key"],
            "organizer": t["organizer"], "format": "tournament", "ages": "all", "rated": t["rated"],
            "cost": t["cost"], "details": t["link"], "run_by": "hide",
            **({"speed": t["speed"]} if t["speed"] else {}),
        }},
    }


def ours(cal):
    items, token = [], None
    while True:
        page = cal.events().list(calendarId=CALENDAR, privateExtendedProperty=f"source={SOURCE}", singleEvents=True,
                                 timeMin=datetime.now(TZ).isoformat(), pageToken=token).execute()
        items += page.get("items", [])
        token = page.get("nextPageToken")
        if not token:
            return items


def differences(event, body):
    changed = [k for k in ("summary", "location", "description") if event.get(k, "") != body[k]]
    changed += [k for k in ("start", "end")
                if (event[k].get("date"), event[k].get("dateTime")) != (body[k]["date"], body[k]["dateTime"])]
    current = event.get("extendedProperties", {}).get("private", {})
    changed += [k for k, v in body["extendedProperties"]["private"].items() if current.get(k) != v]
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="print changes without making them")
    args = parser.parse_args()

    today = datetime.now(TZ).date()
    csca = csca_tournaments()
    dcc = []
    for d in dcc_tournaments():
        listed = [c for c in csca if c["first"] == d["first"] and same_name(c["title"], d["title"])]
        for c in listed:
            c["organizer"] = DCC
        if not listed:
            dcc.append(d)
    wanted = {t["key"]: t for t in csca + dcc if t["last"] >= today}

    cal = build("calendar", "v3", credentials=credentials("calendar"), cache_discovery=False)
    existing = {}
    for e in ours(cal):
        key = e["extendedProperties"]["private"].get("key")
        if key in existing:
            sys.exit(f"Two events on the club calendar have source={SOURCE} key={key}; delete one by hand.")
        existing[key] = e

    changes = 0

    def act(message, apply):
        nonlocal changes
        changes += 1
        print(message)
        if not args.dry_run:
            apply()

    for key, t in sorted(wanted.items(), key=lambda kv: kv[1]["first"]):
        body = event_body(t)
        label = f"{t['first']} {t['title']}"
        if key not in existing:
            act(f"add {label} ({t['city']}, run by {t['organizer']})",
                lambda body=body: cal.events().insert(calendarId=CALENDAR, body=body).execute())
        elif changed := differences(existing[key], body):
            act(f"update {label}: {', '.join(changed)}",
                lambda e=existing[key], body=body: cal.events().patch(calendarId=CALENDAR, eventId=e["id"],
                                                                      body=body).execute())
    for key, e in existing.items():
        start = date.fromisoformat(e["start"].get("date") or e["start"]["dateTime"][:10])
        if key not in wanted and start > today:
            act(f"delete {start} {e.get('summary')}: no longer listed",
                lambda e=e: cal.events().delete(calendarId=CALENDAR, eventId=e["id"]).execute())

    print(f"{datetime.now(TZ):%Y-%m-%d %H:%M}: {len(wanted)} upcoming weekend tournaments, {changes} change(s)"
          + (" (dry run)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
