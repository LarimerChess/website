"""Managed descriptions are validated before writes and read back after syncing."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import sync_event_descriptions as sync

SOURCE = Path(__file__).resolve().parents[1] / "event-descriptions.json"


def monday_record():
    return next(record for record in sync.read_source(SOURCE)
                if record["event_id"] == "5ok4vomkgvb6fui6csb1uignvi")


class DescriptionSource(unittest.TestCase):
    def test_export_contains_only_public_fields_and_new_control(self):
        record = monday_record()
        self.assertIn("Time control: G/60;+30 (60 minutes per player, with a 30-second increment", record["description"])
        self.assertEqual(record["metadata"]["speed"], "regular")

    def test_bad_sources_are_rejected_before_api_calls(self):
        record = monday_record()
        cases = [{}, [record, record], [{**record, "calendar": "unknown"}],
                 [{**record, "metadata": {"rated": "yes"}}],
                 [{**record, "metadata": {**record["metadata"], "private-note": "not public"}}],
                 [{**record, "description": ""}]]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "source.json"
            for value in cases:
                with self.subTest(value=value):
                    path.write_text(json.dumps(value), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        sync.read_source(path)


class CalendarSync(unittest.TestCase):
    def setUp(self):
        self.record = monday_record()
        self.current = {"summary": self.record["title"], "etag": '"one"',
                        "description": "Old public description", "status": "confirmed",
                        "extendedProperties": {"private": {**self.record["metadata"], "source": "keep-me"}}}
        self.verified = {**copy.deepcopy(self.current), "description": self.record["description"]}
        self.service = Mock()
        self.events = self.service.events.return_value
        self.events.get.return_value.execute.side_effect = [self.current, self.verified]
        self.events.patch.return_value.headers = {}

    def test_updates_description_only_with_revision_and_readback(self):
        self.assertEqual(sync.sync(self.service, [self.record]), 1)
        self.events.patch.assert_called_once_with(calendarId=sync.CALENDARS["club"],
                                                  eventId=self.record["event_id"],
                                                  body={"description": self.record["description"]})
        self.assertEqual(self.events.patch.return_value.headers, {"If-Match": '"one"'})
        self.assertEqual(self.events.get.call_count, 2)

    def test_preview_does_not_write(self):
        self.assertEqual(sync.sync(self.service, [self.record], dry_run=True), 1)
        self.events.patch.assert_not_called()

    def test_current_event_is_idempotent_and_still_verified(self):
        self.events.get.return_value.execute.side_effect = [self.verified, self.verified]
        self.assertEqual(sync.sync(self.service, [self.record]), 0)
        self.events.patch.assert_not_called()

    def test_metadata_changes_leave_unrelated_properties_alone(self):
        self.current["extendedProperties"]["private"]["speed"] = "regular,quick"
        self.assertEqual(sync.sync(self.service, [self.record]), 1)
        self.assertEqual(self.events.patch.call_args.kwargs["body"]["extendedProperties"],
                         {"private": {"speed": "regular"}})

    def test_title_status_or_missing_revision_stops_all_writes(self):
        for change in ({"summary": "Another event"}, {"status": "cancelled"}, {"etag": None}):
            with self.subTest(change=change):
                self.events.get.return_value.execute.side_effect = [self.current, {**self.current, **change}]
                with self.assertRaises(ValueError):
                    sync.sync(self.service, [self.record, {**self.record, "event_id": "other"}])
                self.events.patch.assert_not_called()

    def test_readback_failure_is_not_retried(self):
        self.events.get.return_value.execute.side_effect = [self.current, self.current]
        with self.assertRaisesRegex(ValueError, "read-back differs"):
            sync.sync(self.service, [self.record])
        self.events.patch.return_value.execute.assert_called_once_with()


class SavedControls(unittest.TestCase):
    def setUp(self):
        self.records = [monday_record()]
        self.db = Mock()
        self.today = date(2026, 11, 2)

    def test_prior_months_prior_nights_and_other_events_are_left_alone(self):
        self.db.get.return_value = {"old-month": {"Key": "monday-club-night-at-peak/2026-10", "Time control": "G/70;d10"},
                                    "old-night": {"Key": "monday-club-night-at-peak/2026-10-26", "Time control": "G/70;d10"},
                                    "other": {"Key": "third-saturday-slow/2026-11-21", "Time control": "G/70;d10"}}
        self.assertEqual(sync.check_saved_controls(self.db, self.records, self.today), [])
        self.db.patch.assert_not_called()

    def test_current_month_and_future_nights_are_checked_without_changing_sections(self):
        self.db.get.return_value = {"month": {"Key": "monday-club-night-at-peak/2026-11", "Time control": "G/60;+30",
                                             "Sections": '[{"name":"Extra games","timeControl":"G/30;+30"}]'},
                                    "night": {"Key": "monday-club-night-at-peak/2026-12-07", "Time control": "G/60;+30"}}
        self.assertEqual(len(sync.check_saved_controls(self.db, self.records, self.today)), 2)
        self.db.patch.assert_not_called()

    def test_an_old_or_missing_saved_control_is_reported_without_relabeling_games(self):
        for control in ("G/70;d10", ""):
            with self.subTest(control=control):
                self.db.get.return_value = {"month": {"Key": "monday-club-night-at-peak/2026-11", "Time control": control}}
                with self.assertRaisesRegex(ValueError, "Saved time controls differ"):
                    sync.check_saved_controls(self.db, self.records, self.today)
                self.db.patch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
