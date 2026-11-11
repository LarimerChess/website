"""Outside listings retain their city/rating and suppress only club tournament weekends."""
import copy
import html
import json
import sys
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import Mock, patch

from googleapiclient.errors import HttpError
from httplib2 import Response

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import sync_tournaments as sync
import sync_tournament_conflicts as conflicts
import update_calendar as calendar

NOW = datetime(2026, 11, 11, 12, tzinfo=calendar.TZ)


def winter():
    return {"key": "csca-winter", "first": date(2026, 12, 5), "last": date(2026, 12, 6)}


def club(event_id="classic-dec", start="2026-12-05T10:00:00-07:00", end="2026-12-05T19:00:00-07:00"):
    return {"id": event_id, "etag": '"1"', "status": "confirmed", "summary": "First Saturday Classic",
            "recurringEventId": "classic", "originalStartTime": {"dateTime": start},
            "start": {"dateTime": start}, "end": {"dateTime": end}, "description": "Our event",
            "location": "Peak Community Church, 500 Mathews St, Fort Collins, CO 80524",
            "extendedProperties": {"private": {"organizer": calendar.CLUB, "format": "tournament",
                                                "ages": "all", "rated": "yes", "cost": "paid"}}}


class FakeCalendar:
    """Store writes but deliberately strip cancelled occurrences to Google's guaranteed fields."""
    def __init__(self, events):
        self.data = {event["id"]: copy.deepcopy(event) for event in events}
        self.service = Mock()
        self.api = self.service.events.return_value
        self.api.get.side_effect = self.get
        self.api.list.side_effect = self.list
        self.api.patch.side_effect = self.patch
        self.api.insert.side_effect = self.insert

    def get(self, calendarId, eventId):
        if eventId not in self.data:
            request = Mock()
            request.execute.side_effect = HttpError(Response({"status": "404"}), b"missing")
            return request
        return Mock(execute=Mock(return_value=copy.deepcopy(self.data[eventId])))

    def list(self, **kwargs):
        return Mock(execute=Mock(return_value={"items": [copy.deepcopy(e) for e in self.data.values()
                                                        if e.get("status") != "cancelled"]}))

    def patch(self, calendarId, eventId, body):
        def apply():
            event = self.data[eventId]
            event.update(copy.deepcopy(body))
            if body.get("status") == "cancelled":
                self.data[eventId] = {key: event[key] for key in ("id", "status", "recurringEventId", "originalStartTime")
                                     if key in event}
            self.data[eventId]["etag"] = '"updated"'
            return copy.deepcopy(self.data[eventId])
        return Mock(headers={}, execute=Mock(side_effect=apply))

    def insert(self, calendarId, body):
        def apply():
            self.data[body["id"]] = {**copy.deepcopy(body), "etag": '"state"'}
            return copy.deepcopy(self.data[body["id"]])
        return Mock(execute=Mock(side_effect=apply))


class ListingMetadata(unittest.TestCase):
    def listing(self, time_control="All Rounds G/90, +30 seconds increment", extra=""):
        row = {"id": "winter", "title": "2026 WINTER SPRINGS OPEN (Buck’s Legacy)",
               "date": "December 5 - 6, 2026", "round_times": "Sat. 12/5, Rd.1; 10:30am. Sun. 12/6, Rd.4; 3:30pm.",
               "time_control": time_control, "contact_name": "Denver Chess Club",
               "city": "Colorado Springs", "entry_fee": "$60",
               "site": "Hyatt Place Colorado Springs/Garden of the Gods 503 West Garden of the Gods Road "
                       "Colorado Springs, Colorado, 80907 I-25 to Exit 146 " + extra}
        page = '<tr class="tournament-row" ' + " ".join(f'data-{k}="{html.escape(v, quote=True)}"' for k, v in row.items()) + "></tr>"
        with patch.object(sync, "fetch", side_effect=[page.encode(), json.dumps({"link": "https://example.org/winter"}).encode()]):
            return sync.csca_tournaments()[0]

    def test_winter_springs_reaches_city_and_rated_filters_without_rating_keywords(self):
        tournament = self.listing()
        body = sync.event_body(tournament)
        for key in ("start", "end"):
            body[key] = {name: value for name, value in body[key].items() if value is not None}
        [event] = calendar.build({"club": [body]})
        self.assertEqual(event["city"], "Colorado Springs")
        self.assertIn("rated", event["tags"])
        self.assertIn("regular", event["tags"])
        self.assertNotIn("club", event["tags"])

    def test_quick_events_need_explicit_rating_information(self):
        self.assertEqual(self.listing("G/20+5")["rated"], "no")
        self.assertEqual(self.listing("G/20+5", "us chess rated")["rated"], "yes")

    def test_source_parse_failure_never_touches_calendar(self):
        with patch.object(sync, "csca_tournaments", return_value=[winter()]), \
                patch.object(sync, "dcc_tournaments", side_effect=SystemExit("unreadable")), \
                patch.object(sync, "build") as build, patch.object(sys, "argv", ["sync_tournaments.py"]):
            with self.assertRaises(SystemExit):
                sync.main()
            build.assert_not_called()

    def test_dcc_layout_change_cannot_silently_remove_all_weekend_tournaments(self):
        page = '<h3>December, 2026</h3><a href="/tournaments/upcoming/11114815"><span>Winter Springs</span></a>'
        with patch.object(sync, "fetch", return_value=page.encode()):
            with self.assertRaisesRegex(SystemExit, "Can't read every"):
                sync.dcc_tournaments()

    def test_dcc_monthly_events_do_not_count_as_weekend_tournaments(self):
        page = ('<h3>December, 2026</h3>'
                '<a href="/tournaments/upcoming/1">Tuesdays <small>December 1 - 29</small></a>'
                '<a href="/tournaments/upcoming/2">Winter Springs <small>December 5 - 6</small></a>')
        with patch.object(sync, "fetch", return_value=page.encode()):
            tournaments = sync.dcc_tournaments()
        self.assertEqual([t["title"] for t in tournaments], ["Winter Springs"])

    def test_source_update_verifies_city_and_rated_metadata_in_calendar(self):
        body = sync.event_body(self.listing())
        old = {"id": "outside", "etag": '"one"', **copy.deepcopy(body)}
        old["extendedProperties"]["private"].pop("city")
        old["extendedProperties"]["private"]["rated"] = "no"
        fake = FakeCalendar([old])
        sync.write_tournament(fake.service, body, old)
        self.assertEqual(fake.data["outside"]["extendedProperties"]["private"]["city"], "Colorado Springs")
        self.assertEqual(fake.data["outside"]["extendedProperties"]["private"]["rated"], "yes")
        fake.api.get.assert_called_once_with(calendarId=sync.CALENDAR, eventId="outside")

    def test_source_update_rejects_a_readback_that_did_not_apply_metadata(self):
        body = sync.event_body(self.listing())
        old = {"id": "outside", "etag": '"one"', **copy.deepcopy(body)}
        old["extendedProperties"]["private"].pop("city")
        fake = FakeCalendar([old])
        fake.api.get.side_effect = None
        fake.api.get.return_value.execute.return_value = old
        with self.assertRaisesRegex(ValueError, "read-back differs"):
            sync.write_tournament(fake.service, body, old)


class AutomaticConflicts(unittest.TestCase):
    def run_sync(self, fake, tournaments=None, **kwargs):
        return conflicts.sync_conflicts(fake.service, [winter()] if tournaments is None else tournaments,
                                        now=NOW, **kwargs)

    def test_cancels_december_occurrence_preserves_january_and_series(self):
        december = club()
        january = club("classic-jan", "2027-01-02T10:00:00-07:00", "2027-01-02T19:00:00-07:00")
        fake = FakeCalendar([december, january])
        self.assertEqual(self.run_sync(fake), 1)
        self.assertEqual(fake.data[december["id"]]["status"], "cancelled")
        self.assertEqual(fake.data[january["id"]], january)
        state = fake.data[conflicts.STATE_ID]
        self.assertEqual(state["visibility"], "private")
        self.assertEqual(json.loads(state["description"])["cancelled"][december["id"]]["phase"], "cancelled")
        self.assertTrue(all(call.kwargs["eventId"] != "classic" for call in fake.api.patch.call_args_list))

    def test_repeated_runs_are_idempotent(self):
        fake = FakeCalendar([club()])
        self.run_sync(fake)
        fake.api.patch.reset_mock()
        self.assertEqual(self.run_sync(fake), 0)
        fake.api.patch.assert_not_called()

    def test_restores_our_sparse_tombstone_when_outside_event_disappears(self):
        original = club()
        fake = FakeCalendar([original])
        self.run_sync(fake)
        self.assertNotIn("start", fake.data[original["id"]])
        self.assertEqual(self.run_sync(fake, []), 1)
        restored = fake.data[original["id"]]
        for field in conflicts.SNAPSHOT_FIELDS:
            self.assertEqual(restored.get(field), original.get(field))
        self.assertEqual(restored["status"], "confirmed")
        self.assertEqual(json.loads(fake.data[conflicts.STATE_ID]["description"])["cancelled"], {})

    def test_manual_cancellation_other_organizers_and_casual_play_stay_untouched(self):
        manual = {**club("manual"), "status": "cancelled"}
        casual = club("casual")
        casual["extendedProperties"]["private"]["format"] = "casual"
        outside = club("outside")
        outside["extendedProperties"]["private"]["organizer"] = "Grand Slam"
        weekday = club("monday", "2026-12-07T18:30:00-07:00", "2026-12-07T21:30:00-07:00")
        private = {**club("private"), "visibility": "private"}
        fake = FakeCalendar([manual, casual, outside, weekday, private])
        before = copy.deepcopy(fake.data)
        self.assertEqual(self.run_sync(fake), 0)
        self.assertEqual(fake.data, before)
        fake.api.patch.assert_not_called()
        fake.api.insert.assert_not_called()

    def test_dry_run_neither_creates_receipts_nor_changes_event(self):
        fake = FakeCalendar([club()])
        self.assertEqual(self.run_sync(fake, dry_run=True), 1)
        fake.api.patch.assert_not_called()
        fake.api.insert.assert_not_called()

    def test_same_weekend_blocks_saturday_even_if_outside_event_starts_sunday(self):
        tournament = {**winter(), "first": date(2026, 12, 6), "last": date(2026, 12, 7)}
        self.assertEqual(self.run_sync(FakeCalendar([club()]), [tournament]), 1)

    def test_weekday_series_spanning_a_weekend_does_not_block_it(self):
        tournament = {**winter(), "first": date(2026, 12, 3), "last": date(2026, 12, 17), "weekdays": [3]}
        self.assertEqual(self.run_sync(FakeCalendar([club()]), [tournament]), 0)

    def test_other_blocker_keeps_date_cancelled_when_one_tournament_disappears(self):
        fake = FakeCalendar([club()])
        self.run_sync(fake, [winter(), {**winter(), "key": "second"}])
        self.assertEqual(self.run_sync(fake, [{**winter(), "key": "second"}]), 0)
        self.assertEqual(fake.data["classic-dec"]["status"], "cancelled")

    def test_one_off_dates_can_also_be_restored_from_tombstones(self):
        event = club()
        event.pop("recurringEventId")
        event.pop("originalStartTime")
        fake = FakeCalendar([event])
        self.run_sync(fake)
        self.assertEqual(self.run_sync(fake, []), 1)
        self.assertEqual(fake.data[event["id"]]["summary"], event["summary"])

    def test_interrupted_cancellation_never_guesses_whether_to_restore(self):
        fake = FakeCalendar([club()])
        self.run_sync(fake)
        state = json.loads(fake.data[conflicts.STATE_ID]["description"])
        state["cancelled"]["classic-dec"]["phase"] = "pending"
        fake.data[conflicts.STATE_ID]["description"] = json.dumps(state)
        fake.api.patch.reset_mock()
        with self.assertRaisesRegex(ValueError, "interrupted"):
            self.run_sync(fake, [])
        fake.api.patch.assert_not_called()

    def test_missing_revision_prevents_all_writes(self):
        event = club()
        event.pop("etag")
        fake = FakeCalendar([event])
        with self.assertRaisesRegex(ValueError, "revision"):
            self.run_sync(fake)
        fake.api.patch.assert_not_called()
        fake.api.insert.assert_not_called()

    def test_past_and_started_tournaments_are_not_cancelled(self):
        event = club(start="2026-11-07T10:00:00-07:00", end="2026-11-15T19:00:00-07:00")
        fake = FakeCalendar([event])
        self.assertEqual(self.run_sync(fake, [{**winter(), "first": date(2026, 11, 14), "last": date(2026, 11, 15)}]), 0)
        fake.api.patch.assert_not_called()

    def test_all_day_exclusive_end_does_not_accidentally_include_next_weekend(self):
        event = club()
        event["start"], event["end"] = {"date": "2026-12-04"}, {"date": "2026-12-05"}
        self.assertEqual(self.run_sync(FakeCalendar([event])), 0)

    def test_moved_occurrence_uses_actual_weekend(self):
        event = club(start="2026-12-12T10:00:00-07:00", end="2026-12-12T19:00:00-07:00")
        event["originalStartTime"] = {"dateTime": "2026-12-05T10:00:00-07:00"}
        self.assertEqual(self.run_sync(FakeCalendar([event])), 0)

    def test_outside_tournament_moving_away_restores_original_date(self):
        fake = FakeCalendar([club()])
        self.run_sync(fake)
        moved = {**winter(), "first": date(2026, 12, 12), "last": date(2026, 12, 13)}
        self.assertEqual(self.run_sync(fake, [moved]), 1)
        self.assertEqual(fake.data["classic-dec"]["status"], "confirmed")

    def test_failed_calendar_read_prevents_cancellations_and_receipts(self):
        fake = FakeCalendar([club()])
        fake.api.list.return_value.execute.side_effect = RuntimeError("unreadable")
        fake.api.list.side_effect = None
        with self.assertRaisesRegex(RuntimeError, "unreadable"):
            self.run_sync(fake)
        fake.api.patch.assert_not_called()
        fake.api.insert.assert_not_called()

    def test_receipt_is_durable_before_cancellation_and_failure_does_not_claim_success(self):
        fake = FakeCalendar([club()])
        fake.api.patch.side_effect = RuntimeError("write failed")
        with self.assertRaisesRegex(RuntimeError, "write failed"):
            self.run_sync(fake)
        state = json.loads(fake.data[conflicts.STATE_ID]["description"])
        self.assertEqual(state["cancelled"]["classic-dec"]["phase"], "pending")
        self.assertEqual(fake.data["classic-dec"]["status"], "confirmed")

    def test_completed_receipts_are_pruned_without_restoring_past_events(self):
        fake = FakeCalendar([club()])
        self.run_sync(fake)
        after = datetime(2026, 12, 6, 12, tzinfo=calendar.TZ)
        self.assertEqual(conflicts.sync_conflicts(fake.service, [], now=after), 0)
        self.assertEqual(fake.data["classic-dec"]["status"], "cancelled")
        self.assertEqual(json.loads(fake.data[conflicts.STATE_ID]["description"])["cancelled"], {})


if __name__ == "__main__":
    unittest.main()
