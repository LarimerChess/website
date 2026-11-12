"""Public Facebook sync feed: stable IDs, explicit cancellations, and no private data."""
import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import publish_facebook_feed as ff

NOW = datetime.fromisoformat("2026-11-12T13:00:00-07:00")


def event(event_id="occurrence", **extra):
    return {"id": event_id, "summary": "Club night", "description": "Welcome.",
            "location": "Peak Community Church", "start": {"dateTime": "2026-11-16T18:30:00-07:00"},
            "end": {"dateTime": "2026-11-16T21:30:00-07:00"},
            "extendedProperties": {"private": {"organizer": ff.CLUB, "format": "casual",
                                              "ages": "all", "rated": "no", "cost": "free"}}, **extra}


class FacebookFeed(unittest.TestCase):
    def build(self, items, previous=None, lookup=None):
        return ff.build(items, previous, lookup or (lambda _: self.fail("Unexpected lookup")), NOW)

    def test_only_public_club_data_is_exported(self):
        row = event(attendees=[{"email": "private@example.test"}], creator={"email": "private@example.test"})
        data = self.build([row, event("private", visibility="private"), event("other", extendedProperties={})])
        self.assertEqual(len(data["events"]), 1)
        self.assertNotIn("private@example.test", str(data))
        self.assertEqual(data["events"][0]["id"], "occurrence")
        self.assertEqual(data["events"][0]["status"], "active")
        self.assertEqual(data["generatedAt"], NOW.isoformat())

    def test_rename_and_move_preserve_identity_but_change_fingerprint(self):
        previous = self.build([event()])
        moved = event(summary="New title", start={"dateTime": "2027-07-12T18:30:00-06:00"},
                      end={"dateTime": "2027-07-12T21:30:00-06:00"})
        result = self.build([], previous, lambda _: moved)["events"][0]
        self.assertEqual(result["id"], previous["events"][0]["id"])
        self.assertEqual(result["marker"], previous["events"][0]["marker"])
        self.assertNotEqual(result["fingerprint"], previous["events"][0]["fingerprint"])
        self.assertTrue(result["start"].startswith("2027-07-12"))

    def test_missing_events_are_looked_up_before_publishing_cancellation(self):
        previous = self.build([event()])
        result = self.build([], previous, lambda _: {"id": "occurrence", "status": "cancelled"})
        self.assertEqual(result["events"], [{"id": "occurrence", "status": "cancelled",
                         "start": previous["events"][0]["start"], "end": previous["events"][0]["end"]}])
        with self.assertRaisesRegex(RuntimeError, "403"):
            self.build([], previous, lambda _: (_ for _ in ()).throw(RuntimeError("Google 403")))

    def test_private_events_retract_previous_public_details(self):
        previous = self.build([event()])
        result = self.build([event(visibility="private", description="Private replacement")], previous)
        self.assertEqual(result["events"][0]["status"], "cancelled")
        self.assertNotIn("Private replacement", str(result))

    def test_cancellation_can_be_restored(self):
        previous = self.build([event()])
        cancelled = self.build([], previous, lambda _: {"id": "occurrence", "status": "cancelled"})
        self.assertEqual(self.build([event()], cancelled)["events"][0]["status"], "active")

    def test_past_events_expire_without_google_lookup(self):
        old = self.build([event()])
        old["events"][0]["start"] = "2026-11-01T18:30:00-07:00"
        self.assertEqual(self.build([], old)["events"], [])

    def test_incomplete_or_duplicate_source_fails(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.build([event(), event()])
        with self.assertRaisesRegex(ValueError, "ID"):
            self.build([event(event_id="")])
        with self.assertRaisesRegex(ValueError, "timed"):
            self.build([event(start={"date": "2026-11-16"})])
        with self.assertRaisesRegex(ValueError, "metadata"):
            self.build([event(extendedProperties={"private": {"organizer": ff.CLUB}})])

    def test_corrupt_previous_feed_or_wrong_calendar_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "previous"):
            self.build([], {"schema": 999})
        previous = self.build([event()])
        previous["calendarId"] = "another-calendar"
        with self.assertRaisesRegex(ValueError, "previous"):
            self.build([], previous)


if __name__ == "__main__":
    unittest.main()
