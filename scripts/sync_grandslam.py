#!/usr/bin/env python3
"""Keep the club's Sac'n Saturdays event in step with Grand Slam's second-Saturday chess events.

    ~/.local/share/lccc/venv/bin/python scripts/sync_grandslam.py [--dry-run]

The club event is our own repeating event, with our title, location and description;
this script only changes the time of single dates, or cancels and restores them, to
match the chess events on Grand Slam's public "FoCo Events" calendar. It finds our
event by the private property source=grandslam. See docs/events/sacn-saturdays.md.
"""
import argparse
import sys
from datetime import date, datetime, timedelta, timezone

from googleapiclient.discovery import build

from google_auth import credentials

SOURCE = "ab4dab9030bf2f0a340655565d7cdb93b262dd03c7f426429e6b8c58a116d039@group.calendar.google.com"
CLUB = "c_69fbe5a4899819d06515e28a5d5161b3508e9cabad74961ce27e36cc94d66f67@group.calendar.google.com"
TAG = "grandslam"
DAYS_AHEAD = 180


def list_all(request_fn, **kwargs):
    items, token = [], None
    while True:
        page = request_fn(pageToken=token, **kwargs).execute()
        items += page.get("items", [])
        token = page.get("nextPageToken")
        if not token:
            return items


def start_day(times):
    return date.fromisoformat((times.get("dateTime") or times["date"])[:10])


def is_second_saturday(day):
    return day.weekday() == 5 and 8 <= day.day <= 14


def same_time(a, b):
    return all(a[k].get("dateTime") == b[k].get("dateTime") for k in ("start", "end"))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="print changes without making them")
    args = parser.parse_args()

    cal = build("calendar", "v3", credentials=credentials("calendar"), cache_discovery=False)
    now = datetime.now(timezone.utc)
    window = {"timeMin": now.isoformat(), "timeMax": (now + timedelta(days=DAYS_AHEAD)).isoformat()}

    masters = list_all(cal.events().list, calendarId=CLUB, privateExtendedProperty=f"source={TAG}")
    masters = [m for m in masters if m.get("recurrence") and m.get("status") != "cancelled"]
    if len(masters) != 1:
        sys.exit(f"Expected one repeating club event tagged source={TAG}, found {len(masters)}")
    master = masters[0]

    theirs = {}
    for e in list_all(cal.events().list, calendarId=SOURCE, singleEvents=True, **window):
        day = start_day(e["start"])
        if "chess" in e.get("summary", "").lower() and e.get("status") != "cancelled" and is_second_saturday(day):
            theirs[day] = e
    ours = {
        start_day(i["originalStartTime"]): i
        for i in list_all(cal.events().instances, calendarId=CLUB, eventId=master["id"], showDeleted=True, **window)
    }

    changes = 0

    def change(message, instance, body):
        nonlocal changes
        changes += 1
        print(message)
        if not args.dry_run:
            cal.events().patch(calendarId=CLUB, eventId=instance["id"], body=body).execute()

    for day in sorted(set(theirs) | set(ours)):
        source, instance = theirs.get(day), ours.get(day)
        if instance is None:
            print(f"warning {day}: Grand Slam has chess but our event has no date here; add it by hand")
        elif source is None:
            if instance.get("status") != "cancelled":
                change(f"cancel {day}: no chess on Grand Slam's calendar", instance, {"status": "cancelled"})
        else:
            times = {"start": source["start"], "end": source["end"]}
            if instance.get("status") == "cancelled":
                change(f"restore {day}: back on Grand Slam's calendar", instance, {"status": "confirmed", **times})
            elif not same_time(instance, source):
                start, end = source["start"]["dateTime"][11:16], source["end"]["dateTime"][11:16]
                change(f"retime {day}: {start}–{end} to match Grand Slam", instance, times)

    print(f"{now:%Y-%m-%d %H:%M}Z: {len(theirs)} Grand Slam second-Saturday chess dates, {changes} change(s)"
          + (" (dry run)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
