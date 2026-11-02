"""A Calendar edit changes only the expected line and verifies its revision and read-back."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import update_event_time_control as edit


OLD = "Time control: G/70;d10 (70 minutes per player, with a 10-second delay on each move). Regular rated."
NEW = "Time control: G/60;+30 (60 minutes per player, with a 30-second increment on each move). Regular rated."
DESCRIPTION = "Cost: $7.50.\n" + OLD + "\n\nWelcome to Monday Club Night.\n"


class DescriptionEdit(unittest.TestCase):
    def test_keeps_every_other_character_and_line_ending(self):
        for ending in ("\n", "\r\n"):
            for suffix in ("", ending):
                with self.subTest(ending=ending, suffix=suffix):
                    description = ("Cost: $7.50." + ending + OLD + ending * 2 + "Welcome." + suffix)
                    self.assertEqual(edit.replace_line(description, OLD, NEW), description.replace(OLD, NEW))

    def test_refuses_stale_ambiguous_missing_or_invalid_lines(self):
        cases = [(DESCRIPTION.replace(OLD, "Time control: G/90;+30."), OLD, NEW),
                 (DESCRIPTION + OLD, OLD, NEW), ("Welcome.", OLD, NEW),
                 (DESCRIPTION, "Cost: $7.50.", NEW), (DESCRIPTION, OLD, NEW + "\nMore text"),
                 (DESCRIPTION, OLD, "Time control: ")]
        for description, expected, replacement in cases:
            with self.subTest(description=description, replacement=replacement):
                with self.assertRaises(ValueError):
                    edit.replace_line(description, expected, replacement)

    def test_an_already_applied_change_is_idempotent(self):
        description = DESCRIPTION.replace(OLD, NEW)
        self.assertEqual(edit.replace_line(description, OLD, NEW), description)


class CalendarEdit(unittest.TestCase):
    def setUp(self):
        self.service = Mock()
        self.events = self.service.events.return_value
        self.event = {"id": "series-id", "etag": '"revision-1"', "description": DESCRIPTION,
                      "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO"], "location": "Peak"}
        self.updated = {**self.event, "description": DESCRIPTION.replace(OLD, NEW)}
        self.events.get.return_value.execute.side_effect = [self.event, self.updated]
        self.request = self.events.patch.return_value
        self.request.headers = {}

    def update(self, **kwargs):
        return edit.update_event(self.service, "club", "series-id", OLD, NEW, **kwargs)

    def test_preview_reads_the_named_series_without_writing(self):
        self.assertTrue(self.update(dry_run=True).startswith("preview:"))
        self.events.get.assert_called_once_with(calendarId=edit.CALENDARS["club"], eventId="series-id")
        self.events.patch.assert_not_called()

    def test_apply_changes_only_description_checks_revision_and_reads_back(self):
        self.assertTrue(self.update().startswith("updated:"))
        self.events.patch.assert_called_once_with(calendarId=edit.CALENDARS["club"], eventId="series-id",
                                                  body={"description": DESCRIPTION.replace(OLD, NEW)})
        self.assertEqual(self.request.headers, {"If-Match": '"revision-1"'})
        self.request.execute.assert_called_once_with()
        self.assertEqual(self.events.get.call_count, 2)

    def test_a_mismatch_or_missing_revision_never_writes(self):
        for event in ({**self.event, "description": "Time control: G/90;+30."},
                      {key: value for key, value in self.event.items() if key != "etag"}):
            with self.subTest(event=event):
                self.events.get.return_value.execute.side_effect = [event]
                with self.assertRaises(ValueError):
                    self.update()
                self.events.patch.assert_not_called()

    def test_an_already_applied_change_does_not_write_again(self):
        self.events.get.return_value.execute.side_effect = [self.updated]
        self.assertTrue(self.update().startswith("same:"))
        self.events.patch.assert_not_called()

    def test_a_failed_write_is_not_retried(self):
        self.request.execute.side_effect = RuntimeError("revision changed")
        with self.assertRaises(RuntimeError):
            self.update()
        self.request.execute.assert_called_once_with()

    def test_a_readback_mismatch_is_reported_without_a_second_write(self):
        self.events.get.return_value.execute.side_effect = [self.event, self.event]
        with self.assertRaisesRegex(ValueError, "read-back differs"):
            self.update()
        self.request.execute.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
