#!/usr/bin/env python3
"""Check the club's TDs and its US Chess affiliate for anything expired or expiring soon.

    python3 scripts/td_expirations.py [--days 60] [--email]

Reads the TDs' US Chess IDs and the affiliate ID from scripts/tds.json, then asks the
US Chess ratings API (v2) for each one's membership, TD certification, and SafeSport
dates. A TD's certification lapses with their membership, so all three count. Exits 1
if any date is past or within --days, so the weekly Action "TD expirations" fails and
GitHub emails about it.

Junior TDs are minors, so their IDs aren't in tds.json, and neither their names nor
their dates print: the IDs come from LCCC_JUNIOR_TD_IDS (comma-separated), or locally
from ~/.config/lccc/junior-td-ids. The API key comes from USCHESS_API_KEY, or locally
from ~/.config/lccc/uschess-api-key.

With --email, a run that finds anything also mails the list to president@larimerchess.org
through Gmail, signed in as that account with a send-only token: LCCC_GMAIL_TOKEN, or
locally ~/.config/lccc/google-token-gmail-send.json (docs/scripts/google_auth.py
--gmail-send makes it).
"""
import argparse
import base64
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request
from email.message import EmailMessage
from pathlib import Path

ROSTER = Path(__file__).resolve().parent / "tds.json"
CONFIG = Path.home() / ".config" / "lccc"
API = "https://ratings-api.uschess.org/api/v2"
PRESIDENT = "president@larimerchess.org"


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


def send_email(subject, body):
    raw = setting("LCCC_GMAIL_TOKEN", "google-token-gmail-send.json")
    token = json.loads(raw[raw.find("{"):raw.rfind("}") + 1])
    refresh = urllib.parse.urlencode({
        "client_id": token["client_id"],
        "client_secret": token["client_secret"],
        "refresh_token": token["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    with urllib.request.urlopen(token.get("token_uri", "https://oauth2.googleapis.com/token"), refresh, timeout=30) as response:
        access = json.load(response)["access_token"]
    message = EmailMessage()
    message["To"] = message["From"] = PRESIDENT
    message["Subject"] = subject
    message.set_content(body)
    request = urllib.request.Request(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        data=json.dumps({"raw": base64.urlsafe_b64encode(message.as_bytes()).decode()}).encode(),
        headers={"Authorization": f"Bearer {access}", "Content-Type": "application/json"},
    )
    urllib.request.urlopen(request, timeout=30).close()
    print(f"Emailed {PRESIDENT}")


def date(text):
    return datetime.date.fromisoformat(text[:10]) if text else None


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--days", type=int, default=60, help="warn this many days ahead (default 60)")
    parser.add_argument("--email", action="store_true", help=f"if anything is due, email {PRESIDENT}")
    args = parser.parse_args()

    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    key = setting("USCHESS_API_KEY", "uschess-api-key")
    juniors = [i.strip() for i in setting("LCCC_JUNIOR_TD_IDS", "junior-td-ids", required=False).split(",") if i.strip()]
    tds = [(td["name"], td["uschess_id"], True) for td in roster["tds"]]
    tds += [(f"Junior TD {n}", member_id, False) for n, member_id in enumerate(juniors, start=1)]

    today = datetime.date.today()
    horizon = today + datetime.timedelta(days=args.days)
    problems = []
    lines = ["| TD | Level | Membership | TD certification | SafeSport |", "|---|---|---|---|---|"]
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
        lines.append(f"| {label} | {member.get('tdLevel') or 'None'} | " + " | ".join(shown) + " |")

    affiliate_id = roster["affiliate"]
    expires = date(get(key, f"/affiliates/{affiliate_id}").get("expirationDate"))
    lines.append(f"\nAffiliate {affiliate_id} expires {expires}")
    print("\n".join(lines))
    if expires is None or expires <= horizon:
        problems.append(f"Affiliate {affiliate_id}: {'no expiration date' if expires is None else f'expires {expires}'}")

    if problems:
        report = f"Past or within {args.days} days:\n" + "\n".join(f"  {p}" for p in problems)
        print("\n" + report)
        if args.email:
            run = os.environ.get("GITHUB_RUN_ID")
            link = f"\n\nRun: https://github.com/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{run}" if run else ""
            send_email("TD expirations need attention",
                       report + "\n\n" + "\n".join(lines) + link
                       + "\n\nJunior TD 1 is the junior TD in LCCC_JUNIOR_TD_IDS; see docs/contacts/people.md.")
        sys.exit(1)
    print(f"\nNothing expires in the next {args.days} days.")


if __name__ == "__main__":
    main()
