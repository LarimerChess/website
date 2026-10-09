#!/usr/bin/env python3
"""Check the club's TDs and its US Chess affiliate for anything expired or expiring soon.

    python3 scripts/td_expirations.py [--days 60]

Reads the TDs' US Chess IDs and the affiliate ID from scripts/tds.json, then asks the
US Chess ratings API (v2) for each one's membership, TD certification, and SafeSport
dates. A TD's certification lapses with their membership, so all three count. Exits 1
if any date is past or within --days, so the weekly Action "TD expirations" fails and
GitHub emails about it.

Junior TDs are minors, so their IDs aren't in tds.json, and neither their names nor
their dates print: the IDs come from LCCC_JUNIOR_TD_IDS (comma-separated), or locally
from ~/.config/lccc/junior-td-ids. The API key comes from USCHESS_API_KEY, or locally
from ~/.config/lccc/uschess-api-key.
"""
import argparse
import datetime
import json
import os
import sys
import urllib.request
from pathlib import Path

ROSTER = Path(__file__).resolve().parent / "tds.json"
CONFIG = Path.home() / ".config" / "lccc"
API = "https://ratings-api.uschess.org/api/v2"


def setting(env, filename, required=True):
    value = os.environ.get(env)
    if value is None and (CONFIG / filename).exists():
        value = (CONFIG / filename).read_text()
    if value is None and required:
        sys.exit(f"Set {env} or create {CONFIG / filename}")
    return (value or "").strip()


def get(key, path):
    request = urllib.request.Request(API + path, headers={"X-Api-Key": key, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def date(text):
    return datetime.date.fromisoformat(text[:10]) if text else None


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--days", type=int, default=60, help="warn this many days ahead (default 60)")
    args = parser.parse_args()

    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    key = setting("USCHESS_API_KEY", "uschess-api-key")
    juniors = [i.strip() for i in setting("LCCC_JUNIOR_TD_IDS", "junior-td-ids", required=False).split(",") if i.strip()]
    tds = [(td["name"], td["uschess_id"], True) for td in roster["tds"]]
    tds += [(f"Junior TD {n}", member_id, False) for n, member_id in enumerate(juniors, start=1)]

    today = datetime.date.today()
    horizon = today + datetime.timedelta(days=args.days)
    problems = []
    print("| TD | Level | Membership | TD certification | SafeSport |\n|---|---|---|---|---|")
    for label, member_id, public in tds:
        member = get(key, f"/members/{member_id}")
        dates = {
            "Membership": date(member.get("expirationDate")),
            "TD certification": date(member.get("tdCertExpirationDate")),
            "SafeSport": date(member.get("safePlayExpirationDate")),
        }
        if member.get("tdCertStatus") != "Active":
            problems.append(f"{label}: TD certification is {member.get('tdCertStatus') or 'missing'}")
        for what, when in dates.items():
            if when is None:
                problems.append(f"{label}: no {what} date on record")
            elif when < today:
                problems.append(f"{label}: {what} expired" + (f" {when}" if public else ""))
            elif when <= horizon:
                problems.append(f"{label}: {what} expires " + (str(when) if public else f"within {args.days} days"))
        shown = [str(d or "") for d in dates.values()] if public else ["(private)"] * 3
        print(f"| {label} | {member.get('tdLevel') or 'None'} | " + " | ".join(shown) + " |")

    affiliate_id = roster["affiliate"]
    expires = date(get(key, f"/affiliates/{affiliate_id}").get("expirationDate"))
    print(f"\nAffiliate {affiliate_id} expires {expires}")
    if expires is None or expires <= horizon:
        problems.append(f"Affiliate {affiliate_id}: {'no expiration date' if expires is None else f'expires {expires}'}")

    if problems:
        print(f"\nPast or within {args.days} days:")
        for problem in problems:
            print(f"  {problem}")
        sys.exit(1)
    print(f"\nNothing expires in the next {args.days} days.")


if __name__ == "__main__":
    main()
