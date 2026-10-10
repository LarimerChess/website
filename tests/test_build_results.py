"""Tests for scripts/build_results.py: the wall chart, standings, quads, arenas, and the pages it keeps.

    python -m unittest discover tests

The fixtures are a Saturday Swiss and a club night's monthly Swiss between them with a
half-point bye, full-point byes, forfeits one way and both ways, a late entrant, and two
withdrawals; a quad tournament; an arena; and a tournament still running.
"""

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
spec = importlib.util.spec_from_file_location("build_results", HERE.parent / "scripts" / "build_results.py")
br = importlib.util.module_from_spec(spec)
spec.loader.exec_module(br)

FIXTURES = HERE / "fixtures" / "tournaments.json"
TOURNAMENTS = {t["key"]: t for t in json.loads(FIXTURES.read_text(encoding="utf-8"))["tournaments"]}
SATURDAY = TOURNAMENTS["first-saturday-classic/2026-11-07"]
CLUB_NIGHT = TOURNAMENTS["monday-club-night-at-peak/2026-10"]
QUAD = TOURNAMENTS["fourth-saturday-classic/2027-01-23"]
ARENA = TOURNAMENTS["knightmare-arena-classical/2026-10-31"]


def cells(t):
    """Each player's wall chart as strings, such as 'W3 w 1'."""
    chart = br.wall_chart(t)
    by_number = {p["number"]: p["id"] for p in t["players"]}
    return {n: [f"{code}{opponent or ''} {color + ' ' if color else ''}{br.score_text(score)}"
                for code, opponent, color, score in chart[pid]] for n, pid in by_number.items()}


class WallChart(unittest.TestCase):
    def test_saturday(self):
        self.assertEqual(cells(SATURDAY), {
            1: ["W3 w 1", "D2 b 1½", "W4 w 2½", "H 3"],
            2: ["W5 b 1", "D1 w 1½", "W3 b 2½", "B 3½"],
            3: ["L1 b 0", "B 1", "L2 w 1", "F4 1"],          # a double forfeit is a loss for both
            4: ["B 1", "X5 2", "L1 b 2", "F3 2"],            # a forfeit win has no color
            5: ["L2 w 0", "F4 0", "U 0", "U 0"],             # withdrew from round 3
        })

    def test_club_night(self):
        self.assertEqual(cells(CLUB_NIGHT), {
            1: ["W3 w 1", "H 1½", "W2 w 2½"],
            2: ["D4 w ½", "X3 1½", "L1 b 1½"],
            3: ["L1 b 0", "F2 0", "U 0"],                    # absent: a zero-point bye
            4: ["D2 b ½", "L5 w ½", "U ½"],
            5: ["U 0", "W4 b 1", "B 2"],                     # entered in round 2
        })

    def test_score_text(self):
        self.assertEqual([br.score_text(x) for x in (0, 0.5, 1, 3.5, 10)], ["0", "½", "1", "3½", "10"])


class Standings(unittest.TestCase):
    def test_from_pairing_js(self):
        rows = br.standings(SATURDAY)
        self.assertEqual([r["name"] for r in rows], ["Ben Birch", "Ada Alder", "Dee Dogwood", "Cal Cedar", "Eli Elm"])
        self.assertEqual([r["score"] for r in rows], [3.5, 3, 2, 1, 0])

    def test_club_night_order(self):
        self.assertEqual([r["name"] for r in br.standings(CLUB_NIGHT)],
                         ["Pat Pine", "Tia Tamarack", "Quinn Quaking", "Sam Spruce", "Rae Redwood"])

    def test_page(self):
        page = br.results_page(CLUB_NIGHT)
        self.assertIn('<link rel="canonical" href="https://larimerchess.org/results/monday-club-night-at-peak-2026-10/">', page)
        self.assertIn('<time datetime="2026-10">October 2026</time>', page)
        self.assertIn("Sam Spruce withdrew from round 3.", page)
        self.assertIn(f'data-results="{br.fingerprint(CLUB_NIGHT)}"', page)
        self.assertIn('<h1>Results</h1>', br.index_page())
        self.assertNotIn("@", page.split("<main")[1].split("</main>")[0])


class Quads(unittest.TestCase):
    def test_groups_and_tiebreaks(self):
        self.assertEqual(sorted({br.quad(p) for p in QUAD["players"]}), [1, 2])
        second = br.within(QUAD, {p["id"] for p in QUAD["players"] if br.quad(p) == 2})
        self.assertEqual(len(second["players"]), 4)
        rows = {r["id"]: r for r in br.standings(second, "quadStandings")}
        self.assertEqual((rows["90000045"]["score"], rows["90000045"]["sonnebornBerger"]), (2.5, 2.25))
        self.assertEqual((rows["90000046"]["score"], rows["90000046"]["sonnebornBerger"]), (1.0, 0.0))  # a forfeit win adds nothing

    def test_page(self):
        page = br.results_page(QUAD)
        self.assertIn("<h2>Quad 1</h2>", page)
        self.assertIn("<h2>Quad 2</h2>", page)
        self.assertIn("X8 <small>1</small>", page)


class Arena(unittest.TestCase):
    def test_scoring(self):
        board, scored = br.arena_scores(ARENA)
        self.assertEqual([(p["name"], p["points"]) for p in board], [("Vic Vine", 9), ("Xan Yew", 2), ("Wren Willow", 1)])
        # Game 2: a Blood Pact win over an opponent who kept the full time; game 3: a third straight win.
        self.assertEqual([got for _, got in scored], [[2, 0], [0, 3], [3, 0], [1, 1], [1, 1]])


class Fingerprint(unittest.TestCase):
    def test_changes_with_any_result(self):
        changed = json.loads(json.dumps(SATURDAY))
        changed["rounds"][0]["games"][0]["result"] = "1/2-1/2"
        self.assertNotEqual(br.fingerprint(SATURDAY), br.fingerprint(changed))
        self.assertEqual(br.fingerprint(SATURDAY), br.fingerprint(json.loads(json.dumps(SATURDAY))))


class Build(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        for name in ("pairing.js", "register.js"):
            shutil.copy(HERE.parent / name, self.root / name)
        (self.root / "sitemap.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            "  <url><loc>https://larimerchess.org/pairings/</loc></url>\n"
            "  <url><loc>https://larimerchess.org/results/</loc></url>\n"
            "  <url><loc>https://larimerchess.org/scholastic/</loc></url>\n</urlset>\n", encoding="utf-8")
        self.saved = br.ROOT, br.RESULTS
        br.ROOT, br.RESULTS = self.root, self.root / "results"
        self.addCleanup(lambda: setattr(br, "ROOT", self.saved[0]) or setattr(br, "RESULTS", self.saved[1]))

    def run_with(self, tournaments):
        source = self.root / "in.json"
        source.write_text(json.dumps({"tournaments": tournaments}), encoding="utf-8")
        with redirect_stdout(StringIO()):
            br.main(["--from", str(source)])

    def test_finished_only_and_never_deleted(self):
        running = TOURNAMENTS["third-saturday-slow/2026-11-21"]
        self.run_with([SATURDAY, running])
        self.assertTrue((self.root / "results/first-saturday-classic-2026-11-07/index.html").exists())
        self.assertFalse((self.root / "results/third-saturday-slow-2026-11-21").exists())
        # The archive has cleared the Saturday from the spreadsheet; its page stays.
        self.run_with([CLUB_NIGHT])
        self.assertTrue((self.root / "results/first-saturday-classic-2026-11-07/index.html").exists())
        index = (self.root / "results/index.html").read_text(encoding="utf-8")
        self.assertLess(index.index("first-saturday-classic-2026-11-07"), index.index("monday-club-night-at-peak-2026-10"))
        sitemap = (self.root / "sitemap.xml").read_text(encoding="utf-8")
        self.assertLess(sitemap.index("/results/</loc>"), sitemap.index("/results/first-saturday"))
        self.assertLess(sitemap.index("/results/monday-club-night"), sitemap.index("/scholastic/"))
        self.assertEqual(sitemap.count("/results/first-saturday-classic-2026-11-07/"), 1)
        with redirect_stdout(StringIO()):
            br.main(["--check"])


if __name__ == "__main__":
    unittest.main()
