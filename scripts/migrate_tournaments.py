#!/usr/bin/env python3
"""Copy running tournaments from the Tournaments in progress spreadsheet to the Firebase database, once, at the switch.

    LCCC_FIREBASE_URL=https://<database>.firebaseio.com ~/.local/share/lccc/venv/bin/python scripts/migrate_tournaments.py [--queues FILE] [--replace] [--dry-run]

Each row of the Tournaments, Players, Rounds, and Arena tabs goes to /tables/<tab>/r<its sheet
row, six digits>, so rows sort in sheet order: an object by heading, values as the sheet shows
them. --queues FILE is the registration script's arenaQueues property saved to a file; each
arena's queue goes to /queues/<key with : for />, as a JSON string. Nothing goes to /public; the
script's Refresh rebuilds it. The layout is in the docs repo's plans/firebase-tournaments.md.

It refuses when /tables already has rows, unless --replace, which replaces /tables, and /queues
when --queues is given. After writing, it reads both back and compares. --dry-run only counts.

--fixture FILE reads the spreadsheet from a JSON file as archive_tournaments.py does, and needs
--out FILE, which writes what the database would hold to a file and never touches the database.
"""
import argparse
import json
import sys
from pathlib import Path

import firebase_db
from archive_tournaments import TOURNAMENT_SHEET, TOURNAMENT_TABS, read_book, read_fixture


def tables_of(book):
    tables = {}
    for tab in TOURNAMENT_TABS:
        rows = {f"r{r['_row']:06d}": firebase_db.encode_row({k: v for k, v in r.items() if k != "_row"})
                for r in book.get(tab, (None, []))[1] if any(v for k, v in r.items() if k != "_row")}
        # The database drops an empty node, so an empty tab would never read back.
        if rows:
            tables[tab] = rows
    return tables


def queues_of(path):
    queues = json.loads(Path(path).read_text(encoding="utf-8"))
    return {firebase_db.node(key): json.dumps(queue, ensure_ascii=False, separators=(",", ":"))
            for key, queue in queues.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--queues", help="the arenaQueues script property, saved to this file")
    parser.add_argument("--replace", action="store_true", help="replace the rows already in the database")
    parser.add_argument("--dry-run", action="store_true", help="count what would be copied, and write nothing")
    parser.add_argument("--fixture", help="read the spreadsheet from this JSON file; needs --out")
    parser.add_argument("--out", type=Path, help="write what the database would hold to this file instead")
    args = parser.parse_args()
    if args.fixture and not args.out:
        sys.exit("--fixture needs --out, so sample rows never reach the database")

    if args.fixture:
        book = read_fixture(args.fixture)
    else:
        from googleapiclient.discovery import build
        from google_auth import credentials
        service = build("sheets", "v4", credentials=credentials("full"), cache_discovery=False).spreadsheets()
        book = read_book(service, TOURNAMENT_SHEET, TOURNAMENT_TABS)
    update = {"tables": tables_of(book)}
    if args.queues:
        update["queues"] = queues_of(args.queues)
    counts = ", ".join(f"{len(update['tables'].get(tab, {}))} {tab}" for tab in TOURNAMENT_TABS)
    print(f"{counts} rows" + (f", {len(update['queues'])} arena queue(s)" if args.queues else "")
          + (" (dry run)" if args.dry_run else ""))

    if args.out:
        if not args.dry_run:
            args.out.write_text(json.dumps(update, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"wrote {args.out}")
        return
    write(firebase_db.connect(), update, args.replace, args.dry_run)


def write(db, update, replace, dry_run):
    if db.get("tables", shallow="true") and not replace:
        sys.exit("The database already has rows in /tables. Run with --replace to overwrite them.")
    if dry_run:
        print(f"would write them to {db.url}")
        return
    db.patch("", update)
    back = {path: db.get(path) or {} for path in update}
    if back != update:
        sys.exit("What the database holds now differs from what was sent. Compare /tables and /queues with the "
                 "spreadsheet, and run again with --replace.")
    print(f"wrote and read back {db.url}")


if __name__ == "__main__":
    main()
