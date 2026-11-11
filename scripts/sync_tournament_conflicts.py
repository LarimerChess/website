"""Cancel club tournament dates on Colorado tournament weekends and restore dates we cancelled.

A private, past Calendar event stores the cancellation receipts. Cancelled events
can be returned as tombstones without their metadata, title, or times, so receipts
must live separately from the events being cancelled.
"""
import copy
import hashlib
import json
from datetime import datetime, timedelta

from googleapiclient.errors import HttpError

from update_calendar import CALENDARS, CLUB, TZ, as_datetime

CALENDAR = CALENDARS["club"]
STATE_ID = hashlib.sha256(b"lccc-weekend-tournament-conflicts-v1").hexdigest()
DAYS_AHEAD = 180
SNAPSHOT_FIELDS = ("summary", "description", "location", "start", "end", "visibility",
                   "transparency", "extendedProperties", "reminders", "colorId")


def weekends(tournament):
    """Saturdays identifying tournament weekends, excluding explicitly weekday-only schedules."""
    named = set(tournament.get("weekdays", []))
    days = set()
    for offset in range((tournament["last"] - tournament["first"]).days + 1):
        day = tournament["first"] + timedelta(days=offset)
        if day.weekday() >= 5 and (not named or day.weekday() in named):
            days.add(day - timedelta(days=day.weekday() - 5))
    return days


def blockers(event, tournaments):
    start, end = as_datetime(event["start"]), as_datetime(event["end"])
    last = (end - timedelta(microseconds=1)).date()
    club_weekends = set()
    for offset in range((last - start.date()).days + 1):
        day = start.date() + timedelta(days=offset)
        if day.weekday() >= 5:
            club_weekends.add(day - timedelta(days=day.weekday() - 5))
    return sorted(t["key"] for t in tournaments if club_weekends & weekends(t))


def get_event(service, event_id):
    try:
        return service.events().get(calendarId=CALENDAR, eventId=event_id).execute()
    except HttpError as error:
        if error.resp.status in (404, 410):
            return None
        raise


def patch(service, event, body):
    if not event.get("etag"):
        raise ValueError("Calendar event has no revision; nothing was changed.")
    request = service.events().patch(calendarId=CALENDAR, eventId=event["id"], body=body)
    request.headers["If-Match"] = event["etag"]
    request.execute()
    verified = get_event(service, event["id"])
    if not verified or any(verified.get(k) != v for k, v in body.items()):
        raise ValueError("Calendar read-back differs after a conflict update; inspect before retrying.")
    return verified


def fresh_revision(service, event):
    """Accept revision-only changes from sibling occurrences, never changes to event details."""
    current = get_event(service, event["id"])
    fields = SNAPSHOT_FIELDS + ("status", "originalStartTime", "recurringEventId")
    if not current or any(current.get(key) != event.get(key) for key in fields):
        raise ValueError("Calendar event changed during conflict reconciliation; retry after inspection.")
    return current


def sync_conflicts(service, tournaments, dry_run=False, now=None):
    now = now or datetime.now(TZ)
    until = now + timedelta(days=DAYS_AHEAD)
    state_event = get_event(service, STATE_ID)
    if state_event:
        if (state_event.get("visibility") != "private" or state_event.get("status") == "cancelled"
                or state_event.get("extendedProperties", {}).get("private", {}).get("source") != "weekend-conflicts"):
            raise ValueError("Weekend conflict state event is invalid; nothing was changed.")
        state = json.loads(state_event["description"])
    else:
        state = {"version": 1, "cancelled": {}}
    if state.get("version") != 1 or not isinstance(state.get("cancelled"), dict):
        raise ValueError("Unknown weekend conflict state; nothing was changed.")
    receipts = state["cancelled"]
    # Validate all receipts before planning any writes.
    for receipt in receipts.values():
        if receipt["phase"] not in {"pending", "cancelled"}:
            raise ValueError("Unknown cancellation phase; nothing was changed.")
        as_datetime(receipt["event"]["start"])
        as_datetime(receipt["event"]["end"])

    candidates, token = {}, None
    while True:
        page = service.events().list(calendarId=CALENDAR, singleEvents=True,
                                     timeMin=now.isoformat(), timeMax=until.isoformat(),
                                     pageToken=token).execute()
        for event in page.get("items", []):
            meta = event.get("extendedProperties", {}).get("private", {})
            if (event.get("status") != "cancelled" and meta.get("organizer") == CLUB
                    and meta.get("format") == "tournament" and event.get("visibility") not in {"private", "confidential"}
                    and as_datetime(event["start"]) > now):
                candidates[event["id"]] = event
        token = page.get("nextPageToken")
        if not token:
            break

    plans = []
    for event_id, receipt in list(receipts.items()):
        snapshot = receipt["event"]
        if as_datetime(snapshot["start"]) <= now:
            plans.append(("forget", {"id": event_id}, None, None))
            continue
        event = get_event(service, event_id)
        if not event:
            raise ValueError(f"Cannot read automatically cancelled event {event_id}; inspect before restoring.")
        if event.get("status") != "cancelled":
            plans.append(("forget", event, None, None))
        elif receipt["phase"] == "pending":
            raise ValueError(f"Cancellation of {event_id} was interrupted; inspect before restoring.")
        elif not blockers(snapshot, tournaments):
            plans.append(("restore", event, {**snapshot, "status": "confirmed"}, None))
    for event in candidates.values():
        conflicts = blockers(event, tournaments)
        if conflicts:
            snapshot = {key: copy.deepcopy(event[key]) for key in SNAPSHOT_FIELDS if key in event}
            plans.append(("cancel", event, {"status": "cancelled"},
                          {"phase": "pending", "event": snapshot, "conflicts": conflicts}))
    for action, event, _, _ in plans:
        if action != "forget" and not event.get("etag"):
            raise ValueError("Calendar event has no revision; nothing was changed.")
    if state_event and plans and not state_event.get("etag"):
        raise ValueError("Conflict state has no revision; nothing was changed.")

    def save():
        nonlocal state_event
        description = json.dumps(state, ensure_ascii=False, sort_keys=True)
        if state_event:
            state_event = patch(service, state_event, {"description": description})
        else:
            body = {"id": STATE_ID, "summary": "LCCC weekend tournament cancellation receipts",
                    "visibility": "private", "transparency": "transparent", "description": description,
                    "start": {"date": "1970-01-01"}, "end": {"date": "1970-01-02"},
                    "extendedProperties": {"private": {"source": "weekend-conflicts"}}}
            service.events().insert(calendarId=CALENDAR, body=body).execute()
            state_event = get_event(service, STATE_ID)
            if not state_event or state_event.get("description") != description:
                raise ValueError("Conflict receipt read-back failed; no tournament was cancelled.")

    changed = 0
    for action, event, body, receipt in plans:
        event_id = event["id"]
        if action != "forget":
            changed += 1
            label = event.get("summary") or receipts.get(event_id, {}).get("event", {}).get("summary", event_id)
            print(f"{action} {label}: " + (", ".join(receipt["conflicts"]) if receipt else "weekend conflict removed"))
        if dry_run:
            continue
        if action == "cancel":
            event = fresh_revision(service, event)
            receipts[event_id] = receipt
            save()
            patch(service, event, body)
            receipt["phase"] = "cancelled"
            save()
        else:
            if action == "restore":
                patch(service, fresh_revision(service, event), body)
            del receipts[event_id]
            save()
    print(f"Club weekend conflicts: {changed} change(s)" + (" (dry run)" if dry_run else ""))
    return changed
