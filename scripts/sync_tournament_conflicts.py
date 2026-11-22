"""Reconcile Colorado tournament weekends and marked holidays on the club's calendars.

A private, past Calendar event stores the cancellation receipts. Cancelled events
can be returned as tombstones without their metadata, title, or times, so receipts
must live separately from the events being cancelled.
"""
import copy
import hashlib
import json
from datetime import datetime, timedelta

from googleapiclient.errors import HttpError

from update_calendar import CALENDARS, CLUB, TZ, as_datetime, problems

CALENDAR = CALENDARS["club"]
STATE_ID = hashlib.sha256(b"lccc-weekend-tournament-conflicts-v1").hexdigest()
HOLIDAY_STATE_ID = hashlib.sha256(b"lccc-community-holiday-conflicts-v1").hexdigest()
HOLIDAY_PREFIX = "Holiday:"
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


def holiday_dates(events):
    """Read private all-day markers as local dates, including repeating markers."""
    dates = set()
    for event in events:
        title = event.get("summary", "")
        if event.get("status") == "cancelled" or not title.startswith(HOLIDAY_PREFIX):
            continue
        start, end = event.get("start", {}), event.get("end", {})
        if (event.get("visibility") != "private" or not title[len(HOLIDAY_PREFIX):].strip()
                or "date" not in start or "date" not in end
                or as_datetime(end).date() - as_datetime(start).date() != timedelta(days=1)):
            raise ValueError("A Holiday: marker must be a private, named, one-day all-day holiday marker.")
        dates.add(as_datetime(start).date())
    return dates


def conflict_reasons(event, tournaments, holidays):
    meta = event.get("extendedProperties", {}).get("private", {})
    reasons = []
    if tournaments and meta.get("organizer") == CLUB and meta.get("format") == "tournament":
        reasons.extend(blockers(event, tournaments))
    # Grand Slam occurrences are already confirmed against the venue's dated calendar.
    if (holidays and event.get("recurringEventId") and meta.get("source") != "grandslam"
            and not problems(meta)):
        start = as_datetime(event["start"]).date()
        last = (as_datetime(event["end"]) - timedelta(microseconds=1)).date()
        reasons.extend(f"holiday {day}" for day in sorted(holidays) if start <= day <= last)
    return reasons


def upcoming_events(service, calendar_id, now):
    events, token = [], None
    while True:
        page = service.events().list(calendarId=calendar_id, singleEvents=True,
                                     timeMin=now.isoformat(), timeMax=(now + timedelta(days=DAYS_AHEAD)).isoformat(),
                                     pageToken=token).execute()
        events.extend(page.get("items", []))
        token = page.get("nextPageToken")
        if not token:
            return events


def get_event(service, event_id, calendar_id=CALENDAR):
    try:
        return service.events().get(calendarId=calendar_id, eventId=event_id).execute()
    except HttpError as error:
        if error.resp.status in (404, 410):
            return None
        raise


def patch(service, event, body, calendar_id=CALENDAR):
    if not event.get("etag"):
        raise ValueError("Calendar event has no revision; nothing was changed.")
    request = service.events().patch(calendarId=calendar_id, eventId=event["id"], body=body)
    request.headers["If-Match"] = event["etag"]
    request.execute()
    verified = get_event(service, event["id"], calendar_id)
    if not verified or any(verified.get(k) != v for k, v in body.items()):
        raise ValueError("Calendar read-back differs after a conflict update; inspect before retrying.")
    return verified


def fresh_revision(service, event, calendar_id):
    """Accept revision-only changes from sibling occurrences, never changes to event details."""
    current = get_event(service, event["id"], calendar_id)
    fields = SNAPSHOT_FIELDS + ("status", "originalStartTime", "recurringEventId")
    if not current or any(current.get(key) != event.get(key) for key in fields):
        raise ValueError("Calendar event changed during conflict reconciliation; retry after inspection.")
    return current


def sync_calendar_conflicts(service, tournaments, dry_run=False, now=None):
    now = now or datetime.now(TZ)
    club = upcoming_events(service, CALENDAR, now)
    holidays = holiday_dates(club)
    community_id = CALENDARS["community"]
    community = upcoming_events(service, community_id, now)
    return (sync_conflicts(service, tournaments, dry_run, now, events=club, holidays=holidays)
            + sync_conflicts(service, [], dry_run, now, events=community, holidays=holidays,
                             calendar_id=community_id))


def sync_conflicts(service, tournaments, dry_run=False, now=None, *, events=None, holidays=(), calendar_id=CALENDAR):
    now = now or datetime.now(TZ)
    if calendar_id == CALENDAR:
        state_id, source, title = STATE_ID, "weekend-conflicts", "LCCC weekend tournament cancellation receipts"
    else:
        state_id, source, title = HOLIDAY_STATE_ID, "holiday-conflicts", "LCCC community holiday cancellation receipts"
    state_event = get_event(service, state_id, calendar_id)
    if state_event:
        if (state_event.get("visibility") != "private" or state_event.get("status") == "cancelled"
                or state_event.get("extendedProperties", {}).get("private", {}).get("source") != source):
            raise ValueError("Conflict state event is invalid; nothing was changed on this calendar.")
        state = json.loads(state_event["description"])
    else:
        state = {"version": 1, "cancelled": {}}
    if state.get("version") != 1 or not isinstance(state.get("cancelled"), dict):
        raise ValueError("Unknown conflict state; nothing was changed on this calendar.")
    receipts = state["cancelled"]
    # Validate all receipts before planning any writes.
    for receipt in receipts.values():
        if receipt["phase"] not in {"pending", "cancelled"}:
            raise ValueError("Unknown cancellation phase; nothing was changed.")
        as_datetime(receipt["event"]["start"])
        as_datetime(receipt["event"]["end"])

    if events is None:
        events = upcoming_events(service, calendar_id, now)
    candidates = [event for event in events if event.get("status") != "cancelled"
                  and event.get("visibility") not in {"private", "confidential"}
                  and as_datetime(event["start"]) > now]

    plans = []
    for event_id, receipt in list(receipts.items()):
        snapshot = receipt["event"]
        if as_datetime(snapshot["start"]) <= now:
            plans.append(("forget", {"id": event_id}, None, None))
            continue
        event = get_event(service, event_id, calendar_id)
        if not event:
            raise ValueError(f"Cannot read automatically cancelled event {event_id}; inspect before restoring.")
        if event.get("status") != "cancelled":
            plans.append(("forget", event, None, None))
        elif receipt["phase"] == "pending":
            raise ValueError(f"Cancellation of {event_id} was interrupted; inspect before restoring.")
        elif not conflict_reasons({**snapshot, "recurringEventId": event.get("recurringEventId")},
                                  tournaments, holidays):
            plans.append(("restore", event, {**snapshot, "status": "confirmed"}, None))
    for event in candidates:
        conflicts = conflict_reasons(event, tournaments, holidays)
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
            state_event = patch(service, state_event, {"description": description}, calendar_id)
        else:
            body = {"id": state_id, "summary": title,
                    "visibility": "private", "transparency": "transparent", "description": description,
                    "start": {"date": "1970-01-01"}, "end": {"date": "1970-01-02"},
                    "extendedProperties": {"private": {"source": source}}}
            service.events().insert(calendarId=calendar_id, body=body).execute()
            state_event = get_event(service, state_id, calendar_id)
            if not state_event or state_event.get("description") != description:
                raise ValueError("Conflict receipt read-back failed; no tournament was cancelled.")

    changed = 0
    for action, event, body, receipt in plans:
        event_id = event["id"]
        if action != "forget":
            changed += 1
            label = event.get("summary") or receipts.get(event_id, {}).get("event", {}).get("summary", event_id)
            print(f"{action} {label}: " + (", ".join(receipt["conflicts"]) if receipt else "calendar conflict removed"))
        if dry_run:
            continue
        if action == "cancel":
            event = fresh_revision(service, event, calendar_id)
            receipts[event_id] = receipt
            save()
            patch(service, event, body, calendar_id)
            receipt["phase"] = "cancelled"
            save()
        else:
            if action == "restore":
                patch(service, fresh_revision(service, event, calendar_id), body, calendar_id)
            del receipts[event_id]
            save()
    print(f"{'Club' if calendar_id == CALENDAR else 'Community'} calendar conflicts: {changed} change(s)"
          + (" (dry run)" if dry_run else ""))
    return changed
