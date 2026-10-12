"""Tests for scripts/archive_tournaments.py: its archive, and the fingerprint the results pages carry.

    python -m unittest discover tests

fixtures/sheets.json holds the spreadsheet rows behind fixtures/tournaments.json, which is what
the registration script's ?tournaments=current makes of them.
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE.parent / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


at = load("archive_tournaments")
br = load("build_results")
SHEETS = at.read_fixture(HERE / "fixtures" / "sheets.json")
TOURNAMENTS = {t["key"]: t for t in json.loads((HERE / "fixtures" / "tournaments.json").read_text(encoding="utf-8"))["tournaments"]}


class Fingerprint(unittest.TestCase):
    def test_matches_the_results_page(self):
        for key in ["first-saturday-classic/2026-11-07", "monday-club-night-at-peak/2026-10",
                    "knightmare-arena-classical/2026-10-31", "second-saturday-sections/2026-12-12"]:
            with self.subTest(key):
                self.assertEqual(at.fingerprint(at.collect(key, SHEETS)), br.fingerprint(TOURNAMENTS[key]))

    def test_rebuilds_the_results_page(self):
        """A page rewritten from its archive shows what the page written from the script showed."""
        for key in ["first-saturday-classic/2026-11-07", "monday-club-night-at-peak/2026-10",
                    "knightmare-arena-classical/2026-10-31", "second-saturday-sections/2026-12-12"]:
            with self.subTest(key):
                rated = {**TOURNAMENTS[key], "status": "rated", "usChessEvent": "202611070001"}
                rebuilt = {**br.from_archive(at.collect(key, SHEETS)), "status": "rated", "usChessEvent": "202611070001"}
                self.assertEqual(br.results_page(rebuilt), br.results_page(rated))


class Archive(unittest.TestCase):
    def test_keeps_only_the_tournament_spreadsheet(self):
        record = at.collect("first-saturday-classic/2026-11-07", SHEETS)
        self.assertEqual(set(record), {"key", "tournament", "players", "rounds", "arena"})
        self.assertNotIn("_row", record["players"][0])

    def test_writes_beside_the_results_page_once(self):
        record = at.collect("knightmare-arena-classical/2026-10-31", SHEETS)
        with tempfile.TemporaryDirectory() as out, redirect_stdout(StringIO()) as log:
            at.archive(record, Path(out), dry_run=False)
            at.archive(record, Path(out), dry_run=False)
            stored = Path(out) / "results" / "knightmare-arena-classical-2026-10-31" / "archive.json"
            self.assertEqual(json.loads(stored.read_text(encoding="utf-8")), record)
        self.assertIn("up to date", log.getvalue().splitlines()[-1])


if __name__ == "__main__":
    unittest.main()
