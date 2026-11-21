import hashlib
import hmac
from io import BytesIO
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from test_sync_stripe_payments import CONFIG, INTENT, SESSION

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import stripe_webhook as webhook


class StripeWebhookTests(unittest.TestCase):
    def test_signature_checked_before_delivery_and_errors_retry(self):
        event = {"id": "evt_test", "type": "checkout.session.completed"}
        raw = json.dumps(event).encode()
        digest = hmac.new(b"whsec_local", b"1000." + raw, hashlib.sha256).hexdigest()

        def request(body):
            response = Mock()
            webhook.app({"REQUEST_METHOD": "POST", "CONTENT_LENGTH": str(len(body)),
                         "wsgi.input": BytesIO(body), "HTTP_STRIPE_SIGNATURE": f"t=1000,v1={digest}"}, response)
            return response.call_args.args[0]

        with patch.dict("os.environ", {"LCCC_STRIPE_WEBHOOK_SECRET": "whsec_local"}), \
                patch.object(webhook, "deliver") as deliver, patch.object(webhook.time, "time", return_value=1005) as clock:
            self.assertEqual(request(raw + b" "), "400 Bad Request")
            clock.return_value = 1301
            self.assertEqual(request(raw), "400 Bad Request")
            deliver.assert_not_called()
            clock.return_value = 1005
            self.assertEqual(request(raw), "204 No Content")
            deliver.assert_called_once_with(event)
            deliver.side_effect = webhook.SyncError("Temporary backend failure")
            self.assertEqual(request(raw), "503 Service Unavailable")

    def test_only_authoritative_stripe_object_determines_amount(self):
        stripe = Mock()
        stripe.get.side_effect = [SESSION, INTENT]
        event = {"type": "checkout.session.completed", "livemode": False,
                 "data": {"object": {"id": SESSION["id"], "amount_total": 1}}}
        record = webhook.event_record(event, stripe, CONFIG)
        self.assertEqual(record["amountCents"], 1750)
        self.assertNotIn("billing_details", record)
        stripe.get.reset_mock(side_effect=True)
        stripe.get.return_value = {**SESSION, "payment_link": "plink_unrelated"}
        self.assertIsNone(webhook.event_record(event, stripe, CONFIG))
        stripe.get.assert_called_once_with("checkout/sessions/" + SESSION["id"])

    def test_settlement_not_ready_is_retried_after_backend_handoff(self):
        with patch.dict("os.environ", {"LCCC_STRIPE_SECRET_KEY": "rk_test_fixture"}), \
                patch.object(webhook, "request_json", return_value=CONFIG), \
                patch.object(webhook, "event_record", return_value={"paymentStatus": "paid"}) as record, \
                patch.object(webhook, "backend_sender") as backend:
            sender = backend.return_value
            sender.return_value = [{"status": "imported"}]
            with self.assertRaises(webhook.SyncError):
                webhook.deliver({})
            sender.assert_called_once_with([{"paymentStatus": "paid"}])
            record.return_value["feeCents"] = 73
            webhook.deliver({})
