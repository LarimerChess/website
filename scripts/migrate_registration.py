#!/usr/bin/env python3
"""Preview or apply the registration and payment lookup migration from a local terminal."""

import argparse
import json
import re
import subprocess
import sys
from urllib.request import Request, urlopen
from urllib.parse import urlencode

import firebase_db


def prepare(source=None, option=None):
    command = ["node", str(firebase_db.ROOT / "scripts" / "registration_migration.cjs")]
    if option:
        command.append(option)
    result = subprocess.run(command, input=json.dumps(source), encoding="utf-8",
                            capture_output=True, check=True)
    return json.loads(result.stdout)


def read_tabs(service, sheet_id):
    tabs = set(prepare(option="--tabs"))
    meta = service.get(spreadsheetId=sheet_id, fields="sheets.properties.title").execute()
    names = [sheet["properties"]["title"] for sheet in meta["sheets"]
             if sheet["properties"]["title"] in tabs]
    if "Entries" not in names:
        raise ValueError("Registration Entries tab missing")
    data = service.values().batchGet(
        spreadsheetId=sheet_id, ranges=[f"'{name}'" for name in names],
        valueRenderOption="FORMATTED_VALUE",
    ).execute()
    return {name: block.get("values", []) for name, block in zip(names, data["valueRanges"], strict=True)}


def require_pause():
    script = (firebase_db.ROOT / "register.js").read_text(encoding="utf-8")
    match = re.search(r'^const ENDPOINT = "([^"]+)";', script, re.M)
    if not match:
        raise ValueError("The registration endpoint is missing from register.js")
    request = Request(match[1], data=urlencode({"action": "paymentBalances", "id": "x"}).encode("ascii"))
    with urlopen(request, timeout=30) as response:
        if json.load(response).get("maintenance") is not True:
            raise ValueError("Set REGISTRATION_MAINTENANCE=1 on the deployed registration script before applying")


def apply(db, update, read_source, rebuild=False):
    require_pause()
    current = db.get("registrationData") or {}
    active = current.get("active") is True
    if rebuild:
        if not active or current.get("tables") != update["tables"]:
            raise ValueError("Active Firebase source changed or is missing. Preview and retry.")
        db.put("registrationData/paymentLookup", update["paymentLookup"])
        if (db.get("registrationData/paymentLookup") or {}) != update["paymentLookup"]:
            raise ValueError("Payment lookup readback failed")
        return
    if active:
        raise ValueError("Firebase registration is already active. Use --rebuild-lookup to rebuild its index.")
    if any(key in current and current[key] != value for key, value in update.items()):
        raise ValueError("An incomplete migration contains different rows. Compare it with the sheet before retrying.")
    if read_source() != update:
        raise ValueError("The registration sheet changed. Keep writes paused and retry.")
    db.patch("registrationData", update)
    saved = db.get("registrationData") or {}
    if any((saved.get(key) or {}) != value for key, value in update.items()):
        raise ValueError("Registration migration readback failed")
    if read_source() != update:
        raise ValueError("The registration sheet changed after copying. Compare the staged rows before activating.")
    require_pause()
    db.patch("registrationData", {"active": True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--sheet-id", help="ID of the spreadsheet bound to the registration web app")
    source.add_argument("--rebuild-lookup", action="store_true", help="rebuild from the active Firebase tables")
    parser.add_argument("--apply", action="store_true", help="write and verify the migration. The default is a preview.")
    args = parser.parse_args()

    try:
        db = firebase_db.connect() if args.apply or args.rebuild_lookup else None
        if args.rebuild_lookup:
            def read_source():
                current = db.get("registrationData") or {}
                if current.get("active") is not True:
                    raise ValueError("Registration is not active in Firebase")
                return prepare(current["tables"], "--rebuild-lookup")
        else:
            from googleapiclient.discovery import build
            from google_auth import credentials
            service = build("sheets", "v4", credentials=credentials("sheets"), cache_discovery=False).spreadsheets()

            def read_source():
                return prepare(read_tabs(service, args.sheet_id))

        update = read_source()
        for key, table in update["tables"].items():
            print(f"{key}: {len(table.get('rows', {}))} rows")
        print(f"{len(update['paymentLookup'])} payment lookup groups")
        if args.apply:
            apply(db, update, read_source, args.rebuild_lookup)
            print("Firebase data verified. Set REGISTRATION_STORAGE=firebase and PAYMENT_LOOKUP_VERSION=1 before resuming writes.")
        else:
            print("Preview only. No data written.")
    except subprocess.CalledProcessError:
        sys.exit("Could not prepare the local migration from the registration source.")
    except ValueError as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
