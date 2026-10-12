"""Tests for the Firebase database scripts: database.rules.json, scripts/firebase_rules.py,
scripts/migrate_tournaments.py, and scripts/archive_tournaments.py reading and clearing the database.

    python -m unittest discover tests

FakeFirebase answers the database's REST API from a dict in place of urllib.request.urlopen.
"""

import copy
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.parse
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE.parent / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


import firebase_db  # noqa: E402

at = load("archive_tournaments")
migrate = load("migrate_tournaments")
rules = load("firebase_rules")
FIXTURE = HERE / "fixtures" / "sheets.json"
SHEETS = at.read_fixture(FIXTURE)
KEYS = [r["Key"] for r in at.rows(SHEETS, "Tournaments")]
ARENA = "knightmare-arena-classical/2026-10-31"
URL = "https://lccc-test.firebaseio.com"


class Creds:
    valid, token = True, "test-token"


def prune(value):
    """Drops what the database drops: nulls and empty objects."""
    if not isinstance(value, dict):
        return value
    kept = {k: prune(v) for k, v in value.items()}
    return {k: v for k, v in kept.items() if v is not None and v != {}} or None


class FakeFirebase:
    def __init__(self, data=None):
        self.data, self.rules, self.writes = copy.deepcopy(data or {}), None, []

    def __call__(self, request, timeout=None):
        assert request.headers["Authorization"] == "Bearer test-token"
        url = urllib.parse.urlsplit(request.full_url)
        assert url.path.endswith(".json") and request.full_url.startswith(URL + "/")
        parts = [p for p in url.path.removesuffix(".json").split("/") if p]
        body = json.loads(request.data) if request.data else None
        method = request.get_method()
        if method != "GET":
            self.writes.append((method, "/".join(parts), body))
        if parts[:1] == [".settings"]:
            if method == "PUT":
                self.rules = body
            answer = self.rules
        elif method == "GET":
            answer = self.at(parts)
            if "shallow=true" in url.query and isinstance(answer, dict):
                answer = {k: True for k in answer}
        elif method == "PUT":
            self.set(parts, body)
            answer = body
        elif method == "PATCH":
            for path, value in body.items():
                self.set(parts + path.split("/"), value)
            answer = body
        return io.BytesIO(json.dumps(answer).encode())

    def at(self, parts):
        node = self.data
        for p in parts:
            if not isinstance(node, dict) or p not in node:
                return None
            node = node[p]
        return copy.deepcopy(node)

    def set(self, parts, value):
        node = self.data
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = copy.deepcopy(value)
        self.data = prune(self.data) or {}


def database(fake):
    patcher = mock.patch("urllib.request.urlopen", fake)
    patcher.start()
    return firebase_db.Database(URL, Creds()), patcher


def migrated(**extra):
    return {"tables": migrate.tables_of(SHEETS), **extra}


def quiet(function, *args, argv=None, **kwargs):
    with redirect_stdout(io.StringIO()) as out, mock.patch.object(sys, "argv", ["script", *(argv or [])]):
        function(*args, **kwargs)
    return out.getvalue()


class Rules(unittest.TestCase):
    FILE = json.loads((HERE.parent / "database.rules.json").read_text(encoding="utf-8"))

    def test_only_public_and_changes_are_readable_and_nothing_writable(self):
        self.assertEqual(self.FILE, {"rules": {".read": False, ".write": False,
                                               "public": {".read": True}, "changes": {".read": True}}})

    def test_applies_then_checks(self):
        fake = FakeFirebase()
        db, patcher = database(fake)
        self.addCleanup(patcher.stop)
        with mock.patch.object(firebase_db, "connect", lambda: db):
            quiet(rules.main, argv=["--dry-run"])
            self.assertIsNone(fake.rules)
            quiet(rules.main)
            self.assertEqual(fake.rules, self.FILE)
            self.assertEqual(fake.writes, [("PUT", ".settings/rules", self.FILE)])
            fake.rules = {"rules": {".read": True}}
            with self.assertRaises(SystemExit):
                quiet(rules.main, argv=["--check"])
            self.assertEqual(len(fake.writes), 1)


class Names(unittest.TestCase):
    def test_fields_survive_the_database(self):
        self.assertEqual(firebase_db.encode_field("No."), "No%2E")
        for name in ["No.", "US Chess ID", "a.b$c#d[e]f/g%h", "100%2E"]:
            self.assertNotRegex(firebase_db.encode_field(name), r"[.$#\[\]/]")
            self.assertEqual(firebase_db.decode_field(firebase_db.encode_field(name)), name)

    def test_url_from_the_environment_or_register_js(self):
        with mock.patch.dict(os.environ, {"LCCC_FIREBASE_URL": URL + "/"}):
            self.assertEqual(firebase_db.database_url(), URL)
        with mock.patch.dict(os.environ, {"LCCC_FIREBASE_URL": ""}):
            self.assertEqual(firebase_db.database_url(), "")
        with tempfile.TemporaryDirectory() as root, mock.patch.dict(os.environ), \
                mock.patch.object(firebase_db, "ROOT", Path(root)):
            os.environ.pop("LCCC_FIREBASE_URL", None)
            (Path(root) / "register.js").write_text('const ENDPOINT = "x";\n', encoding="utf-8")
            self.assertEqual(firebase_db.database_url(), "")
            (Path(root) / "register.js").write_text(f'const ENDPOINT = "x";\nconst LIVE_DB = "{URL}";\n')
            self.assertEqual(firebase_db.database_url(), URL)


class Migrate(unittest.TestCase):
    def test_rows_go_by_heading_in_sheet_order(self):
        tables = migrate.tables_of(SHEETS)
        self.assertEqual(set(tables), {"Tournaments", "Players", "Rounds", "Arena"})
        for tab, (_, sheet_rows) in SHEETS.items():
            with self.subTest(tab):
                ids = sorted(tables[tab])
                self.assertEqual(ids, [f"r{r['_row']:06d}" for r in sheet_rows])
                self.assertEqual([firebase_db.decode_row(tables[tab][i]) for i in ids],
                                 [at.clean(r) for r in sheet_rows])
        first = tables["Players"]["r000002"]
        self.assertEqual((first["Key"], first["No%2E"], first["Out from round"]),
                         ("first-saturday-classic/2026-11-07", "1", ""))

    def test_queues_are_json_strings_by_node(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "queues.json"
            path.write_text(json.dumps({ARENA: [{"id": "90000021", "since": 1793462400000}], "quiet/2026-12": []}))
            self.assertEqual(migrate.queues_of(path), {
                "knightmare-arena-classical:2026-10-31": '[{"id":"90000021","since":1793462400000}]',
                "quiet:2026-12": "[]",
            })

    def test_writes_and_reads_back(self):
        fake = FakeFirebase({"changes": {"entries": "1"}})
        db, patcher = database(fake)
        self.addCleanup(patcher.stop)
        update = migrated(queues={"knightmare-arena-classical:2026-10-31": "[]"})
        quiet(migrate.write, db, update, replace=False, dry_run=True)
        self.assertEqual(fake.writes, [])
        quiet(migrate.write, db, update, replace=False, dry_run=False)
        self.assertEqual(fake.data, {**update, "changes": {"entries": "1"}})
        self.assertNotIn("public", fake.data)

    def test_refuses_rows_already_there_unless_replace(self):
        fake = FakeFirebase({"tables": {"Players": {"s0": {"Key": "x"}}}})
        db, patcher = database(fake)
        self.addCleanup(patcher.stop)
        with self.assertRaises(SystemExit):
            quiet(migrate.write, db, migrated(), replace=False, dry_run=False)
        self.assertEqual(fake.writes, [])
        quiet(migrate.write, db, migrated(), replace=True, dry_run=False)
        self.assertEqual(fake.data, migrated())

    def test_fixture_only_to_a_file(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / "db.json"
            quiet(migrate.main, argv=["--fixture", str(FIXTURE), "--out", str(out)])
            self.assertEqual(json.loads(out.read_text(encoding="utf-8")), migrated())
        with self.assertRaises(SystemExit):
            quiet(migrate.main, argv=["--fixture", str(FIXTURE)])


class ArchiveFromTheDatabase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeFirebase({
            **migrated(queues={"knightmare-arena-classical:2026-10-31": "[]", "third-saturday-slow:2026-11-21": "[]"}),
            "public": {"tournaments": {firebase_db.node(k): "{}" for k in KEYS}},
            "changes": {"entries": "1", "tournaments": "2"},
        })
        self.db, patcher = database(self.fake)
        self.addCleanup(patcher.stop)

    def test_same_archive_and_fingerprint_as_the_spreadsheet(self):
        book = at.read_database(self.db)
        with tempfile.TemporaryDirectory() as sheet, tempfile.TemporaryDirectory() as db:
            for key in KEYS:
                with self.subTest(key):
                    from_sheet, from_db = at.collect(key, SHEETS), at.collect(key, book)
                    self.assertEqual(at.fingerprint(from_db), at.fingerprint(from_sheet))
                    quiet(at.archive, from_sheet, Path(sheet), dry_run=False)
                    quiet(at.archive, from_db, Path(db), dry_run=False)
                    self.assertEqual(at.archive_path(Path(db), key).read_bytes(),
                                     at.archive_path(Path(sheet), key).read_bytes())

    def test_new_rows_sort_after_migrated_ones(self):
        self.fake.data["tables"]["Arena"]["smgxk2a4p000"] = {"Key": ARENA, "Game": "9", "White": "1", "Black": "2"}
        arena = at.rows(at.read_database(self.db), "Arena")
        self.assertEqual((arena[-1]["Game"], arena[-1]["Result"]), ("9", ""))

    def run_clear(self, ready):
        with tempfile.TemporaryDirectory() as folder:
            out, ratings = Path(folder), Path(folder) / "ratings.json"
            ratings.write_text(json.dumps({ARENA: "202610310001"}))
            quiet(at.archive, at.collect(ARENA, SHEETS), out, dry_run=False)
            with mock.patch.dict(os.environ, {"LCCC_FIREBASE_URL": URL}), \
                    mock.patch.object(firebase_db, "connect", lambda: self.db), \
                    mock.patch.object(at, "committed_and_pushed", lambda out, key: None if ready else "not pushed"), \
                    mock.patch.object(at, "published", lambda key, expected: None):
                return quiet(at.main, argv=["--clear", "--ratings", str(ratings), "--out", str(out)])

    def test_clear_waits_for_the_archive_to_be_pushed(self):
        log = self.run_clear(ready=False)
        self.assertIn("kept in the database", log)
        self.assertEqual(self.fake.writes, [])

    def test_clear_deletes_only_that_tournament(self):
        before = copy.deepcopy(self.fake.data)
        self.run_clear(ready=True)
        self.assertEqual(len(self.fake.writes), 1)
        node = firebase_db.node(ARENA)
        expected = copy.deepcopy(before)
        for tab in expected["tables"].values():
            for row_id in [i for i, r in tab.items() if r["Key"] == ARENA]:
                del tab[row_id]
        del expected["queues"][node], expected["public"]["tournaments"][node]
        self.assertEqual(self.fake.data, prune(expected))
        self.assertNotIn("Arena", self.fake.data["tables"])
        self.assertEqual(self.fake.data["changes"], before["changes"])

    def test_clear_dry_run_changes_nothing(self):
        log = io.StringIO()
        with redirect_stdout(log):
            at.clear_database(ARENA, self.db, dry_run=True)
        self.assertEqual(self.fake.writes, [])
        self.assertIn("would delete 1 from Tournaments, 3 from Players, 5 from Arena,", log.getvalue())


if __name__ == "__main__":
    unittest.main()
