"""Publish public club occurrences for the Facebook browser extension.

Missing upcoming occurrences are read by ID before declaring a cancellation.
This also retains reschedules beyond the ordinary 90-day import window.
"""
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from update_calendar import CALENDARS, CLUB, EVENTS_URL, TZ, access_token, fetch, problems

OUT = Path(__file__).resolve().parents[1] / "facebook-events.json"


def instant(value):
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("Facebook feed times need a time zone.")
    return parsed


def public_event(item):
    meta = item.get("extendedProperties", {}).get("private", {})
    if item.get("status") == "cancelled" or item.get("visibility") in {"private", "confidential"} or meta.get("organizer") != CLUB:
        return None
    if problems(meta):
        raise ValueError("Club event has invalid calendar metadata.")
    if not item.get("start", {}).get("dateTime") or not item.get("end", {}).get("dateTime"):
        raise ValueError("Facebook sync supports timed club events only.")
    start, end = instant(item["start"]["dateTime"]), instant(item["end"]["dateTime"])
    if end <= start or not item.get("summary", "").strip() or not item.get("location", "").strip():
        raise ValueError("Club event needs a title, location, and valid start/end.")
    row = {"id": item["id"], "status": "active", "title": item["summary"],
           "description": item.get("description", ""), "location": item["location"],
           "start": start.astimezone(TZ).isoformat(), "end": end.astimezone(TZ).isoformat()}
    row["marker"] = "LCCC-" + hashlib.sha256((CALENDARS["club"] + "\0" + item["id"]).encode()).hexdigest()[:24]
    row["fingerprint"] = hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return row


def build(items, previous, lookup, now):
    old = {}
    if previous is not None:
        if previous.get("schema") != 1 or previous.get("calendarId") != CALENDARS["club"] or not isinstance(previous.get("events"), list):
            raise ValueError("Invalid previous Facebook feed; inspect it before replacing it.")
        for row in previous["events"]:
            if not row.get("id") or row["id"] in old or row.get("status") not in {"active", "cancelled"}:
                raise ValueError("Invalid previous Facebook occurrence.")
            instant(row["start"])
            instant(row["end"])
            old[row["id"]] = row
    current = {}
    seen = set()

    def accept(item):
        event_id = item.get("id")
        if not event_id:
            raise ValueError("Calendar occurrence has no ID.")
        row = public_event(item)
        if row is None:
            prior = old.get(event_id)
            if prior and instant(prior["start"]) > now:
                current[event_id] = {"id": event_id, "status": "cancelled", "start": prior["start"], "end": prior["end"]}
        elif instant(row["start"]) > now:
            current[event_id] = row

    for item in items:
        event_id = item.get("id")
        if event_id in seen:
            raise ValueError("Duplicate calendar occurrence ID.")
        seen.add(event_id)
        accept(item)
    for event_id, prior in old.items():
        if event_id in seen or instant(prior["start"]) <= now:
            continue
        item = lookup(event_id)
        if item.get("id") != event_id:
            raise ValueError("Calendar lookup returned a different occurrence ID.")
        accept(item)
    return {"schema": 1, "calendarId": CALENDARS["club"], "generatedAt": now.isoformat(),
            "events": sorted(current.values(), key=lambda row: (row["start"], row["id"]))}


def lookup(event_id, token):
    url = EVENTS_URL.format(urllib.parse.quote(CALENDARS["club"], safe="")) + "/" + urllib.parse.quote(event_id, safe="")
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 410:
            return {"id": event_id, "status": "cancelled"}
        raise RuntimeError(f"Google occurrence lookup failed (HTTP {error.code}); Facebook feed is unchanged.") from None


def main():
    raw = os.environ.get("LCCC_GOOGLE_TOKEN", "")
    if not raw.strip():
        raise ValueError("LCCC_GOOGLE_TOKEN must be the read-only Calendar token.")
    token = access_token(raw)
    now = datetime.now(TZ)
    previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else None
    data = build(fetch(CALENDARS["club"], token, now.date()), previous,
                 lambda event_id: lookup(event_id, token), now)
    # A stable timestamp avoids an hourly site rebuild when the public event data is unchanged.
    if previous and data["events"] == previous["events"] and now - instant(previous["generatedAt"]) < timedelta(hours=12):
        return
    temporary = OUT.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(OUT)
    print(f"Published {len(data['events'])} public club occurrences for the Facebook extension.")


if __name__ == "__main__":
    main()
