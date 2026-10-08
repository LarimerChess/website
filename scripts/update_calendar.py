"""Write upcoming events from the club and community calendars to events.json.

The home page shows the club calendar's events; events/ shows both, filterable by
the tags assigned here.
"""

import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import icalendar
import recurring_ical_events

FEEDS = {
    "club": "c_69fbe5a4899819d06515e28a5d5161b3508e9cabad74961ce27e36cc94d66f67",
    "community": "c_dd8c6af0ee77c40a94474c178d25b280f0f4816c5f8b1c59fe064e2c6c92bb1f",
}
FEED_URL = "https://calendar.google.com/calendar/ical/{}%40group.calendar.google.com/public/basic.ics"
TZ = ZoneInfo("America/Denver")
DAYS_AHEAD = 90
CLUB = "Larimer County Chess Club"

# (pattern in title, organizer); first match wins, and club calendar events default to CLUB.
ORGANIZERS = [
    (r"grand slam", "Grand Slam Games and Comics"),
    (r"chessmates", "Chessmates"),
    (r"purpose brewing|wednesday night chess", "Fort Collins Chess Meetup"),
    (r"loveland public library", "Loveland Public Library"),
    (r"chilson", "Chilson Senior Center"),
]
# (tag, pattern in title)
TITLE_TAGS = [
    ("tournament", r"tournament|classic|slow|arena|sac.n saturdays"),
    ("casual", r"club night|night chess|drop-in"),
    ("youth", r"k.12|scholastic|grades? \d|elementary|kids"),
    ("senior", r"55\+|senior"),
]
ADULTS_ONLY = re.compile(r"\b(?:18|21)\+|adults? only", re.I)
RATED = re.compile(r"\b(?:dual|regular|quick|us chess) rated\b", re.I)
LINK = re.compile(r"https?://[^\s<>\"]+")
FEE = re.compile(r"Entry fee: \$(\d+(?:\.\d\d)?)")
# "Cost: free" marks an event free for everyone; a sentence saying youth or under-18 players
# play free marks it free for youth.
FREE = re.compile(r"\bcost: free\b", re.I)
# A dollar amount or a mention of a fee means the event charges; with no sign either way, its cost is unknown.
CHARGES = re.compile(r"\$\d|\bentry fee\b|\bcharges?\b", re.I)
FREE_FOR_YOUTH = re.compile(r"(?:youth|under 18)[^.\n]*\bfree\b|\bfree\b[^.\n]*(?:youth|under 18)", re.I)
ADDRESS = re.compile(r"^(?P<name>[^,]+), (?P<street>[^,]+(?:, Unit [^,]+)?), (?P<city>[^,]+), (?P<region>[A-Z]{2}) (?P<zip>\d{5})")


def as_datetime(value):
    if isinstance(value, datetime):
        return value.astimezone(TZ)
    return datetime.combine(value, datetime.min.time(), TZ)


def describe(event, calendar):
    title = str(event.get("SUMMARY", ""))
    text = str(event.get("DESCRIPTION", ""))
    organizer = next((name for pattern, name in ORGANIZERS if re.search(pattern, title, re.I)),
                     CLUB if calendar == "club" else "")
    tags = [tag for tag, pattern in TITLE_TAGS if re.search(pattern, title, re.I)]
    if "youth" not in tags and "senior" not in tags and not ADULTS_ONLY.search(title):
        tags.append("all-ages")  # youth, senior and adults-only events have age limits
    if organizer == CLUB:
        tags += ["club", "rated"]  # every club event is a US Chess rated event
    elif RATED.search(text) and not re.search(r"\bunrated\b", text, re.I):
        tags.append("rated")
    if FREE.search(text):
        tags += ["free", "free-youth"]
    elif FREE_FOR_YOUTH.search(text):
        tags.append("free-youth")
    elif not CHARGES.search(text):
        tags.append("cost-unknown")
    links = [u for u in LINK.findall(text) if not re.search(r"calendar\.google|uschess|maps", u)]
    fee = FEE.search(text)
    return {
        "title": title,
        "calendar": calendar,
        "organizer": organizer,
        "tags": tags,
        # Only the community calendar's events link out; their pages have real details.
        "url": links[0] if calendar == "community" and links else "",
        "price": fee.group(1) if fee else "",
    }


def place(location):
    match = ADDRESS.match(location)
    return match.groupdict() if match else {}


def city(location):
    match = ADDRESS.match(location) or re.search(r",\s*(?P<city>[^,]+),\s*(?:CO|Colorado)\b", location)
    return match.group("city").strip() if match else ""


def tag_weekly(events):
    """Tag events that repeat at least three times, usually a week apart or less.

    Gaps are counted in calendar days, so a daylight saving change doesn't stretch a week,
    and the median gap is used, so a skipped holiday week doesn't disqualify an event.
    """
    days = {}
    for e in events:
        days.setdefault(e["title"], set()).add(datetime.fromisoformat(e["start"]).date())
    weekly = set()
    for title, dates in days.items():
        dates = sorted(dates)
        gaps = sorted((b - a).days for a, b in zip(dates, dates[1:]))
        if len(dates) >= 3 and gaps[len(gaps) // 2] <= 7:
            weekly.add(title)
    for e in events:
        if e["title"] in weekly:
            e["tags"].append("weekly")


def main(out_path):
    today = datetime.now(TZ).date()
    events = []
    for calendar, calendar_id in FEEDS.items():
        with urllib.request.urlopen(FEED_URL.format(calendar_id), timeout=30) as response:
            feed = icalendar.Calendar.from_ical(response.read())
        for event in recurring_ical_events.of(feed).between(today, today + timedelta(days=DAYS_AHEAD)):
            start = event["DTSTART"].dt
            end = event["DTEND"].dt if "DTEND" in event else start
            events.append({
                **describe(event, calendar),
                "start": as_datetime(start).isoformat(),
                "end": as_datetime(end).isoformat(),
                "allDay": not isinstance(start, datetime),
                "location": str(event.get("LOCATION", "")),
                "place": place(str(event.get("LOCATION", ""))),
                "city": city(str(event.get("LOCATION", ""))),
            })
    events.sort(key=lambda e: (e["start"], e["title"]))
    tag_weekly(events)

    with open(out_path, "w") as f:
        json.dump(events, f, indent=1, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "events.json")
