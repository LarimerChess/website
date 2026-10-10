"""Write upcoming events from the club and community calendars to events.json.

The home page shows the club calendar's events; events/ shows both, filterable by
tags made from each event's metadata: private extended properties set on the
Google Calendar event (FIELDS below). An event whose metadata is missing or invalid
stops the import, so nothing is guessed and events.json is left as it was.

Google leaves extended properties out of a calendar's public iCal feed, so this
reads the Calendar API with an OAuth token whose JSON is in LCCC_GOOGLE_TOKEN.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

CALENDARS = {
    "club": "c_69fbe5a4899819d06515e28a5d5161b3508e9cabad74961ce27e36cc94d66f67@group.calendar.google.com",
    "community": "c_dd8c6af0ee77c40a94474c178d25b280f0f4816c5f8b1c59fe064e2c6c92bb1f@group.calendar.google.com",
}
EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/{}/events"
TZ = ZoneInfo("America/Denver")
DAYS_AHEAD = 90
CLUB = "Larimer County Chess Club"

# Each metadata field: (required, allowed values or a pattern the whole value must match).
FIELDS = {
    "organizer": (True, re.compile(r"\S.*")),
    "format": (True, {"tournament", "casual", "other"}),
    "ages": (True, {"all", "youth", "senior", "adults"}),
    "rated": (True, {"yes", "no"}),
    "cost": (True, {"free", "free-youth", "paid", "unknown"}),
    "price": (False, re.compile(r"\d+(?:\.\d\d)?")),
    "details": (False, re.compile(r"https?://\S+")),
    # hide leaves out the card's "Run by" line; the organizer stays in the metadata.
    "run_by": (False, {"show", "hide"}),
    # US Chess's rating categories, comma-separated: base minutes plus increment or delay seconds is
    # blitz from 5 to 10, quick from 11 to 29, both regular and quick (dual) from 30 to 65, regular above.
    "speed": (False, re.compile(r"(?:regular|quick|blitz)(?:,(?:regular|quick|blitz))*")),
    # invitational: a club event only the TD registers players for; its entries and pairings stay public.
    "access": (False, {"open", "invitational"}),
}
AGE_TAGS = {"all": "all-ages", "youth": "youth", "senior": "senior", "adults": "adults"}
COST_TAGS = {"free": "free", "free-youth": "free-youth", "paid": None, "unknown": "cost-unknown"}
ADDRESS = re.compile(r"^(?P<name>[^,]+), (?P<street>[^,]+(?:, Unit [^,]+)?), (?P<city>[^,]+), (?P<region>[A-Z]{2}) (?P<zip>\d{5})")


def problems(meta):
    """What is wrong with an event's metadata, as a list of sentences; empty if nothing."""
    found = []
    for field, (required, allowed) in FIELDS.items():
        value = meta.get(field)
        if value is None:
            if required:
                found.append(f"{field} is missing")
        elif isinstance(allowed, set) and value not in allowed:
            found.append(f"{field} is {value!r}, expected one of {', '.join(sorted(allowed))}")
        elif not isinstance(allowed, set) and not allowed.fullmatch(value):
            found.append(f"{field} is {value!r}, expected {allowed.pattern}")
    if meta.get("organizer") == CLUB and meta.get("rated") == "no":
        found.append("rated is 'no', but every club event is US Chess rated")
    if meta.get("organizer") == CLUB and meta.get("run_by") == "hide":
        found.append("run_by is 'hide', but the site finds club events by their organizer")
    return found


def describe(meta, calendar):
    """The title-independent part of an event's card, from metadata that has no problems."""
    tags = [meta["format"]] if meta["format"] != "other" else []
    tags.append(AGE_TAGS[meta["ages"]])
    if meta["organizer"] == CLUB:
        tags.append("club")
    if meta["rated"] == "yes":
        tags.append("rated")
    if COST_TAGS[meta["cost"]]:
        tags.append(COST_TAGS[meta["cost"]])
    if meta.get("speed"):
        tags += meta["speed"].split(",")
    if meta.get("access") == "invitational":
        tags.append("invitational")
    return {
        "calendar": calendar,
        "organizer": "" if meta.get("run_by") == "hide" else meta["organizer"],
        "tags": tags,
        "url": meta.get("details", ""),
        "price": meta.get("price", ""),
    }


def series_page(title):
    """The path of a club event's own page, which scripts/build_pages.py writes."""
    name = title.removeprefix(CLUB).strip()
    return "/events/" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") + "/"


def as_datetime(times):
    if "dateTime" in times:
        return datetime.fromisoformat(times["dateTime"]).astimezone(TZ)
    return datetime.combine(date.fromisoformat(times["date"]), datetime.min.time(), TZ)


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


def build(items_by_calendar):
    """Turn Calendar API events into the website's events, or exit naming every event with bad metadata."""
    events, bad = [], {}
    for calendar, items in items_by_calendar.items():
        for item in items:
            # The public feed leaves these out; the API, signed in as the owner, doesn't.
            if item.get("status") == "cancelled" or item.get("visibility") in ("private", "confidential"):
                continue
            title = item.get("summary", "")
            start = as_datetime(item["start"])
            meta = item.get("extendedProperties", {}).get("private", {})
            found = problems(meta)
            if found:
                series = item.get("recurringEventId") or title
                bad.setdefault((calendar, series, title, "; ".join(found)), []).append(start.date())
                continue
            location = item.get("location", "")
            events.append({
                "title": title,
                **describe(meta, calendar),
                "page": series_page(title) if meta["organizer"] == CLUB else "",
                "start": start.isoformat(),
                "end": as_datetime(item["end"]).isoformat(),
                "allDay": "date" in item["start"],
                "location": location,
                "place": place(location),
                "city": city(location),
                "description": item.get("description", ""),
            })
    if bad:
        lines = [f"{len(bad)} event(s) on the calendars have missing or invalid metadata; events.json is unchanged."]
        for (calendar, _, title, found), dates in sorted(bad.items(), key=lambda b: min(b[1])):
            when = f"{min(dates)}" + (f" and {len(dates) - 1} more date(s)" if len(dates) > 1 else "")
            lines.append(f"  {calendar} calendar, {title!r} ({when}): {found}")
        lines.append(f"Allowed metadata: {', '.join(FIELDS)}. Set it with the lccc-events runbook's metadata recipe.")
        sys.exit("\n".join(lines))
    events.sort(key=lambda e: (e["start"], e["title"]))
    tag_weekly(events)
    return events


def access_token(raw):
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < start:
        sys.exit("LCCC_GOOGLE_TOKEN has no token JSON in it. Is the repository secret set?")
    token = json.loads(raw[start:end + 1])
    body = urllib.parse.urlencode({
        "client_id": token["client_id"],
        "client_secret": token["client_secret"],
        "refresh_token": token["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    request = urllib.request.Request(token.get("token_uri", "https://oauth2.googleapis.com/token"), data=body)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)["access_token"]
    except urllib.error.HTTPError as error:
        sys.exit(f"Google refused the token in LCCC_GOOGLE_TOKEN ({error.code}: {error.read().decode()[:300]})")


def fetch(calendar_id, token, today):
    items, page = [], None
    while True:
        query = {
            "singleEvents": "true",
            "timeMin": datetime.combine(today, datetime.min.time(), TZ).isoformat(),
            "timeMax": datetime.combine(today + timedelta(days=DAYS_AHEAD), datetime.min.time(), TZ).isoformat(),
            "maxResults": "2500",
            "fields": "nextPageToken,items(status,visibility,summary,description,location,start,end,recurringEventId,extendedProperties)",
        }
        if page:
            query["pageToken"] = page
        url = EVENTS_URL.format(urllib.parse.quote(calendar_id)) + "?" + urllib.parse.urlencode(query)
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
        items += data.get("items", [])
        page = data.get("nextPageToken")
        if not page:
            return items


def main(out_path):
    raw = os.environ.get("LCCC_GOOGLE_TOKEN", "")
    if not raw.strip():
        sys.exit("LCCC_GOOGLE_TOKEN is empty. In Actions it comes from the secret LCCC_GOOGLE_CALENDAR_READ_TOKEN.")
    token = access_token(raw)
    today = datetime.now(TZ).date()
    events = build({calendar: fetch(calendar_id, token, today) for calendar, calendar_id in CALENDARS.items()})
    with open(out_path, "w") as f:
        json.dump(events, f, indent=1, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "events.json")
