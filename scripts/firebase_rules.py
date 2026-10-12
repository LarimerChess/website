#!/usr/bin/env python3
"""Apply database.rules.json to the club's Firebase Realtime Database.

    LCCC_FIREBASE_URL=https://<database>.firebaseio.com ~/.local/share/lccc/venv/bin/python scripts/firebase_rules.py [--dry-run | --check]

The rules let anyone read /public and /changes, and nobody read or write anything else; the
registration script and these scripts sign in as the president, which the rules don't limit.
Without LCCC_FIREBASE_URL the URL is LIVE_DB in register.js. The token is google_auth.py
--firebase's.

--dry-run prints what it would send and sends nothing; --check compares the live rules with the
file and fails if they differ. After applying, it reads the rules back to check them.
"""
import argparse
import json
import sys
from pathlib import Path

import firebase_db

RULES = Path(__file__).resolve().parent.parent / "database.rules.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    which = parser.add_mutually_exclusive_group()
    which.add_argument("--dry-run", action="store_true", help="print what would be sent, and send nothing")
    which.add_argument("--check", action="store_true", help="fail if the live rules differ from the file")
    args = parser.parse_args()

    rules = json.loads(RULES.read_text(encoding="utf-8"))
    if args.dry_run:
        url = firebase_db.database_url() or "<database URL>"
        print(f"PUT {url}/.settings/rules.json\n{json.dumps(rules, indent=2)}")
        return
    db = firebase_db.connect()
    if not args.check:
        db.put(".settings/rules", rules)
    live = db.get(".settings/rules")
    if live != rules:
        sys.exit(f"The live rules differ from {RULES.name}:\n{json.dumps(live, indent=2)}")
    print(f"The live rules match {RULES.name}")


if __name__ == "__main__":
    main()
