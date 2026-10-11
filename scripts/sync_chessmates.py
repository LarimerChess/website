#!/usr/bin/env python3
"""Keep Chessmates' scholastic tournaments on the Chess around Larimer County calendar.

    ~/.local/share/lccc/venv/bin/python scripts/sync_chessmates.py [--dry-run]

Tournament dates are read from Chessmates' tournaments page, which has no calendar
feed. Each upcoming date gets an event with the website metadata in METADATA; our
events for dates they no longer list are deleted, and ones whose metadata or description
differs are corrected. If the page yields no dates at all, nothing is changed. Only events tagged
source=chessmates are touched. See docs/events/community-calendar.md.
"""
import argparse
import re
import sys
import urllib.request
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from googleapiclient.discovery import build

from google_auth import credentials

COMMUNITY = "c_dd8c6af0ee77c40a94474c178d25b280f0f4816c5f8b1c59fe064e2c6c92bb1f@group.calendar.google.com"
TZ = ZoneInfo("America/Denver")
BROWSER = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}

CHESSMATES_PAGE = "https://chessmatesfc.com/tournaments/"
CHESSMATES_EVENT = {
    "summary": "Chessmates Scholastic Tournament (K–12)",
    "location": "CEC High School, 4424 Innovation Dr, Fort Collins, CO 80525",
    "description": (
        "Cost: $30 entry (fall or spring bundles available).\n\n"
        "Chessmates scholastic tournament for students in kindergarten through 12th grade. Five rounds of about an "
        "hour each, in sections by grade level or US Chess rating (800+). Check-in from 8:15 AM; round 1 starts at "
        "9:00 AM sharp; done by about 2:00 PM, with an optional awards ceremony.\n\n"
        "The section for players rated 800 and above is US Chess rated and needs a current US Chess ID; "
        "grade-level sections don't need a US Chess membership.\n\n"
        "Register by the Friday before; day-of registration closes at 8:30 AM and may start with a round-one bye.\n\n"
        "Run by Chessmates. Not organized by the Larimer County Chess Club.\n\n"
        f"Details and registration: {CHESSMATES_PAGE}\n\n"
        "CEC High School\n4424 Innovation Dr, Fort Collins, CO 80525"
    ),
}
METADATA = {"organizer": "Chessmates", "format": "tournament", "ages": "youth", "rated": "yes", "cost": "paid",
            "details": CHESSMATES_PAGE}
MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"

def fetch(url):
    request = urllib.request.Request(url, headers=BROWSER)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def tagged(cal, source):
    items, token = [], None
    while True:
        page = cal.events().list(calendarId=COMMUNITY, privateExtendedProperty=f"source={source}",
                                 singleEvents=True, pageToken=token,
                                 timeMin=datetime.now(timezone.utc).isoformat()).execute()
        items += page.get("items", [])
        token = page.get("nextPageToken")
        if not token:
            return items


def chessmates_dates(today):
    html = fetch(CHESSMATES_PAGE).decode("utf-8", "replace")
    found = set()
    for month, day, year in re.findall(rf"({MONTHS}) (\d{{1,2}})(?:st|nd|rd|th)?,? (20\d\d)", html):
        found.add(datetime.strptime(f"{month} {day} {year}", "%B %d %Y").date())
    if not found:
        sys.exit(f"No dates found on {CHESSMATES_PAGE}. Has the page changed? Nothing was changed.")
    return {d for d in found if d >= today}


def sync_chessmates(cal, today, act):
    dates = chessmates_dates(today)
    ours = {date.fromisoformat(e["extendedProperties"]["private"]["date"]): e for e in tagged(cal, "chessmates")}
    for day in sorted(dates - ours.keys()):
        act(f"chessmates: add {day}", lambda day=day: cal.events().insert(calendarId=COMMUNITY, body={
            **CHESSMATES_EVENT,
            "start": {"dateTime": f"{day}T08:15:00", "timeZone": "America/Denver"},
            "end": {"dateTime": f"{day}T14:00:00", "timeZone": "America/Denver"},
            "extendedProperties": {"private": {"source": "chessmates", "date": day.isoformat(), **METADATA}},
        }).execute())
    for day in sorted(dates & ours.keys()):
        current = ours[day]["extendedProperties"]["private"]
        diff = {k: v for k, v in METADATA.items() if current.get(k) != v}
        if diff:
            act(f"chessmates: correct metadata {day}: {', '.join(diff)}",
                lambda e=ours[day], diff=diff: cal.events().patch(calendarId=COMMUNITY, eventId=e["id"], body={
                    "extendedProperties": {"private": diff}}).execute())
        if ours[day].get("description") != CHESSMATES_EVENT["description"]:
            act(f"chessmates: correct description {day}",
                lambda e=ours[day]: cal.events().patch(calendarId=COMMUNITY, eventId=e["id"], body={
                    "description": CHESSMATES_EVENT["description"]}).execute())
    for day in sorted(ours.keys() - dates):
        act(f"chessmates: delete {day}, no longer on their page",
            lambda e=ours[day]: cal.events().delete(calendarId=COMMUNITY, eventId=e["id"]).execute())
    return len(dates)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="print changes without making them")
    args = parser.parse_args()

    cal = build("calendar", "v3", credentials=credentials("calendar"), cache_discovery=False)
    now = datetime.now(TZ)
    changes = 0

    def act(message, apply):
        nonlocal changes
        changes += 1
        print(message)
        if not args.dry_run:
            apply()

    tournaments = sync_chessmates(cal, now.date(), act)
    print(f"{now:%Y-%m-%d %H:%M}: {tournaments} upcoming Chessmates dates, {changes} change(s)"
          + (" (dry run)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
