"""Tests for scripts/build_pages.py: dates, descriptions, fees, Event data, and the sitemap.

    python -m unittest discover tests
"""

import importlib.util
import unittest
from unittest import mock
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "build_pages", Path(__file__).resolve().parent.parent / "scripts" / "build_pages.py")
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)

PEAK = {"name": "Peak Community Church", "street": "500 Mathews St", "city": "Fort Collins", "region": "CO", "zip": "80524"}
DESCRIPTION = """Cost: $15 entry, free for players under 18. If the fee is a hardship, pay what you can.
Time control: G/30;+30.

A monthly US Chess rated tournament at classical speed in Old Town Fort Collins.

Round times
• Round 1: 10:00 AM
• Round 2: 12:15 PM

Questions: president@larimerchess.org
larimerchess.org"""
CLASSIC = {"title": "First Saturday Classic", "organizer": bp.CLUB, "tags": ["tournament", "club"], "price": "15",
           "page": "/events/first-saturday-classic/", "start": "2026-11-07T10:00:00-07:00",
           "end": "2026-11-07T19:00:00-07:00", "allDay": False, "place": PEAK, "city": "Fort Collins",
           "location": "Peak Community Church, 500 Mathews St, Fort Collins, CO 80524, USA", "description": DESCRIPTION}
SITEMAP = """<url><loc>https://larimerchess.org/</loc></url>
<url><loc>https://larimerchess.org/events/</loc><lastmod>2026-10-01</lastmod></url>
<url><loc>https://larimerchess.org/events/old-tournament/</loc><lastmod>2026-09-01</lastmod></url>
<url><loc>https://larimerchess.org/events/first-saturday-classic/</loc><lastmod>2026-10-02</lastmod></url>
<url><loc>https://larimerchess.org/scholastic/</loc><lastmod>2026-10-01</lastmod></url>
<url><loc>https://larimerchess.org/minutes/</loc></url>"""



class Fees(unittest.TestCase):
    PRICES = {"club-night": [
        {"applies": "all", "kind": "night", "adult": 8, "senior": 8, "youth": 0},
        {"applies": "2026-10", "kind": "night", "adult": 7, "senior": 5, "youth": 0},
        {"applies": "2026-10-26", "kind": "night", "adult": 0, "senior": 0, "youth": 0},
        {"applies": "2026-10", "kind": "month", "adult": 15, "senior": 10, "youth": 2.5},
    ]}

    def test_the_most_specific_row_wins(self):
        fee = lambda value, kind="night": (bp.fee(self.PRICES, "club-night", kind, value) or {}).get("adult")
        self.assertEqual([fee("2026-10-26"), fee("2026-10-19"), fee("2026-11-02"), fee("2026-10", "month"),
                          fee("2026-11", "month")], [0, 7, 8, 15, None])

    FEES = {"round": 0.5, "card": {"percent": 2.5, "fixed": 0.5}}

    def test_wording(self):
        rows = self.PRICES["club-night"]
        text = lambda row, rounds=1: bp.fee_text(row, rounds, self.FEES)
        self.assertEqual([text(rows[0]), text(rows[1]), text(rows[2]), text(rows[3], 4), text(None)],
                         ["$8.50, reduced rate $0.50 under 18", "$7.50 adults, $5.50 seniors (65+), reduced rate $0.50 under 18",
                          "$0.50, reduced rate $0.50 under 18", "$17 adults, $12 seniors (65+), reduced rate $4.50 under 18",
                          "fee to be announced"])

    def test_an_arena_adds_its_games(self):
        row = {"applies": "all", "kind": "entry", "adult": 15, "senior": 15, "youth": 0}
        self.assertEqual(bp.fee_text(row, None, self.FEES), "$15 plus $0.50 a game played; reduced rate under 18, the games only")

    def test_rounds(self):
        night = {"start": "2026-10-12T18:30:00-06:00", "tags": ["casual"]}
        nights = [night, {**night, "start": "2026-10-19T18:30:00-06:00"}, {**night, "start": "2026-11-02T18:30:00-07:00"}]
        self.assertEqual([bp.rounds_of(night), bp.rounds_of(night, "2026-10", nights), bp.rounds_of({**CLASSIC, "rounds": "4"}),
                          bp.rounds_of({**CLASSIC, "pairing": "quad"}), bp.rounds_of({**CLASSIC, "pairing": "arena"})],
                         [1, 2, 4, 3, None])


class Dates(unittest.TestCase):
    def test_time_ranges_follow_the_style_guide(self):
        self.assertEqual(bp.when_text(CLASSIC), "Saturday, November 7, 2026, 10:00 AM – 7:00 PM")
        morning = {**CLASSIC, "end": "2026-11-07T11:30:00-07:00"}
        self.assertEqual(bp.when_text(morning), "Saturday, November 7, 2026, 10:00 – 11:30 AM")
        self.assertEqual(bp.when_text({**CLASSIC, "allDay": True}), "Saturday, November 7, 2026")


class Description(unittest.TestCase):
    def test_labels_lists_and_links(self):
        out = bp.description_html(DESCRIPTION)
        self.assertIn("<p><strong>Cost:</strong> $15 entry", out)
        self.assertIn("<p>Round times</p>\n      <ul><li>Round 1: 10:00 AM</li><li>Round 2: 12:15 PM</li></ul>", out)
        self.assertIn('<a href="mailto:president@larimerchess.org">president@larimerchess.org</a>', out)
        self.assertNotIn("<br>larimerchess.org", out)

    def test_outside_links_open_in_a_new_tab_and_hide_the_fragment(self):
        out = bp.linked("Join at https://new.uschess.org/join-us-chess#:~:text=Individual")
        self.assertIn('href="https://new.uschess.org/join-us-chess#:~:text=Individual" target="_blank"', out)
        self.assertIn(">new.uschess.org/join-us-chess<span", out)

    def test_summary_and_cost(self):
        self.assertEqual(bp.summary(CLASSIC), "A monthly US Chess rated tournament at classical speed in Old Town Fort Collins.")
        self.assertEqual(bp.cost(CLASSIC), "$15 entry, free for players under 18.")


class Invitational(unittest.TestCase):
    def test_registration_is_closed_but_entries_show(self):
        page = bp.register_html([{**CLASSIC, "tags": [*CLASSIC["tags"], "invitational"]}], {"fees": Fees.FEES})
        self.assertIn('data-invitational="yes"', page)
        self.assertIn('<p class="register-invitational">', page)
        self.assertIn('id="entries"', page)
        self.assertNotIn("data-invitational", bp.register_html([CLASSIC], {"fees": Fees.FEES}))


class EventData(unittest.TestCase):
    def test_tournaments_point_to_their_page(self):
        data = bp.event_data(CLASSIC)
        self.assertEqual(data["url"], "https://larimerchess.org/events/first-saturday-classic/")
        self.assertEqual(data["offers"]["url"], data["url"])
        self.assertEqual(data["location"]["address"]["streetAddress"], "500 Mathews St")
        club_night = bp.event_data({**CLASSIC, "page": "", "price": ""})
        self.assertEqual(club_night["url"], bp.EVENTS_PAGE)
        self.assertNotIn("offers", club_night)

    def test_script_cannot_be_closed_by_the_data(self):
        self.assertNotIn("</script><", bp.data_script([{**CLASSIC, "title": "</script><b>"}]))


class Sitemap(unittest.TestCase):
    def test_lastmod_moves_only_for_changed_pages(self):
        pages = {"events/first-saturday-classic/": "", "events/third-saturday-slow/": ""}
        edits = {"minutes/index.html": "2026-09-24", "scholastic/index.html": "2026-09-30", "index.html": "2026-10-05"}
        with mock.patch.object(bp, "content_changed", lambda path, today: edits[path]):
            out = bp.sitemap(SITEMAP, pages, {"events/": True}, "2026-10-08")
        self.assertEqual(out.count("<url>"), 6)
        self.assertNotIn("old-tournament", out)
        self.assertIn("events/</loc><lastmod>2026-10-08<", out)
        self.assertIn("first-saturday-classic/</loc><lastmod>2026-10-02<", out)
        self.assertIn("third-saturday-slow/</loc><lastmod>2026-10-08<", out)
        self.assertIn("scholastic/</loc><lastmod>2026-10-01<", out)
        self.assertIn("minutes/</loc><lastmod>2026-09-24<", out)
        self.assertIn("larimerchess.org/</loc><lastmod>2026-10-05<", out)

    def test_page_text_changes_count_but_styles_and_whitespace_do_not(self):
        with mock.patch.object(bp, "git_text", lambda spec: '<style>\nold</style><script src="calendar.js?v=1"></script>\n<p>Hi</p>'), \
             mock.patch.object(bp.Path, "read_text", lambda *_, **__: '<style>new</style><script src="calendar.js?v=2"></script> <p>Hi</p>'):
            self.assertIsNone(bp.content_changed("index.html", "2026-10-08"))
        with mock.patch.object(bp, "git_text", lambda spec: "<p>Hi</p>"), \
             mock.patch.object(bp.Path, "read_text", lambda *_, **__: "<p>Hello</p>"):
            self.assertEqual(bp.content_changed("index.html", "2026-10-08"), "2026-10-08")


if __name__ == "__main__":
    unittest.main()
