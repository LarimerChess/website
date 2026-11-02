"""Replace one event's exact Time control line through the club's Calendar API.

Run with --calendar club|community, --event-id, --expected-line, and
--replacement-line. --dry-run reads and checks the event without changing it.
The Update event time control Action supplies LCCC_GOOGLE_CALENDAR_TOKEN as
LCCC_GOOGLE_TOKEN; configured local hosts can use their calendar token instead.
"""
import argparse

from update_calendar import CALENDARS


def replace_line(description, expected, replacement):
    for line in (expected, replacement):
        if (not line.startswith("Time control: ") or not line.removeprefix("Time control: ").strip()
                or "\n" in line or "\r" in line):
            raise ValueError("Supply a single complete Time control: line.")
    lines = description.splitlines(keepends=True)
    old = [i for i, line in enumerate(lines) if line.rstrip("\r\n") == expected]
    new = [i for i, line in enumerate(lines) if line.rstrip("\r\n") == replacement]
    controls = [line for line in lines if line.startswith("Time control: ")]
    if len(controls) != 1:
        raise ValueError("Expected exactly one Time control: line; nothing changed.")
    if len(new) == 1:
        return description
    if len(old) != 1:
        raise ValueError("The expected time control does not match the live event; nothing changed.")
    index = old[0]
    ending = lines[index][len(lines[index].rstrip("\r\n")):]
    lines[index] = replacement + ending
    return "".join(lines)


def update_event(service, calendar, event_id, expected, replacement, dry_run=False):
    events = service.events()
    calendar_id = CALENDARS[calendar]
    event = events.get(calendarId=calendar_id, eventId=event_id).execute()
    wanted = replace_line(event.get("description", ""), expected, replacement)
    if wanted == event.get("description", ""):
        return "same: the event already has the requested time control"
    if dry_run:
        return "preview: the expected line matches; only the Time control line would change"
    if not event.get("etag"):
        raise ValueError("The event has no revision to check; nothing changed.")
    request = events.patch(calendarId=calendar_id, eventId=event_id, body={"description": wanted})
    request.headers["If-Match"] = event["etag"]
    request.execute()
    verified = events.get(calendarId=calendar_id, eventId=event_id).execute()
    if verified.get("description") != wanted:
        raise ValueError("The write was sent, but read-back differs; inspect the event before retrying.")
    return "updated: the API read-back confirms the new time control"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--calendar", choices=CALENDARS, required=True)
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--expected-line", required=True)
    parser.add_argument("--replacement-line", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    from google_auth import credentials

    try:
        service = build("calendar", "v3", credentials=credentials("calendar"), cache_discovery=False)
        print(update_event(service, args.calendar, args.event_id, args.expected_line,
                           args.replacement_line, args.dry_run))
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    except HttpError as error:
        parser.exit(1, f"Calendar API returned HTTP {error.resp.status}; inspect the event before retrying.\n")


if __name__ == "__main__":
    main()
