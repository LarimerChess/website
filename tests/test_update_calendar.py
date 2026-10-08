"""Tests for scripts/update_calendar.py: metadata to tags, failing on bad metadata, weekly, places.

    python -m unittest discover tests
"""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "update_calendar", Path(__file__).resolve().parent.parent / "scripts" / "update_calendar.py")
uc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uc)

PEAK = "Peak Community Church, 500 Mathews St, Fort Collins, CO 80524, USA"
CLUB_TOURNAMENT = {"organizer": uc.CLUB, "format": "tournament", "ages": "all", "rated": "yes",
                   "cost": "free-youth", "price": "15"}
MEETUP = {"organizer": "Fort Collins Chess Meetup", "format": "casual", "ages": "all", "rated": "no",
          "cost": "free", "details": "https://www.meetup.com/fort-collins-chess-meetup-group/"}


def item(title, meta, start="2026-11-07T10:00:00-07:00", end="2026-11-07T19:00:00-07:00", **extra):
    return {"summary": title, "location": PEAK, "start": {"dateTime": start}, "end": {"dateTime": end},
            "extendedProperties": {"private": {"source": "manual", **meta}}, **extra}


class Tags(unittest.TestCase):
    def test_baseline_series(self):
        # The tags each kind of event had when they were inferred from titles and descriptions.
        cases = [
            (CLUB_TOURNAMENT, ["tournament", "all-ages", "club", "rated", "free-youth"]),
            ({**CLUB_TOURNAMENT, "format": "casual", "price": None}, ["casual", "all-ages", "club", "rated", "free-youth"]),
            (MEETUP, ["casual", "all-ages", "free"]),
            ({"organizer": "Grand Slam Games and Comics", "format": "tournament", "ages": "all", "rated": "no",
              "cost": "paid"}, ["tournament", "all-ages"]),
            ({"organizer": "Chessmates", "format": "tournament", "ages": "youth", "rated": "yes", "cost": "paid"},
             ["tournament", "youth", "rated"]),
            ({"organizer": "Chessmates", "format": "other", "ages": "youth", "rated": "no", "cost": "paid"}, ["youth"]),
            ({"organizer": "Loveland Public Library", "format": "other", "ages": "youth", "rated": "no",
              "cost": "unknown"}, ["youth", "cost-unknown"]),
            ({"organizer": "Chilson Senior Center", "format": "casual", "ages": "senior", "rated": "no",
              "cost": "unknown"}, ["casual", "senior", "cost-unknown"]),
        ]
        for meta, tags in cases:
            meta = {k: v for k, v in meta.items() if v is not None}
            self.assertEqual(uc.problems(meta), [], meta)
            self.assertEqual(uc.describe(meta, "community")["tags"], tags, meta)

    def test_adults_only_is_not_all_ages(self):
        tags = uc.describe({**MEETUP, "ages": "adults"}, "community")["tags"]
        self.assertNotIn("all-ages", tags)
        self.assertNotIn("youth", tags)

    def test_title_and_description_do_not_matter(self):
        events = uc.build({"community": [item("Kids Blitz (youth) at a Bar, grades 1–5", MEETUP,
                                               description="US Chess rated. Entry fee: $20. Youth play free.")]})
        self.assertEqual(events[0]["tags"], ["casual", "all-ages", "free"])
        self.assertEqual(events[0]["price"], "")

    def test_organizer_details_and_price(self):
        d = uc.describe(CLUB_TOURNAMENT, "club")
        self.assertEqual((d["organizer"], d["url"], d["price"]), (uc.CLUB, "", "15"))
        d = uc.describe(MEETUP, "community")
        self.assertEqual((d["organizer"], d["url"]), ("Fort Collins Chess Meetup", MEETUP["details"]))

    def test_speed(self):
        self.assertEqual(uc.describe({**CLUB_TOURNAMENT, "speed": "regular,quick"}, "club")["tags"],
                         ["tournament", "all-ages", "club", "rated", "free-youth", "regular", "quick"])
        self.assertEqual(uc.problems({**MEETUP, "speed": "blitz"}), [])
        self.assertEqual(len(uc.problems({**MEETUP, "speed": "classical"})), 1)
        self.assertEqual(len(uc.problems({**MEETUP, "speed": "regular, quick"})), 1)

    def test_details_without_run_by(self):
        dcc = {"organizer": "Denver Chess Club", "format": "tournament", "ages": "all", "rated": "yes", "cost": "paid",
               "details": "https://coloradochess.com/tournament/dcc-fall-classic-2026/", "run_by": "hide"}
        self.assertEqual(uc.problems(dcc), [])
        fall_classic = {**item("Denver Chess Club – DCC Fall Classic 2026", dcc),
                        "start": {"date": "2026-10-24"}, "end": {"date": "2026-10-26"},
                        "location": "Hilton Garden Inn Denver Tech Center, 7675 E Union Ave, Denver, CO 80237"}
        [e] = uc.build({"club": [fall_classic]})
        self.assertEqual((e["organizer"], e["url"], e["city"]), ("", dcc["details"], "Denver"))
        self.assertEqual(e["tags"], ["tournament", "all-ages", "rated"])


class BadMetadata(unittest.TestCase):
    def test_problems(self):
        self.assertEqual(uc.problems({**MEETUP, "cost": "fre"}),
                         ["cost is 'fre', expected one of free, free-youth, paid, unknown"])
        missing = {k: v for k, v in MEETUP.items() if k != "ages"}
        self.assertEqual(uc.problems(missing), ["ages is missing"])
        self.assertEqual(uc.problems({**CLUB_TOURNAMENT, "price": "$15"}), ["price is '$15', expected \\d+(?:\\.\\d\\d)?"])
        self.assertEqual(uc.problems({**CLUB_TOURNAMENT, "rated": "no"}),
                         ["rated is 'no', but every club event is US Chess rated"])
        self.assertEqual(uc.problems({**CLUB_TOURNAMENT, "run_by": "hide"}),
                         ["run_by is 'hide', but the site finds club events by their organizer"])
        self.assertEqual(uc.problems({**MEETUP, "run_by": "no"}), ["run_by is 'no', expected one of hide, show"])
        self.assertEqual(len(uc.problems({})), 5)

    def test_import_stops_and_names_the_event(self):
        good = item("First Saturday Classic", CLUB_TOURNAMENT)
        series = [item("New Thing", {**MEETUP, "cost": "maybe"}, start=f"2026-10-{d}T18:00:00-06:00",
                       end=f"2026-10-{d}T21:00:00-06:00", recurringEventId="abc") for d in (14, 21, 28)]
        bare = item("Unlabeled", {})
        with self.assertRaises(SystemExit) as stop:
            uc.build({"club": [good], "community": series + [bare]})
        message = str(stop.exception.code)
        self.assertIn("2 event(s)", message)
        self.assertIn("community calendar, 'New Thing' (2026-10-14 and 2 more date(s)): cost is 'maybe'", message)
        self.assertIn("'Unlabeled' (2026-11-07): organizer is missing; format is missing", message)
        self.assertNotIn("First Saturday Classic", message)

    def test_description(self):
        [e] = uc.build({"community": [item("Library", MEETUP, description="Thursdays 4:15 PM. Questions: 970-962-2665.")]})
        self.assertEqual(e["description"], "Thursdays 4:15 PM. Questions: 970-962-2665.")

    def test_private_and_cancelled_events_are_left_out_unchecked(self):
        events = uc.build({"club": [item("First Saturday Classic", CLUB_TOURNAMENT),
                                    item("Board meeting", {}, visibility="private"),
                                    item("Moved", {}, status="cancelled")]})
        self.assertEqual([e["title"] for e in events], ["First Saturday Classic"])


class Build(unittest.TestCase):
    def test_event_fields(self):
        [e] = uc.build({"club": [item("First Saturday Classic", CLUB_TOURNAMENT)]})
        self.assertEqual(list(e), ["title", "calendar", "organizer", "tags", "url", "price", "page", "start", "end",
                                   "allDay", "location", "place", "city", "description"])
        self.assertEqual((e["start"], e["allDay"], e["city"]), ("2026-11-07T10:00:00-07:00", False, "Fort Collins"))

    def test_club_tournaments_get_a_page(self):
        events = uc.build({"club": [
            item("First Saturday Classic", CLUB_TOURNAMENT),
            item("Larimer County Chess Club Knightmare Arena Classical", CLUB_TOURNAMENT),
            item("Monday Club Night at Peak", {**CLUB_TOURNAMENT, "format": "casual"}),
        ], "community": [item("Drop-In", MEETUP)]})
        self.assertEqual({e["title"]: e["page"] for e in events}, {
            "First Saturday Classic": "/events/first-saturday-classic/",
            "Larimer County Chess Club Knightmare Arena Classical": "/events/knightmare-arena-classical/",
            "Monday Club Night at Peak": "",
            "Drop-In": "",
        })

    def test_all_day(self):
        [e] = uc.build({"community": [{**item("Drop-In", MEETUP), "start": {"date": "2026-10-09"},
                                       "end": {"date": "2026-10-10"}}]})
        self.assertEqual((e["start"], e["end"], e["allDay"]),
                         ("2026-10-09T00:00:00-06:00", "2026-10-10T00:00:00-06:00", True))


class Weekly(unittest.TestCase):
    def occurrences(self, title, days):
        return [{"title": title, "start": f"2026-10-{d:02d}T18:30:00-06:00", "tags": []} for d in days]

    def test_weekly_and_more_often_are_weekly(self):
        events = self.occurrences("Monday Club Night", [12, 19, 26]) + self.occurrences("Drop-In", [9, 12, 14, 16])
        uc.tag_weekly(events)
        self.assertTrue(all("weekly" in e["tags"] for e in events))

    def test_daylight_saving_and_holiday_gaps_still_weekly(self):
        events = [{"title": "Monday Club Night", "start": s, "tags": []} for s in (
            "2026-10-26T18:30:00-06:00", "2026-11-02T18:30:00-07:00", "2026-11-09T18:30:00-07:00",
            "2026-11-30T18:30:00-07:00", "2026-12-07T18:30:00-07:00")]
        uc.tag_weekly(events)
        self.assertTrue(all("weekly" in e["tags"] for e in events))

    def test_monthly_and_one_off_are_not(self):
        events = self.occurrences("First Saturday Classic", [3]) + [
            {"title": "Sac'n", "start": s, "tags": []}
            for s in ("2026-10-10T09:30:00-06:00", "2026-11-14T09:30:00-07:00", "2026-12-12T09:30:00-07:00")]
        uc.tag_weekly(events)
        self.assertFalse(any("weekly" in e["tags"] for e in events))


class Places(unittest.TestCase):
    def test_full_address(self):
        self.assertEqual(uc.place(PEAK), {"name": "Peak Community Church", "street": "500 Mathews St",
                                          "city": "Fort Collins", "region": "CO", "zip": "80524"})
        self.assertEqual(uc.place("Grand Slam Games and Comics, 1119 W Drake Rd, Unit C-30, Fort Collins, CO 80526, USA")["street"],
                         "1119 W Drake Rd, Unit C-30")

    def test_city(self):
        self.assertEqual(uc.city(PEAK), "Fort Collins")
        self.assertEqual(uc.city("Chilson Senior Center, Loveland, CO"), "Loveland")
        self.assertEqual(uc.city("Somewhere, Wellington, Colorado"), "Wellington")
        self.assertEqual(uc.city("Online"), "")


if __name__ == "__main__":
    unittest.main()
