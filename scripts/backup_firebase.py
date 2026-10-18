#!/usr/bin/env python3
"""Back up the whole Firebase database to a private folder on this machine, then prune old backups.

    ~/.local/share/lccc/venv/bin/python scripts/backup_firebase.py [--dir DIR] [--dry-run]

Each run writes DIR/firebase-YYYY-MM-DD.json (default DIR ~/.local/share/lccc/backups), readable
only by its owner, since the database holds players' details; a second run the same day replaces
that day's file. Then it keeps the last 7 days' backups, the earliest of last week (Monday to
Sunday), and the earliest of each month for the last 12 months, and deletes the rest. --dry-run
reads the database and lists what it would delete, but writes and deletes nothing.

Restoring is a PUT of the file's contents to the database's root, which replaces everything
entered since.
"""
import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path

from firebase_db import connect

BACKUP = re.compile(r"^firebase-(\d{4}-\d{2}-\d{2})\.json$")


def keep(dates, today):
    """The dates of the backups to keep."""
    dates = sorted(dates)
    kept = {d for d in dates if (today - d).days < 7}
    this_monday = today - datetime.timedelta(days=today.weekday())
    last_week = [d for d in dates if this_monday - datetime.timedelta(days=7) <= d < this_monday]
    kept.update(last_week[:1])
    oldest_month = (today.year * 12 + today.month - 1) - 12
    months = {}
    for d in dates:
        month = d.year * 12 + d.month - 1
        if month >= oldest_month:
            months.setdefault(month, d)
    kept.update(months.values())
    return kept


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", type=Path, default=Path.home() / ".local/share/lccc/backups")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    data = connect().get("")
    if not data:
        sys.exit("The database answered empty; keeping the old backups as they are.")
    today = datetime.date.today()
    path = args.dir / f"firebase-{today.isoformat()}.json"
    if args.dry_run:
        print(f"Would write {path}")
    else:
        args.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        partial = path.with_suffix(".partial")
        with open(os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False, indent=1)
        partial.replace(path)
        print(f"Wrote {path} ({path.stat().st_size} bytes)")

    backups = {}
    for file in args.dir.glob("firebase-*.json") if args.dir.exists() else ():
        if match := BACKUP.match(file.name):
            backups[datetime.date.fromisoformat(match[1])] = file
    kept = keep(backups, today)
    for date in sorted(set(backups) - kept):
        print(f"{'Would delete' if args.dry_run else 'Deleted'} {backups[date].name}")
        if not args.dry_run:
            backups[date].unlink()


if __name__ == "__main__":
    main()
