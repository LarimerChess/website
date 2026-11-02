"""Keep managed club Calendar events in sync with event-descriptions.json.

The docs repo exports only the public description and calendar metadata from
selected event pages. Update calendar runs this before importing the calendars.
Use --dry-run to check the source and report differences without writing.
"""
import argparse
import json
import re
from datetime import datetime
from pathlib import Path

from update_calendar import CALENDARS, FIELDS, TZ, problems, series_page

ROOT = Path(__file__).resolve().parents[1]


def read_source(path):
    records = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(records, list):
        raise ValueError("The event description source must be a list.")
    seen = set()
    for record in records:
        fields = {"calendar", "event_id", "title", "description", "metadata"}
        if not isinstance(record, dict) or set(record) != fields:
            raise ValueError("Each source event needs its calendar, ID, title, description, and metadata.")
        if any(not isinstance(record[key], str) or not record[key].strip()
               for key in fields - {"metadata"}):
            raise ValueError("Event descriptions and identifiers must be nonempty strings.")
        if record["calendar"] not in CALENDARS:
            raise ValueError("Unknown calendar in the description source.")
        metadata = record["metadata"]
        if not isinstance(metadata, dict) or any(not isinstance(value, str) for value in metadata.values()):
            raise ValueError("Calendar metadata must be an object of strings.")
        if set(metadata) - set(FIELDS) or problems(metadata):
            raise ValueError("Invalid website metadata in the event description source.")
        target = record["calendar"], record["event_id"]
        if target in seen:
            raise ValueError("Duplicate event in the description source.")
        seen.add(target)
    return records


def plan(service, records):
    plans = []
    for record in records:
        calendar_id = CALENDARS[record["calendar"]]
        event = service.events().get(calendarId=calendar_id, eventId=record["event_id"]).execute()
        if event.get("summary") != record["title"] or event.get("status") == "cancelled":
            raise ValueError("A managed event's title or status differs; inspect it before syncing.")
        body = {}
        if event.get("description", "") != record["description"]:
            body["description"] = record["description"]
        current = event.get("extendedProperties", {}).get("private", {})
        changed = {key: record["metadata"].get(key) for key in FIELDS
                   if current.get(key) != record["metadata"].get(key)}
        if changed:
            body["extendedProperties"] = {"private": changed}
        if body and not event.get("etag"):
            raise ValueError("A managed event has no revision to check; nothing changed.")
        plans.append((record, event, body))
    return plans


def sync(service, records, dry_run=False):
    plans = plan(service, records)
    changed = 0
    for record, event, body in plans:
        if body and not dry_run:
            request = service.events().patch(calendarId=CALENDARS[record["calendar"]],
                                             eventId=record["event_id"], body=body)
            request.headers["If-Match"] = event["etag"]
            request.execute()
        if body:
            changed += 1
        if not dry_run:
            verified = service.events().get(calendarId=CALENDARS[record["calendar"]],
                                             eventId=record["event_id"]).execute()
            current = verified.get("extendedProperties", {}).get("private", {})
            if (verified.get("description", "") != record["description"]
                    or any(current.get(key) != record["metadata"].get(key) for key in FIELDS)):
                raise ValueError("Calendar read-back differs from the source; inspect before retrying.")
        print(f"{'preview' if dry_run else 'verified'}: {record['title']}")
    return changed


def check_saved_controls(db, records, today):
    from firebase_db import decode_row

    controls = {}
    for record in records:
        match = re.search(r"^Time control: (G/\d+;(?:\+|d)\d+)\b", record["description"], re.M)
        if match and record["metadata"].get("rated") == "yes":
            event = series_page(record["title"]).strip("/").split("/")[-1]
            controls[event] = match[1]
    selected, pending = [], []
    for stored in (db.get("tables/Tournaments") or {}).values():
        row = decode_row(stored)
        event, separator, when = row.get("Key", "").partition("/")
        if event not in controls or not separator:
            continue
        if len(when) == 7:
            applies = when >= today.strftime("%Y-%m")
        else:
            applies = when >= today.isoformat()
        if not applies:
            continue
        selected.append(row["Key"])
        if row.get("Time control", "") != controls[event]:
            pending.append(row["Key"])
    if pending:
        raise ValueError("Saved time controls differ from the listing; inspect played games before changing: "
                         + ", ".join(pending))
    print(f"verified: {len(selected)} current or future saved tournament(s); no different time control")
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, default=ROOT / "event-descriptions.json")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check-tournaments", action="store_true")
    args = parser.parse_args()

    if args.check_tournaments:
        from firebase_db import connect
        try:
            check_saved_controls(connect(), read_source(args.source), datetime.now(TZ).date())
        except (ValueError, OSError) as error:
            parser.exit(1, f"{error}\n")
        return
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    from google_auth import credentials

    try:
        records = read_source(args.source)
        service = build("calendar", "v3", credentials=credentials("calendar"), cache_discovery=False)
        changed = sync(service, records, args.dry_run)
        print(f"{changed} managed event(s) {'would change' if args.dry_run else 'changed'}")
    except (ValueError, OSError) as error:
        parser.exit(1, f"{error}\n")
    except HttpError as error:
        parser.exit(1, f"Calendar API returned HTTP {error.resp.status}; inspect before retrying.\n")


if __name__ == "__main__":
    main()
