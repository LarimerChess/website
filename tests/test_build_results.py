"""Tests for scripts/build_results.py: the round cells, standings, quads, arenas, and the pages it keeps.

    python -m unittest discover tests

The fixtures are a Saturday Swiss and a club night's monthly Swiss between them with a
half-point bye, full-point byes, forfeits one way and both ways, a late entrant, and two
withdrawals; a quad tournament; an arena; a Swiss in two sections, Open and Under 1400, with a
player playing up; and a tournament still running.
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
from build_pages import ARCHIVED, LAST_EVENT  # noqa: E402

FIXTURES = HERE / "fixtures" / "tournaments.json"
TOURNAMENTS = {t["key"]: t for t in json.loads(FIXTURES.read_text(encoding="utf-8"))["tournaments"]}
SATURDAY = TOURNAMENTS["first-saturday-classic/2026-11-07"]
CLUB_NIGHT = TOURNAMENTS["monday-club-night-at-peak/2026-10"]
QUAD = TOURNAMENTS["fourth-saturday-classic/2027-01-23"]
ARENA = TOURNAMENTS["knightmare-arena-classical/2026-10-31"]
SECTIONS = TOURNAMENTS["second-saturday-sections/2026-12-12"]


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
        # Rated games only: Ben's win over the unrated Eli doesn't count, nor Dee's forfeit win or anyone's bye.
        self.assertEqual([r["performance"] for r in rows], [1841, 1796, 1000, 925, 850])
        # Each round by the opponent's place in these standings: Ada (2nd) beat Cal, 4th, with White.
        self.assertEqual(br.round_cells(SATURDAY, rows)["90000001"], ["W4 w", "D1 b", "W3 w", "H"])
        # Eli, unrated, lost only to Ben, so he lands 400 below Ben's intermediate (step 4) rating, 1674.
        self.assertEqual([r["estimate"] for r in rows], [1671, 1802, 1396, 1482, 1274])

    def test_club_night_order(self):
        self.assertEqual([r["name"] for r in br.standings(CLUB_NIGHT)],
                         ["Pat Pine", "Tia Tamarack", "Quinn Quaking", "Sam Spruce", "Rae Redwood"])

    def test_page(self):
        page = br.results_page(CLUB_NIGHT)
        self.assertIn('<link rel="canonical" href="https://larimerchess.org/results/monday-club-night-at-peak-2026-10/">', page)
        self.assertIn("Sam Spruce withdrew from round 3.", page)
        self.assertIn('<th scope="col">Round 3</th><th scope="col">Score</th><th scope="col">Median</th>', page)
        self.assertIn('<th scope="col">Opp. cumulative</th><th scope="col">Performance</th>', page)
        # The withdrawal, what performance means, the event's page, and the link to all results.
        self.assertEqual(page.split("<main")[1].split("</main>")[0].count("<p>"), 4)
        self.assertIn('<a href="/events/monday-club-night-at-peak/">About this event</a>', page)
        self.assertIn(f'data-results="{br.fingerprint(CLUB_NIGHT)}"', page)
        self.assertIn('<h1>Results</h1>', br.index_page())
        self.assertNotIn("@", page.split("<main")[1].split("</main>")[0])
        self.assertNotIn("ratings.uschess.org", page)

    def test_dated_by_us_chess(self):
        days = {"start": "2026-11-01", "end": "2026-11-07"}
        self.assertEqual(br.dated_name(SATURDAY, days), "First Saturday Classic, November 1–7, 2026")
        self.assertEqual(br.dated_name(SATURDAY, None), SATURDAY["name"])
        self.assertEqual(br.dated_name(SATURDAY, {"start": "2026-11-07", "end": "2026-11-07"}), SATURDAY["name"])
        self.assertEqual(br.dated_name(CLUB_NIGHT, {"start": "2026-10-05", "end": "2026-10-26"}),
                         "Monday Club Night at Peak, October 5–26, 2026")
        page = br.results_page(SATURDAY, days=days)
        self.assertIn("<title>First Saturday Classic, November 1–7, 2026 results</title>", page)
        self.assertIn("<h1>First Saturday Classic, November 1–7, 2026</h1>", page)
        self.assertIn('content="Final standings of the First Saturday Classic, November 1–7, 2026, a US Chess', page)
        self.assertIn('<link rel="canonical" href="https://larimerchess.org/results/first-saturday-classic-2026-11-07/">', page)

    def test_links_the_rated_event(self):
        self.assertIn('US Chess rated it as event <a href="https://ratings.uschess.org/event/202611070123"',
                      br.results_page(SATURDAY))


class Quads(unittest.TestCase):
    def test_groups_and_tiebreaks(self):
        # Started before sections: a quad for each four numbers, numbered 1 to 4 within it.
        quads = br.sections(QUAD)
        self.assertEqual([q["name"] for q in quads], ["Quad 1", "Quad 2"])
        second = quads[1]
        self.assertEqual([p["number"] for p in second["players"]], [1, 2, 3, 4])
        self.assertEqual(sum(len(r["games"]) for r in second["rounds"]), 6)
        rows = {r["id"]: r for r in br.standings(second, "quadStandings")}
        self.assertEqual((rows["90000045"]["score"], rows["90000045"]["sonnebornBerger"]), (2.5, 2.25))
        self.assertEqual((rows["90000046"]["score"], rows["90000046"]["sonnebornBerger"]), (1.0, 0.0))  # a forfeit win adds nothing

    def test_page(self):
        page = br.results_page(QUAD)
        self.assertIn("<h2>Quad 1</h2>", page)
        self.assertIn("<h2>Quad 2</h2>", page)
        self.assertIn("<td>X4", page)
        self.assertEqual(page.count("<table"), 2)  # one per quad
        self.assertIn('Score</th><th scope="col">Sonneborn-Berger</th><th scope="col">Head-to-head</th><th scope="col">Performance</th></tr>', page)


class Sections(unittest.TestCase):
    def test_each_section_on_its_own(self):
        open_, under = br.sections(SECTIONS)
        self.assertEqual([p["name"] for p in open_["players"]], ["Ivy Ironwood", "Jo Juniper", "Kit Kapok", "Max Maple"])
        self.assertEqual([p["number"] for p in under["players"]], [1, 2, 3])
        self.assertEqual([r["name"] for r in br.standings(open_)], ["Jo Juniper", "Ivy Ironwood", "Max Maple", "Kit Kapok"])
        self.assertEqual([r["name"] for r in br.standings(under)], ["Lu Larch", "Ned Nutmeg", "Oz Olive"])

    def test_wall_charts_by_section_numbers(self):
        open_, under = br.sections(SECTIONS)
        self.assertEqual(cells(open_)[4], ["L2 w 0", "W3 b 1"])     # Max Maple, playing up
        self.assertEqual(cells(under), {1: ["W3 w 1", "W2 b 2"], 2: ["B 1", "L1 w 1"], 3: ["L1 b 0", "B 1"]})

    def test_page(self):
        page = br.results_page(SECTIONS)
        self.assertLess(page.index('<section id="open">'), page.index('<section id="under-1400">'))
        self.assertIn("<h2>Under 1400</h2>", page)
        self.assertIn('aria-label="Open standings"', page)
        self.assertEqual(page.count("<table"), 2)  # one per section


class Arena(unittest.TestCase):
    def test_scoring(self):
        board, scored, boards = br.arena_scores(ARENA)
        self.assertEqual([(p["name"], p["points"]) for p in board], [("Vic Vine", 9), ("Xan Yew", 2), ("Wren Willow", 1)])
        # Game 2: a Blood Pact win over an opponent who kept the full time; game 3: a third straight win.
        self.assertEqual([got for _, got, _ in scored], [[2, 0], [0, 3], [3, 0], [1, 1], [1, 1]])
        self.assertEqual([why for _, _, why in scored], ["", "time odds", "", "", ""])
        self.assertEqual(boards, [])
        page = br.arena_main(ARENA)
        self.assertIn("<th scope=\"col\">US Chess rated</th>", page)
        self.assertNotIn("Section", page)
        self.assertIn("No, time odds", page)

    def test_sections(self):
        t = json.loads(json.dumps(ARENA))
        t["sections"] = [{"name": "Classical", "timeControl": "G/30;+30", "rated": True},
                         {"name": "Blood Pact", "timeControl": "G/15;+15 against G/30;+30", "rated": False}]
        for g, section in zip(t["arena"], ["Classical", "Classical", "Blood Pact", "Classical", "Classical"]):
            g["section"] = section
        board, scored, boards = br.arena_scores(t)
        self.assertEqual([(p["name"], p["points"]) for p in board], [("Vic Vine", 9), ("Xan Yew", 2), ("Wren Willow", 1)])
        self.assertEqual([why for _, _, why in scored], ["", "time odds", "section not US Chess rated", "", ""])
        self.assertEqual([name for name, _ in boards], ["Classical", "Blood Pact"])
        self.assertEqual([(p["name"], p["points"]) for p in boards[1][1]], [("Vic Vine", 2), ("Wren Willow", 0), ("Xan Yew", 0)])
        page = br.arena_main(t)
        self.assertIn("<h2>Blood Pact, G/15;+15 against G/30;+30 (not US Chess rated)</h2>", page)
        self.assertIn("<th scope=\"col\">Section</th>", page)
        self.assertIn("No, section not US Chess rated", page)
        # The section is part of the fingerprint, as it is for a Swiss, so the archive's matches.
        self.assertNotEqual(br.fingerprint(t), br.fingerprint(ARENA))


class Fingerprint(unittest.TestCase):
    def test_changes_with_any_result(self):
        changed = json.loads(json.dumps(SATURDAY))
        changed["rounds"][0]["games"][0]["result"] = "1/2-1/2"
        self.assertNotEqual(br.fingerprint(SATURDAY), br.fingerprint(changed))
        self.assertEqual(br.fingerprint(SATURDAY), br.fingerprint(json.loads(json.dumps(SATURDAY))))

    def test_sections(self):
        # Without sections the lines are as they were, so an old tournament's hash doesn't move.
        blank = json.loads(json.dumps(SATURDAY))
        for p in blank["players"]:
            p["section"] = ""
        self.assertEqual(br.fingerprint(SATURDAY), br.fingerprint(blank))
        moved = json.loads(json.dumps(SECTIONS))
        moved["players"][4]["section"] = "Under 1400"
        self.assertNotEqual(br.fingerprint(SECTIONS), br.fingerprint(moved))


class Build(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        for name in ("pairing.js", "register.js", "results.js", "arena.js"):
            shutil.copy(HERE.parent / name, self.root / name)
        (self.root / "sitemap.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            "  <url><loc>https://larimerchess.org/pairings/</loc></url>\n"
            "  <url><loc>https://larimerchess.org/results/</loc></url>\n"
            "  <url><loc>https://larimerchess.org/scholastic/</loc></url>\n</urlset>\n", encoding="utf-8")
        (self.root / "ratings.json").write_text("{}\n", encoding="utf-8")
        self.saved = br.ROOT, br.RESULTS
        br.ROOT, br.RESULTS = self.root, self.root / "results"
        self.addCleanup(lambda: setattr(br, "ROOT", self.saved[0]) or setattr(br, "RESULTS", self.saved[1]))

    def run_with(self, tournaments):
        source = self.root / "in.json"
        source.write_text(json.dumps({"tournaments": tournaments}), encoding="utf-8")
        with redirect_stdout(StringIO()):
            br.main(["--from", str(source)])

    def test_listed_in_ratings_json_is_rated(self):
        running = dict(TOURNAMENTS["fourth-saturday-classic/2027-01-23"], status="running")
        (self.root / "ratings.json").write_text('{"fourth-saturday-classic/2027-01-23": "202701230042"}\n', encoding="utf-8")
        self.run_with([running])
        page = (self.root / "results/fourth-saturday-classic-2027-01-23/index.html").read_text(encoding="utf-8")
        self.assertIn("https://ratings.uschess.org/event/202701230042", page)

    def test_rated_only_and_never_deleted(self):
        # The club night's page comes from the calendar, as build_pages.py writes it.
        (self.root / "events/monday-club-night-at-peak").mkdir(parents=True)
        (self.root / "events/monday-club-night-at-peak/index.html").write_text(
            '<a href="/results/monday-club-night-at-peak-2026-10/">October 2026</a>', encoding="utf-8")
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

    def check_output(self):
        out = StringIO()
        with redirect_stdout(out), self.assertRaises(SystemExit):
            br.main(["--check"])
        return out.getvalue()

    def test_a_tournament_set_up_at_the_desk_gets_an_event_page(self):
        desk = dict(QUAD, key="desk-quad/2027-01-23", event="desk-quad", name="Desk Quad, Saturday, January 23, 2027",
                    timeControl="G/30;+10")
        self.run_with([desk])
        event = (self.root / "events/desk-quad/index.html").read_text(encoding="utf-8")
        self.assertIn(ARCHIVED, event)
        self.assertIn("<h1>Desk Quad</h1>", event)
        self.assertIn('<a href="/results/desk-quad-2027-01-23/">Saturday, January 23, 2027</a>', event)
        self.assertIn("<strong>Time control:</strong> G/30;+10.", event)
        last = json.loads(LAST_EVENT.search(event).group(1))
        self.assertEqual((last["start"], last["allDay"], last["place"], last["price"]), ("2027-01-23T00:00:00-07:00", True, {}, ""))
        self.assertIn('<a href="/events/desk-quad/">About this event</a>',
                      (self.root / "results/desk-quad-2027-01-23/index.html").read_text(encoding="utf-8"))
        # Once made, the page is build_pages.py's to keep, so a later run leaves it as it is.
        self.run_with([dict(desk, timeControl="G/45;d5")])
        self.assertEqual((self.root / "events/desk-quad/index.html").read_text(encoding="utf-8"), event)
        with redirect_stdout(StringIO()):
            br.main(["--check"])
        (self.root / "events/desk-quad/index.html").unlink()
        self.assertIn("results/desk-quad-2027-01-23/: events/desk-quad/ has no page", self.check_output())

    def test_us_chess_days_on_the_page_the_list_and_the_event_page(self):
        desk = dict(QUAD, key="desk-quad/2027-01-23", event="desk-quad", name="Desk Quad, Saturday, January 23, 2027")
        (self.root / "rated-dates.json").write_text(
            '{"desk-quad/2027-01-23": {"start": "2027-01-16", "end": "2027-01-23"}}\n', encoding="utf-8")
        self.run_with([desk, SATURDAY])
        page = (self.root / "results/desk-quad-2027-01-23/index.html").read_text(encoding="utf-8")
        self.assertIn("<h1>Desk Quad, January 16–23, 2027</h1>", page)
        index = (self.root / "results/index.html").read_text(encoding="utf-8")
        self.assertIn('<tr><td><time datetime="2027-01-16">January 16</time>–&#8288;<time datetime="2027-01-23">23, 2027</time></td>'
                      '<td><a href="/results/desk-quad-2027-01-23/">Desk Quad, January 16–23, 2027</a></td></tr>', index)
        self.assertIn('<tr><td><time datetime="2026-11-07">November 7, 2026</time></td>'
                      '<td><a href="/results/first-saturday-classic-2026-11-07/">First Saturday Classic, Saturday, November 7, 2026</a>',
                      index)
        event = (self.root / "events/desk-quad/index.html").read_text(encoding="utf-8")
        self.assertIn('<a href="/results/desk-quad-2027-01-23/">January 16–23, 2027</a>', event)
        self.assertIn("<h2>Details from January 16–23, 2027</h2>", event)
        self.assertEqual(json.loads(LAST_EVENT.search(event).group(1))["start"], "2027-01-23T00:00:00-07:00")

    def test_a_club_nights_month_gets_no_page_made_up(self):
        self.run_with([CLUB_NIGHT])
        self.assertFalse((self.root / "events/monday-club-night-at-peak").exists())
        self.assertIn("events/monday-club-night-at-peak/ has no page", self.check_output())

    def test_an_event_page_written_after_its_results_fails_the_check_until_rebuilt(self):
        self.run_with([SATURDAY])
        (self.root / "results/first-saturday-classic-2026-11-07/index.html").write_text("<h1>First</h1>", encoding="utf-8")
        self.assertIn("doesn't link events/first-saturday-classic/", self.check_output())


class LastEvent(unittest.TestCase):
    def test_sections_with_their_own_time_controls(self):
        t = {"key": "alley-cat-quad-2/2026-10-17", "name": "Alley Cat Quad #2, Saturday, October 17, 2026",
             "format": "quad", "rounds": [{}] * 6, "plannedRounds": 6, "timeControl": "G/15;+30",
             "sections": [{"name": "First Weekend Closed", "timeControl": "G/30;+10"}, {"name": "Second Weekend Closed"}]}
        e = br.last_event(t)
        self.assertEqual(e["title"], "Alley Cat Quad #2")
        self.assertEqual(e["page"], "/events/alley-cat-quad-2/")
        self.assertEqual(e["description"], "A US Chess rated quad tournament in two sections:\n"
                                           "• First Weekend Closed, G/30;+10\n• Second Weekend Closed, G/15;+30")

    def test_one_time_control_for_every_section(self):
        t = {"key": "x/2026-12-12", "name": "X, Saturday, December 12, 2026", "format": "swiss", "rounds": [{}, {}],
             "timeControl": "G/60;d5", "sections": [{"name": "Open"}, {"name": "Under 1400"}, {"name": "Under 1000"}]}
        self.assertEqual(br.last_event(t)["description"],
                         "Time control: G/60;d5.\n\nA US Chess rated 2-round Swiss in three sections: Open, Under 1400, and Under 1000.")


if __name__ == "__main__":
    unittest.main()
