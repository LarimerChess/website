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

    def test_kinds(self):
        self.assertEqual(uc.describe(event("Chessmates Scholastic Tournament (K–12)"), "community")["tags"],
                         ["tournament", "youth"])
        self.assertIn("casual", uc.describe(event("Wednesday Night Chess at Purpose Brewing"), "community")["tags"])
        self.assertIn("tournament", uc.describe(event("Third Saturday Slow"), "club")["tags"])

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
