"""Tests for which backups scripts/backup_firebase.py keeps.

    python -m unittest discover tests
"""

import datetime
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from backup_firebase import keep


def nightly(first, last):
    days = (last - first).days
    return [first + datetime.timedelta(days=n) for n in range(days + 1)]


class Keep(unittest.TestCase):
    def test_two_years_of_nightly_backups(self):
        today = datetime.date(2026, 10, 18)  # a Sunday
        kept = keep(nightly(datetime.date(2024, 10, 1), today), today)
        D = datetime.date
        self.assertEqual(sorted(kept), [
            *[D(2025, m, 1) for m in range(10, 13)],
            *[D(2026, m, 1) for m in range(1, 11)],
            D(2026, 10, 5),  # last week's Monday
            *nightly(D(2026, 10, 12), today),
        ])

    def test_missing_nights_fall_back_to_the_earliest_left(self):
        today = datetime.date(2026, 10, 18)
        dates = [datetime.date(2026, 9, 20), datetime.date(2026, 10, 3), datetime.date(2026, 10, 7),
                 datetime.date(2026, 10, 9)]
        self.assertEqual(sorted(keep(dates, today)), [
            datetime.date(2026, 9, 20), datetime.date(2026, 10, 3), datetime.date(2026, 10, 7)])


if __name__ == "__main__":
    unittest.main()
