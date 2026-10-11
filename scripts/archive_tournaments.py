#!/usr/bin/env python3
"""Archive rated tournaments from the Tournaments in progress spreadsheet, then clear them from it.

    ~/.local/share/lccc/venv/bin/python scripts/archive_tournaments.py [--dry-run]
    ~/.local/share/lccc/venv/bin/python scripts/archive_tournaments.py --clear [--dry-run]

Without --clear, each tournament ratings.json lists (the rating check adds one once US Chess
shows the same results) is written beside its results page, to results/<slug>/archive.json: its
rows from the Tournaments, Players, Rounds, and Arena tabs, which the Pairings page shows anyway.
Registration entries, payments, and incidents are in the registration spreadsheet, which this
never reads. Nothing in the spreadsheet changes. Run again, it rewrites the files from the
spreadsheet, so a late correction is kept.

--clear is the separate step that deletes a rated tournament's rows from the Tournaments,
Players, Rounds, and Arena tabs, and only when all of these hold:
  1. its archive here matches the spreadsheet's rows now;
  2. that archive is committed and pushed (the working copy matches the upstream branch);
  3. its public results page, https://larimerchess.org/results/<event>-<date>/, answers 200
     and carries the fingerprint of these same rows, which scripts/build_results.py writes
     into it.
Otherwise it says what it is waiting for and leaves the rows.

--fixture FILE reads the spreadsheet from a JSON file instead of Google ({tab: rows}, each
tab's first row its headings) and never writes to Google; --ratings FILE reads ratings.json
from a file; --out DIR writes the archive somewhere other than this repo.

The Archive tournaments Action runs this daily, commits and pushes the archive, then runs it
with --clear. See README.md, Actions.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOURNAMENT_SHEET = "119cs96Se8ScZJ0B5V2G12Z04IpUOsDB8fvw9ZqEPBcw"
TOURNAMENT_TABS = ["Tournaments", "Players", "Rounds", "Arena"]
SITE = "https://larimerchess.org"


def log(message):
    print(message, flush=True)


# Reading the spreadsheets

def read_book(service, sheet_id, tabs):
    """{tab: (sheetId, rows)} with each row a dict by heading plus its sheet row number in "_row"."""
    meta = service.get(spreadsheetId=sheet_id, fields="sheets.properties").execute()
    ids = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta["sheets"]}
    book = {}
    for tab in tabs:
        if tab in ids:
            values = service.values().get(spreadsheetId=sheet_id, range=f"'{tab}'").execute().get("values", [])
            book[tab] = (ids[tab], rows_of(values))
    return book


def rows_of(values):
    if not values:
        return []
    header = [h.strip() for h in values[0]]
    return [dict({h: (r[i] if i < len(r) else "") for i, h in enumerate(header) if h}, _row=n)
            for n, r in enumerate(values[1:], 2)]


def read_fixture(path):
    return {tab: (None, rows_of(values)) for tab, values in json.loads(Path(path).read_text(encoding="utf-8")).items()}


def rows(book, tab):
    return book.get(tab, (None, []))[1]


def clean(row):
    return {k: v for k, v in row.items() if k != "_row"}


# One tournament

def collect(key, tournaments):
    """Everything the spreadsheet holds about one tournament, as archive.json keeps it."""
    mine = lambda tab: [clean(r) for r in rows(tournaments, tab) if r.get("Key") == key]
    return {
        "key": key,
        "tournament": mine("Tournaments")[0],
        "players": mine("Players"),
        "rounds": mine("Rounds"),
        "arena": mine("Arena"),
    }


def pact(value):
    return "" if str(value).strip().lower() in ("", "no", "false", "0", "none") else "1"


def number(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def in_section(row):
    """A row's section, to end its line; nothing without one, so a tournament without sections hashes as it always did."""
    return f" {row['Section']}" if row.get("Section") else ""


def fingerprint(record):
    """The hash scripts/build_results.py puts on a results page, from the same facts:
    each player and the round they left from, each game and bye, and each arena game, each with its section."""
    lines = [f"P {p['US Chess ID']} {number(p.get('Out from round')) or ''}{in_section(p)}" for p in record["players"]]
    for r in record["rounds"]:
        if r.get("Black"):
            lines.append(f"G {number(r['Round'])} {number(r['Board'])} {r['White']} {r['Black']} {r.get('Result', '')}"
                         f"{in_section(r)}")
        else:
            lines.append(f"B {number(r['Round'])} {r['White']} {float(r.get('Bye points') or 0):g}{in_section(r)}"
                         f"{' ' + r['Bye kind'] if r.get('Bye kind') else ''}")
    lines += [f"A {number(g.get('Game'))} {g['White']} {g['Black']} {g.get('Result', '')} "
              f"{pact(g.get('White pact'))} {pact(g.get('Black pact'))}" for g in record["arena"]]
    return hashlib.sha256("\n".join(sorted(lines)).encode()).hexdigest()[:16]


def slug(key):
    return key.replace("/", "-")


def ratings(path=None):
    """{key: US Chess event ID} from ratings.json, or the file given."""
    return json.loads(Path(path or ROOT / "ratings.json").read_text(encoding="utf-8"))


def page_url(key):
    return f"{SITE}/results/{slug(key)}/"


# The two steps

def archive_path(out, key):
    return out / "results" / slug(key) / "archive.json"


def archive(record, out, dry_run):
    target = archive_path(out, record["key"])
    data = (json.dumps(record, indent=2, ensure_ascii=False) + "\n").encode()
    changed = not target.exists() or target.read_bytes() != data
    where = target.relative_to(out).as_posix()
    if dry_run:
        log(f"archive {record['key']}: {'would write' if changed else 'up to date in'} {where}")
        return
    if changed:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    log(f"archive {record['key']}: {'wrote' if changed else 'up to date in'} {where}")


def committed_and_pushed(out, key):
    """None if the archive is in the upstream branch exactly as it is here; otherwise why not."""
    path = archive_path(out, key).relative_to(out).as_posix()
    git = lambda *args: subprocess.run(["git", *args], cwd=out, capture_output=True, text=True)
    if git("rev-parse", "@{u}").returncode != 0:
        return f"{out} isn't a git checkout with an upstream branch, so the archive can't be known to be pushed"
    if git("status", "--porcelain", "--", path).stdout.strip():
        return "the archive has changes that aren't committed"
    if not git("ls-tree", "--name-only", "@{u}", "--", path).stdout.strip():
        return "the archive isn't in the upstream branch yet; commit and push it"
    if git("diff", "--quiet", "@{u}", "--", path).returncode != 0:
        return "the upstream branch's archive differs from this one; push it"
    return None


def published(key, expected):
    """None if the results page is live and shows these rows; otherwise what it's waiting for."""
    url = page_url(key)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Cache-Control": "no-cache"}), timeout=30) as r:
            body = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return f"waiting for the website results page: {url} answered HTTP {error.code}"
    except OSError as error:
        return f"waiting for the website results page: {url} couldn't be reached ({error})"
    shown = re.search(r'data-results="([0-9a-f]+)"', body)
    if not shown or shown[1] != expected:
        return (f"waiting for the website results page: {url} shows {shown[1] if shown else 'no fingerprint'}, "
                f"not this archive's {expected}. The page is rebuilt hourly; a round saved but not posted also "
                "keeps them apart")
    return None


def clear(key, service, dry_run):
    """Deletes the tournament's rows from every tab in one request, then checks no other row moved."""
    before = read_book(service, TOURNAMENT_SHEET, TOURNAMENT_TABS)
    requests, doomed = [], {}
    for tab, (sheet_id, tab_rows) in before.items():
        doomed[tab] = sorted((r["_row"] for r in tab_rows if r.get("Key") == key), reverse=True)
        # Bottom up, so each deletion leaves the rows still to delete where they were.
        requests += [{"deleteDimension": {"range": {"sheetId": sheet_id, "dimension": "ROWS",
                                                    "startIndex": n - 1, "endIndex": n}}} for n in doomed[tab]]
    summary = ", ".join(f"{len(n)} from {tab}" for tab, n in doomed.items() if n)
    if dry_run:
        log(f"clear {key}: would delete {summary} (rows {doomed})")
        return
    log(f"clear {key}: deleting {summary}")
    service.batchUpdate(spreadsheetId=TOURNAMENT_SHEET, body={"requests": requests}).execute()
    after = read_book(service, TOURNAMENT_SHEET, TOURNAMENT_TABS)
    for tab, (_, tab_rows) in before.items():
        if [clean(r) for r in after[tab][1]] != [clean(r) for r in tab_rows if r.get("Key") != key]:
            saved = json.dumps({t: [clean(r) for r in rs] for t, (_, rs) in before.items()}, indent=2,
                               ensure_ascii=False)
            recovery = ROOT / f"results/recovery-{slug(key)}.json"
            recovery.write_text(saved + "\n", encoding="utf-8")
            # An Action's files don't outlast the run, so the rows go in its log as well.
            log(saved)
            sys.exit(f"clear {key}: after the deletion the {tab} tab isn't what was expected; something else may have "
                     f"changed it meanwhile. Every row from before is above and in {recovery.relative_to(ROOT)}. "
                     "Check the tab.")
    log(f"clear {key}: deleted {summary}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--clear", action="store_true",
                        help="delete archived, published tournaments from the spreadsheet")
    parser.add_argument("--dry-run", action="store_true", help="say what would be written or deleted, and change nothing")
    parser.add_argument("--fixture", help="read the spreadsheet from this JSON file; Google is never touched")
    parser.add_argument("--ratings", help="read ratings.json from this file")
    parser.add_argument("--out", type=Path, default=ROOT, help="write the archive under this folder, not this repo")
    args = parser.parse_args()

    service = None
    if args.fixture:
        tournaments = read_fixture(args.fixture)
    else:
        from googleapiclient.discovery import build
        from google_auth import credentials
        # In Actions the secret is the sheets-only token; locally the full token reads the same.
        profile = "sheets" if "LCCC_GOOGLE_TOKEN" in os.environ else "full"
        service = build("sheets", "v4", credentials=credentials(profile), cache_discovery=False).spreadsheets()
        tournaments = read_book(service, TOURNAMENT_SHEET, TOURNAMENT_TABS)
    statuses = [r.get("Status") for r in rows(tournaments, "Tournaments")]
    rated_events = ratings(args.ratings)
    rated = [r["Key"] for r in rows(tournaments, "Tournaments") if r.get("Key") in rated_events]
    log(f"{len(rated)} rated tournament(s) to {'clear' if args.clear else 'archive'}, "
        f"{len(statuses) - len(rated)} not rated yet" + (" (dry run)" if args.dry_run else ""))
    if not args.clear:
        for key in rated:
            archive(collect(key, tournaments), args.out, args.dry_run)
        return

    kept = 0
    for key in rated:
        record = collect(key, tournaments)
        stored = archive_path(args.out, key)
        if not stored.exists() or json.loads(stored.read_text(encoding="utf-8")) != record:
            reason = "it isn't archived, or the spreadsheet changed since; run without --clear first"
        else:
            reason = committed_and_pushed(args.out, key) or published(key, fingerprint(record))
        if reason:
            kept += 1
            log(f"clear {key}: kept, {reason}")
            if os.environ.get("GITHUB_ACTIONS"):
                print(f"::notice::{key} kept in the spreadsheet: {reason}")
        elif service is None:
            log(f"clear {key}: would delete its rows; a fixture never touches Google")
        else:
            clear(key, service, args.dry_run)
    if kept:
        log(f"{kept} tournament(s) kept in the spreadsheet until the steps above are done")


if __name__ == "__main__":
    main()
