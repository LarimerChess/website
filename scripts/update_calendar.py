"""Write the club calendar's upcoming events to events.json for the home page."""

import json
import sys
import urllib.request
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import icalendar
import recurring_ical_events

FEED = (
    "https://calendar.google.com/calendar/ical/"
    "c_69fbe5a4899819d06515e28a5d5161b3508e9cabad74961ce27e36cc94d66f67"
    "%40group.calendar.google.com/public/basic.ics"
)
TZ = ZoneInfo("America/Denver")
DAYS_AHEAD = 60


def as_datetime(value):
    if isinstance(value, datetime):
        return value.astimezone(TZ)
    return datetime.combine(value, datetime.min.time(), TZ)


def main(out_path):
    with urllib.request.urlopen(FEED, timeout=30) as response:
        calendar = icalendar.Calendar.from_ical(response.read())

    today = datetime.now(TZ).date()
    window = recurring_ical_events.of(calendar).between(today, today + timedelta(days=DAYS_AHEAD))

    events = []
    for event in window:
        start = event["DTSTART"].dt
        end = event["DTEND"].dt if "DTEND" in event else start
        events.append({
            "title": str(event.get("SUMMARY", "")),
            "start": as_datetime(start).isoformat(),
            "end": as_datetime(end).isoformat(),
            "allDay": not isinstance(start, datetime),
            "location": str(event.get("LOCATION", "")),
        })
    events.sort(key=lambda e: e["start"])

    with open(out_path, "w") as f:
        json.dump(events, f, indent=1, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "events.json")
