"""Offline tests: paid verification, pagination, retry-safe backend handoff."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

SPEC = importlib.util.spec_from_file_location("stripe_sync", Path(__file__).resolve().parents[1] / "scripts/sync_stripe_payments.py")
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)

CONFIG = {"enabled": True, "livemode": False, "currency": "usd",
          "entry": {"amount": 1750, "paymentLinkId": "plink_entry"},
          "donation": {"paymentLinkId": "plink_donation"}}
SESSION = {"id": "cs_test_example", "payment_status": "paid", "status": "complete", "mode": "payment",
           "livemode": False, "currency": "usd", "payment_link": "plink_entry",
           "payment_intent": "pi_example", "amount_total": 1750, "created": 1,
           "client_reference_id": "pay_reference"}
INTENT = {"id": "pi_example", "status": "succeeded", "amount_received": 1750, "currency": "usd", "livemode": False,
          "latest_charge": {"amount": 1750, "currency": "usd", "livemode": False, "paid": True,
                            "captured": True, "amount_refunded": 0, "disputed": False,
                            "billing_details": {"email": "private@example.com"}}}


class SyncTests(unittest.TestCase):
    def test_dynamic_basket_amount_and_reference_reach_backend(self):
        session = {**SESSION, "payment_link": None, "metadata": {"lccc_checkout": "basket_v1"},
                   "client_reference_id": "basket_example", "amount_total": 5250}
        intent = copy.deepcopy(INTENT)
        intent["amount_received"] = intent["latest_charge"]["amount"] = 5250
        record = sync.payment_record(session, intent, CONFIG, "entry", "basket_v1")
        self.assertEqual(record["amountCents"], 5250)
        self.assertEqual(record["clientReferenceId"], "basket_example")
        self.assertEqual(record["paymentLinkId"], "")
        self.assertEqual(record["checkoutType"], "basket_v1")
        self.assertEqual(record["kind"], "entry")
        self.assertNotIn("metadata", record)
        for change in ({"metadata": {}}, {"metadata": None}, {"payment_link": "plink_entry"},
                       {"livemode": True}, {"currency": "eur"}):
            with self.subTest(change=change), self.assertRaises(sync.SyncError):
                sync.payment_record({**session, **change}, intent, CONFIG, "entry", "basket_v1")

    def test_discovery_ignores_unrelated_sessions_and_does_not_repeat_links(self):
        basket = {**SESSION, "id": "cs_basket", "payment_link": None,
                  "metadata": {"lccc_checkout": "basket_v1"}, "client_reference_id": "basket_example"}
        unrelated = {**basket, "id": "cs_other", "metadata": {"lccc_checkout": "other"}}
        unpaid = {**basket, "id": "cs_unpaid", "payment_status": "unpaid"}
        stripe = sync.Stripe("unused")
        records = []

        def sender(batch):
            records.extend(copy.deepcopy(batch))
            return [{"sessionId": r["sessionId"], "status": "test"} for r in batch]

        with patch.object(stripe, "sessions", side_effect=lambda link: {
                "plink_entry": [SESSION], "plink_donation": [],
                None: [SESSION, basket, unrelated, unpaid]}[link]), \
                patch.object(stripe, "get", return_value=INTENT) as get:
            counts = sync.sync(stripe, CONFIG, sender)
        self.assertEqual([r["sessionId"] for r in records], [SESSION["id"], "cs_basket"])
        self.assertEqual(counts["verified"], 2)
        self.assertEqual(counts["skipped"], 1)
        self.assertEqual(get.call_count, 2)

    def test_unfiltered_discovery_paginates_without_link_or_timestamp(self):
        stripe = sync.Stripe("unused")
        with patch.object(stripe, "get", side_effect=[
                {"data": [{"id": "cs_new"}], "has_more": True},
                {"data": [{"id": "cs_old"}], "has_more": False}]) as get:
            self.assertEqual([s["id"] for s in stripe.sessions()], ["cs_new", "cs_old"])
            self.assertEqual(get.call_args.args[1], {"limit": 100, "starting_after": "cs_new"})

    def test_configuration_fails_closed(self):
        sync.validate_config(CONFIG, "rk_test_example")
        for change, key in [({"enabled": False}, "rk_test_example"), ({}, "rk_live_example"),
                            ({"livemode": 0}, "rk_test_example"), ({"currency": "eur"}, "rk_test_example"),
                            ({"entry": {"amount": 1750, "paymentLinkId": ""}}, "rk_test_example")]:
            with self.subTest(change=change), self.assertRaises(sync.SyncError):
                sync.validate_config({**CONFIG, **change}, key)

    def test_unpaid_or_incomplete_never_credit(self):
        for change in ({"payment_status": "unpaid"}, {"status": "open"}, {"payment_status": "no_payment_required"}):
            self.assertIsNone(sync.payment_record({**SESSION, **change}, {}, CONFIG, "entry"))

    def test_paid_validation(self):
        for change in ({"currency": "eur"}, {"livemode": True}, {"mode": "subscription"},
                       {"payment_link": "plink_other"}, {"amount_total": 0}, {"amount_total": True}):
            with self.subTest(change=change), self.assertRaises(sync.SyncError):
                sync.payment_record({**SESSION, **change}, INTENT, CONFIG, "entry")
        for change in ({"status": "processing"}, {"amount_received": 1751}, {"latest_charge": "ch_notexpanded"}):
            with self.subTest(change=change), self.assertRaises(sync.SyncError):
                sync.payment_record(SESSION, {**INTENT, **change}, CONFIG, "entry")

    def test_output_has_no_payer_details_and_retains_reversals(self):
        intent = copy.deepcopy(INTENT)
        intent["latest_charge"].update(amount_refunded=500, disputed=True)
        result = sync.payment_record(SESSION, intent, CONFIG, "entry")
        self.assertEqual(result["refundCents"], 500)
        self.assertTrue(result["disputed"])
        self.assertNotIn("email", str(result))
        self.assertEqual(result["clientReferenceId"], "pay_reference")

    def test_wrong_entry_amount_and_missing_reference_reach_review_backend(self):
        session = {**SESSION, "amount_total": 1800, "client_reference_id": None}
        intent = copy.deepcopy(INTENT)
        intent["amount_received"] = intent["latest_charge"]["amount"] = 1800
        result = sync.payment_record(session, intent, CONFIG, "entry")
        self.assertEqual(result["amountCents"], 1800)
        self.assertEqual(result["clientReferenceId"], "")

    def test_pagination_visits_every_page_without_cutoff(self):
        stripe = sync.Stripe("unused")
        pages = [{"data": [{"id": "cs_first"}], "has_more": True},
                 {"data": [{"id": "cs_old"}], "has_more": False}]
        with patch.object(stripe, "get", side_effect=pages) as get:
            self.assertEqual([s["id"] for s in stripe.sessions("plink_entry")], ["cs_first", "cs_old"])
            self.assertEqual(get.call_args.args[1]["starting_after"], "cs_first")
            self.assertNotIn("created", get.call_args.args[1])

    def test_pagination_loop_fails(self):
        stripe = sync.Stripe("unused")
        with patch.object(stripe, "get", return_value={"data": [{"id": "cs_same"}], "has_more": True}):
            with self.assertRaises(sync.SyncError):
                list(stripe.sessions("plink_entry"))

    def test_backend_acknowledgement_required(self):
        record = sync.payment_record(SESSION, INTENT, CONFIG, "entry")
        for response in ({"error": "private error"}, {"ok": True, "results": []},
                         {"ok": True, "results": [{"sessionId": "other", "status": "imported"}]}):
            with patch.object(sync, "request_json", return_value=response), self.assertRaises(sync.SyncError):
                sync.send_records("https://example.com", "secret", [record])
        response = {"ok": True, "results": [{"sessionId": SESSION["id"], "status": "test"}]}
        with patch.object(sync, "request_json", return_value=response) as request:
            self.assertEqual(sync.send_records("https://example.com", "secret", [record]), response["results"])
            self.assertIn(b"action=stripeSync", request.call_args.args[0].data)

    def test_dry_run_and_repeat_rescan_old_refund(self):
        stripe = sync.Stripe("unused")
        batches = []

        def sender(records):
            batches.extend(copy.deepcopy(records))
            return [{"sessionId": r["sessionId"], "status": "duplicate"} for r in records]

        with patch.object(stripe, "sessions", side_effect=lambda link: [SESSION] if link == "plink_entry" else []), \
                patch.object(stripe, "get", return_value=INTENT):
            self.assertEqual(sync.sync(stripe, CONFIG)["verified"], 1)
            self.assertEqual(batches, [])
            sync.sync(stripe, CONFIG, sender)
        refunded = copy.deepcopy(INTENT)
        refunded["latest_charge"]["amount_refunded"] = 1750
        with patch.object(stripe, "sessions", side_effect=lambda link: [SESSION] if link == "plink_entry" else []), \
                patch.object(stripe, "get", return_value=refunded):
            sync.sync(stripe, CONFIG, sender)
        self.assertEqual([r["refundCents"] for r in batches], [0, 1750])

    def test_donation_needs_no_player_reference(self):
        donation = {**SESSION, "payment_link": "plink_donation", "client_reference_id": None}
        result = sync.payment_record(donation, INTENT, CONFIG, "donation")
        self.assertEqual(result["kind"], "donation")
        self.assertEqual(result["clientReferenceId"], "")

    def test_rate_limit_retry_redacts_remote_body_and_url(self):
        error = HTTPError("https://private.example/secret", 429, "sensitive response", {}, None)
        with patch.object(sync, "urlopen", side_effect=error) as opening, patch.object(sync.time, "sleep"):
            with self.assertRaises(sync.SyncError) as raised:
                sync.request_json(sync.Request("https://example.com"))
        self.assertEqual(opening.call_count, 4)
        self.assertEqual(str(raised.exception), "Remote request failed (HTTP 429).")

    def test_batches_are_bounded(self):
        stripe = sync.Stripe("unused")
        sizes = []

        def sender(records):
            sizes.append(len(records))
            return [{"sessionId": r["sessionId"], "status": "test"} for r in records]

        with patch.object(stripe, "sessions", side_effect=lambda link: [SESSION] * 101 if link == "plink_entry" else []), \
                patch.object(stripe, "get", return_value=INTENT):
            counts = sync.sync(stripe, CONFIG, sender)
        self.assertEqual(sizes, [50, 50, 1])
        self.assertEqual(counts["test"], 101)


if __name__ == "__main__":
    unittest.main()
