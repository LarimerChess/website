#!/usr/bin/env python3
"""Sign in to the club's Google Workspace and report which account the token belongs to.

Run once with the venv's Python to sign in in a browser:

    ~/.local/share/lccc/venv/bin/python scripts/google_auth.py

Over SSH, first forward the sign-in port from the machine with the browser:

    ssh -N -L 8085:localhost:8085 <this host>

then run the script here and open the URL it prints in that browser.

--calendar signs in for a separate token that can only edit calendar events, for the
Sync calendars Action; --calendar-read for one that can only read them, for Update
calendar; --gmail-send for one that can only send mail, for the TD expirations check;
--sheets for one that can only read and edit spreadsheets, for the Archive tournaments
Action; --contacts for one that can only read and edit the Google Contacts of larimercountychessclub@gmail.com; --firebase for one that can only read and write the Firebase Realtime Database, for
scripts/firebase_rules.py, migrate_tournaments.py, and the Archive tournaments Action. In
Actions the token's JSON comes from the LCCC_GOOGLE_TOKEN environment variable instead of a
file, or LCCC_GOOGLE_FIREBASE_TOKEN for --firebase, since the archive needs both.

Other scripts import credentials() from here, the docs repo's through its own
scripts/google_auth.py. See docs/plans/google-api-access.md.
"""
import argparse
import json
import os
import sys
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

CONFIG = Path.home() / ".config" / "lccc"
CLIENT = CONFIG / "google-client.json"
# Contacts live in the club's gmail.com account, which the Internal client above refuses, so that
# profile has a client of its own, in a project with an External consent screen.
CLIENTS = {"contacts": CONFIG / "google-client-contacts.json"}
DOMAIN = "larimerchess.org"
PORT = 8085
IDENTITY = ["openid", "https://www.googleapis.com/auth/userinfo.email"]
PROFILES = {
    "full": (CONFIG / "google-token.json", IDENTITY + [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/gmail.compose",
    ]),
    "calendar": (CONFIG / "google-token-calendar.json", IDENTITY + [
        "https://www.googleapis.com/auth/calendar.events",
    ]),
    "calendar-read": (CONFIG / "google-token-calendar-read.json", IDENTITY + [
        "https://www.googleapis.com/auth/calendar.events.readonly",
    ]),
    "gmail-send": (CONFIG / "google-token-gmail-send.json", IDENTITY + [
        "https://www.googleapis.com/auth/gmail.send",
    ]),
    "sheets": (CONFIG / "google-token-sheets.json", IDENTITY + [
        "https://www.googleapis.com/auth/spreadsheets",
    ]),
    "firebase": (CONFIG / "google-token-firebase.json", IDENTITY + [
        "https://www.googleapis.com/auth/firebase.database",
    ]),
    "contacts": (CONFIG / "google-token-contacts.json", IDENTITY + [
        "https://www.googleapis.com/auth/contacts",
    ]),
}
ENV = {"firebase": "LCCC_GOOGLE_FIREBASE_TOKEN"}


def credentials(profile="full"):
    token, scopes = PROFILES[profile]
    env = ENV.get(profile, "LCCC_GOOGLE_TOKEN")
    if env in os.environ:
        if not os.environ[env].strip():
            sys.exit(f"{env} is empty. Is the repository secret set, with exactly that name?")
        creds = Credentials.from_authorized_user_info(token_from_env(os.environ[env], env), scopes)
        creds.refresh(Request())
        return creds
    creds = Credentials.from_authorized_user_file(token, scopes) if token.exists() else None
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        save(creds, token)
        return creds
    if not sys.stdin.isatty():
        sys.exit(f"No usable token at {token}. Sign in from a terminal: scripts/google_auth.py"
                 + ("" if profile == "full" else f" --{profile}"))
    client = CLIENTS.get(profile, CLIENT)
    if not client.exists():
        sys.exit(f"Missing {client}. Download the OAuth client JSON from the Cloud console first.")
    # hd only preselects the club domain in Google's account chooser; the
    # Internal consent screen is what actually refuses other accounts.
    flow = InstalledAppFlow.from_client_secrets_file(client, scopes)
    # A fixed port lets the sign-in redirect come back through an SSH tunnel.
    creds = flow.run_local_server(
        port=PORT, prompt="consent", **({} if profile in CLIENTS else {"hd": DOMAIN}),
         open_browser=bool(os.environ.get("DISPLAY"))
    )
    save(creds, token)
    return creds


def token_from_env(raw, env="LCCC_GOOGLE_TOKEN"):
    # A token pasted or piped into a secret can pick up stray text around the JSON.
    # Use what lies between the outer braces, and say how much was dropped without
    # printing any of it.
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < start:
        sys.exit(f"{env} is {len(raw)} characters with no JSON object in it. Set the secret again.")
    if start or end < len(raw) - 1:
        print(f"warning: ignored {start} character(s) before and {len(raw) - 1 - end} after the token in"
              f" {env}. Set the secret again to clean it up.", file=sys.stderr)
    return json.loads(raw[start:end + 1])


def save(creds, token):
    token.write_text(creds.to_json())
    os.chmod(token, 0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    which = parser.add_mutually_exclusive_group()
    which.add_argument("--calendar", action="store_const", const="calendar", dest="profile",
                       help="sign in for the token that can only edit calendar events")
    which.add_argument("--calendar-read", action="store_const", const="calendar-read", dest="profile",
                       help="sign in for the token that can only read calendar events")
    which.add_argument("--gmail-send", action="store_const", const="gmail-send", dest="profile",
                       help="sign in for the token that can only send mail")
    which.add_argument("--sheets", action="store_const", const="sheets", dest="profile",
                       help="sign in for the token that can only read and edit spreadsheets")
    which.add_argument("--contacts", action="store_const", const="contacts", dest="profile",
                       help="sign in for the token that can only read and edit Google Contacts")
    which.add_argument("--firebase", action="store_const", const="firebase", dest="profile",
                       help="sign in for the token that can only read and write the Firebase database")
    profile = parser.parse_args().profile or "full"
    creds = credentials(profile)
    user = build("oauth2", "v2", credentials=creds).userinfo().get().execute()
    email = user.get("email", "")
    print(f"Signed in as {email}")
    if profile not in CLIENTS and not email.endswith("@" + DOMAIN):
        sys.exit(f"Not a {DOMAIN} account. Delete {PROFILES[profile][0]} and sign in again.")


if __name__ == "__main__":
    main()
