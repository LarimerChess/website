"""Tests for the tagging rules in scripts/update_calendar.py.

    python -m unittest discover tests
"""

import importlib.util
import unittest
from pathlib import Path

import icalendar

spec = importlib.util.spec_from_file_location(
    "update_calendar", Path(__file__).resolve().parent.parent / "scripts" / "update_calendar.py")
uc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uc)

PEAK = "Peak Community Church, 500 Mathews St, Fort Collins, CO 80524, USA"


def event(title, description="", location=PEAK):
    e = icalendar.Event()
    e.add("SUMMARY", title)
    e.add("DESCRIPTION", description)
    e.add("LOCATION", location)
    return e


COST_TAGS = {"free", "free-youth", "cost-unknown"}


def kinds(tags):
    return [t for t in tags if t not in COST_TAGS and t != "all-ages"]


class Describe(unittest.TestCase):
    def test_every_club_event_is_rated(self):
        for title in ("Monday Club Night at Peak", "First Saturday Classic", "Knightmare Arena Classical"):
            d = uc.describe(event(title, "Unrated."), "club")
            self.assertEqual(d["organizer"], uc.CLUB, title)
            self.assertIn("club", d["tags"], title)
            self.assertIn("rated", d["tags"], title)

    def test_other_groups_are_rated_only_when_they_say_so(self):
        self.assertNotIn("rated", uc.describe(event("Chessmates Scholastic Tournament (K–12)"), "community")["tags"])
        self.assertIn("rated", uc.describe(event("Some Open", "A US Chess rated event."), "community")["tags"])
        self.assertNotIn("rated", uc.describe(event("Some Open", "US Chess rated? No, unrated."), "community")["tags"])
        chessmates = ("The section for players rated 800 and above is US Chess rated and needs a current US Chess ID; "
                      "grade-level sections don't need a US Chess membership.")
        self.assertIn("rated", uc.describe(event("Chessmates Scholastic Tournament (K–12)", chessmates), "community")["tags"])

    def test_kinds(self):
        self.assertEqual(kinds(uc.describe(event("Chessmates Scholastic Tournament (K–12)"), "community")["tags"]),
                         ["tournament", "youth"])
        self.assertIn("casual", uc.describe(event("Wednesday Night Chess at Purpose Brewing"), "community")["tags"])
        self.assertIn("tournament", uc.describe(event("Third Saturday Slow"), "club")["tags"])
        self.assertEqual(kinds(uc.describe(event("Chessmates Chess Club at Bamford Elementary (grades 1–5)"), "community")["tags"]),
                         ["youth"])

    def test_youth_and_seniors(self):
        kids = uc.describe(event("Chess Club for Kids at Loveland Public Library"), "community")
        self.assertEqual((kinds(kids["tags"]), kids["organizer"]), (["youth"], "Loveland Public Library"))
        for title in ("Chessmates Chess Club at Mountain Sage Community School", "Chessmates Academy Chess Club (youth)",
                      "Chessmates Chess Club at Ridgeview Classical School (grades K–6)"):
            d = uc.describe(event(title), "community")
            self.assertEqual((kinds(d["tags"]), d["organizer"]), (["youth"], "Chessmates"), title)
        seniors = uc.describe(event("Drop-In Open Chess (ages 55+) at Chilson Senior Center"), "community")
        self.assertEqual((kinds(seniors["tags"]), seniors["organizer"]), (["casual", "senior"], "Chilson Senior Center"))

    def test_organizers(self):
        self.assertEqual(uc.describe(event("Sac’n Saturdays at Grand Slam"), "club")["organizer"],
                         "Grand Slam Games and Comics")
        self.assertEqual(uc.describe(event("Wednesday Night Chess at Purpose Brewing"), "community")["organizer"],
                         "Fort Collins Chess Meetup")

    def test_details_link_only_for_community_events(self):
        text = "More at https://www.grandslamfc.com and https://new.uschess.org/join-us-chess"
        self.assertEqual(uc.describe(event("Sac’n Saturdays at Grand Slam", text), "club")["url"], "")
        self.assertEqual(uc.describe(event("Chessmates Tournament", "https://chessmatesfc.com/tournaments/"),
                                     "community")["url"], "https://chessmatesfc.com/tournaments/")

    def test_entry_fee(self):
        self.assertEqual(uc.describe(event("First Saturday Classic", "Entry fee: $15. Free under 18."), "club")["price"], "15")
        self.assertEqual(uc.describe(event("Monday Club Night at Peak"), "club")["price"], "")


class AllAges(unittest.TestCase):
    def test_open_to_all_ages(self):
        for title, calendar in (("Monday Club Night at Peak", "club"), ("Wednesday Night Chess at Purpose Brewing", "community"),
                                ("Sac’n Saturdays at Grand Slam", "club")):
            self.assertIn("all-ages", uc.describe(event(title), calendar)["tags"], title)

    def test_age_limited(self):
        for title in ("Blitz Night (21+) at a Bar", "Adults Only Simul", "Wednesday Night Chess at Purpose Brewing (adults)","Chessmates Scholastic Tournament (K–12)", "Chess Club for Kids at Loveland Public Library",
                      "Chessmates Chess Club at Bamford Elementary (grades 1–5)",
                      "Drop-In Open Chess (ages 55+) at Chilson Senior Center"):
            self.assertNotIn("all-ages", uc.describe(event(title), "community")["tags"], title)


class Cost(unittest.TestCase):
    def tags(self, text):
        return [t for t in uc.describe(event("Some event", text), "community")["tags"] if t != "all-ages"]

    def test_free_for_everyone(self):
        self.assertEqual(self.tags("Cost: free. Just show up."), ["free", "free-youth"])

    def test_free_adult_event_is_not_free_for_youth(self):
        d = uc.describe(event("Wednesday Night Chess at Purpose Brewing (adults)", "Cost: free."), "community")
        self.assertIn("free", d["tags"])
        self.assertNotIn("free-youth", d["tags"])

    def test_free_for_youth(self):
        for text in ("Entry fee: $15. Free for players under 18.",
                     "• Youth and college students: free",
                     "Players under 18 play free."):
            self.assertEqual(self.tags(text), ["free-youth"], text)

    def test_charges(self):
        for text in ("$30 entry.", "Free parking. Entry $10.", "Youth: $5. Bring a board.",
                     "Grand Slam charges an entry fee; ask them for the amount and format."):
            self.assertEqual(self.tags(text), [], text)

    def test_cost_unknown(self):
        for text in ("Chess club for kids. Check with the library for current dates.", ""):
            self.assertEqual(self.tags(text), ["cost-unknown"], text)


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
