#!/usr/bin/env python3
"""Keep the day-pass rates in Adult Chess at Estes Valley Community Center's description current.

    ~/.local/share/lccc/venv/bin/python scripts/sync_evrpd.py [--dry-run]

Reads the resident and non-resident daily rates for adults and seniors from the Estes
Valley Recreation and Park District's memberships page and rewrites the "Day pass" lines
of our event's description when they differ. The event is on the club calendar, tagged
source=evrpd. If the page yields no rates, nothing is changed. See docs/events/community-calendar.md.
"""
import argparse
import base64
import html
import re
import sys
import urllib.error
import urllib.request

import brotli
from googleapiclient.discovery import build

from update_calendar import CALENDARS
from google_auth import credentials
from sync_chessmates import BROWSER

RATES_PAGE = "https://evrpd.com/community-center-memberships/"
TAG = "evrpd"
AGES = {"Adult": "adults 18–54", "Senior": "seniors 55+"}


def get(url, cookie=None):
    """The page text. The server sends Brotli whatever the request accepts."""
    headers = dict(BROWSER, **({"Cookie": cookie} if cookie else {}))
    try:
        response = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30)
    except urllib.error.HTTPError as error:
        if error.code != 307:
            raise
        response = error
    with response:
        body = response.read()
        if response.headers.get("Content-Encoding") == "br":
            body = brotli.decompress(body)
    return body.decode("utf-8", "replace")


def js_string(expr):
    """Evaluate the concatenation of literals Sucuri's challenge builds its cookie from."""
    piece = re.compile(
        r"""String\.fromCharCode\((\d+)\)"""
        r"""|(["'])(.*?)\2\.(slice|substr|charAt)\((\d+)(?:,(\d+))?\)"""
        r"""|(["'])(.*?)\7""")
    out, pos = "", 0
    for m in piece.finditer(expr):
        if expr[pos:m.start()].strip(" +"):
            sys.exit(f"Can't read the site's JavaScript check near: {expr[pos:m.start()][:60]!r}")
        pos = m.end()
        if m.group(1):
            out += chr(int(m.group(1)))
        elif m.group(4):
            text, a, b = m.group(3), int(m.group(5)), m.group(6)
            b = None if b is None else int(b)
            out += {"slice": text[a:b], "substr": text[a:a + b] if b is not None else text[a:],
                    "charAt": text[a:a + 1]}[m.group(4)]
        else:
            out += m.group(8)
    return out


def fetch_page():
    """The rates page. The site's firewall (Sucuri) first serves a script that sets a cookie and reloads."""
    page = get(RATES_PAGE)
    challenge = re.search(r"S='([A-Za-z0-9+/=]+)'", page)
    if not challenge:
        return page
    script = base64.b64decode(challenge.group(1)).decode()
    match = re.fullmatch(r"\s*(\w+)=(.*?);document\.cookie=(.*?)\s*\+\s*\1\s*\+\s*'(;path=/[^']*)';\s*location\.reload\(\);?\s*",
                         script, re.S)
    if not match:
        sys.exit(f"Can't read the site's JavaScript check: {script[:120]!r}")
    cookie = js_string(match.group(3)) + js_string(match.group(2))
    return get(RATES_PAGE, cookie)


def daily_rates(page):
    """{("Resident"|"Non-Resident", "Adult"|"Senior"): dollars} from the first Daily table under each heading."""
    text = html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"(?s)<(script|style).*?</\1>", "", page)))
    text = re.sub(r"\s+", " ", text)
    rates = {}
    for residency in ("Resident", "Non-Resident"):
        section = re.search(rf"(?<!-){residency} Rates Daily (.*?) Weekly", text)
        if not section:
            sys.exit(f"No {residency} daily rates on {RATES_PAGE}")
        for age in AGES:
            price = re.search(rf"{age} \([^)]*\) \$(\d+)", section.group(1))
            if not price:
                sys.exit(f"No {residency} {age} daily rate on {RATES_PAGE}")
            rates[residency, age] = price.group(1)
    return rates


def rate_lines(rates):
    return [f"Day pass, {label}: ${rates['Resident', age]} for district residents, "
            f"${rates['Non-Resident', age]} for non-residents" for age, label in AGES.items()]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="print changes without making them")
    args = parser.parse_args()

    lines = rate_lines(daily_rates(fetch_page()))

    cal = build("calendar", "v3", credentials=credentials("calendar"), cache_discovery=False)
    events = cal.events().list(calendarId=CALENDARS["club"], privateExtendedProperty=f"source={TAG}").execute()
    events = [e for e in events.get("items", []) if e.get("status") != "cancelled"]
    if len(events) != 1:
        sys.exit(f"Expected one club calendar event tagged source={TAG}, found {len(events)}")
    event = events[0]

    old = event.get("description", "").split("\n")
    kept = [line for line in old if not line.startswith("Day pass, ")]
    if len(old) - len(kept) != len(lines) or not kept[0].startswith("Cost:"):
        sys.exit(f"{event['summary']}: expected a Cost line followed by {len(lines)} 'Day pass, ' lines")
    new = kept[:1] + lines + kept[1:]
    if new == old:
        print(f"{event['summary']}: rates unchanged")
        return
    for line in lines:
        print(f"{event['summary']}: {line}")
    if not args.dry_run:
        cal.events().patch(calendarId=CALENDARS["club"], eventId=event["id"], body={"description": "\n".join(new)}).execute()


if __name__ == "__main__":
    main()
