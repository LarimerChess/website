#!/usr/bin/env python3
"""Poll club Checkout sessions without writing payment details to disk or logs."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
API_VERSION = "2026-10-28.endive"


class SyncError(Exception):
    """Safe-to-log operational error (never contains an API response body)."""


def request_json(request):
    for attempt in range(4):
        try:
            with urlopen(request, timeout=45) as response:
                return json.load(response)
        except HTTPError as error:
            if (error.code == 429 or error.code >= 500) and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise SyncError(f"Remote request failed (HTTP {error.code}).") from None
        except (URLError, TimeoutError):
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise SyncError("Remote request timed out or could not connect.") from None
        except (ValueError, UnicodeError):
            raise SyncError("Remote response was not valid JSON.") from None


def validate_config(config, key):
    if config.get("enabled") is not True:
        raise SyncError("Stripe payment links are disabled; complete setup first.")
    if type(config.get("livemode")) is not bool or config.get("currency") != "usd":
        raise SyncError("Expected explicit Stripe mode and USD currency.")
    mode = "live" if config["livemode"] else "test"
    if not re.fullmatch(r"[sr]k_" + mode + r"_[A-Za-z0-9]+", key):
        raise SyncError("Stripe key is missing or does not match configured mode.")
    ids = []
    for kind in ("entry", "donation"):
        link = config.get(kind, {}).get("paymentLinkId", "")
        if not link and config.get("dynamicCheckout", {}).get("enabled") is True:
            continue
        if not re.fullmatch(r"plink_[A-Za-z0-9]+", link):
            raise SyncError("Both Payment Link IDs must be configured.")
        ids.append(link)
    if len(ids) != len(set(ids)) or config["entry"].get("amount") != 1750:
        raise SyncError("Expected distinct links and a 1750-cent entry fee.")


class Stripe:
    def __init__(self, key):
        self.key = key

    def get(self, path, params=None):
        query = "?" + urlencode(params or {}, doseq=True)
        return request_json(Request("https://api.stripe.com/v1/" + path + query,
                                    headers={"Authorization": "Bearer " + self.key,
                                             "Stripe-Version": API_VERSION}))

    def sessions(self, link=None):
        params = {"limit": 100}
        if link is not None:
            params["payment_link"] = link
        return self.pages("checkout/sessions", params)

    def intents(self):
        return self.pages("payment_intents", {"limit": 100, "expand[]": "data.latest_charge"})

    def pages(self, path, params):
        seen = set()
        while True:
            page = self.get(path, params)
            if not isinstance(page.get("data"), list) or type(page.get("has_more")) is not bool:
                raise SyncError("Unexpected Stripe pagination response.")
            yield from page["data"]
            if not page["has_more"]:
                return
            if not page["data"]:
                raise SyncError("Stripe returned an empty unfinished page.")
            cursor = page["data"][-1].get("id")
            if not cursor or cursor in seen:
                raise SyncError("Stripe pagination did not advance.")
            seen.add(cursor)
            params["starting_after"] = cursor


def intent_record(intent, config):
    """Verify standalone payments; preserve reversal facts for backend review."""
    metadata = intent.get("metadata")
    intent_id = intent.get("id")
    if (not isinstance(metadata, dict) or metadata.get("lccc_checkout") != "payment_intent_v1"
            or not isinstance(intent_id, str) or not re.fullmatch(r"pi_[A-Za-z0-9]+", intent_id)):
        raise SyncError("A standalone payment failed source validation.")
    state = intent.get("status")
    if state != "succeeded":
        if state not in ("processing", "requires_action", "requires_confirmation", "requires_capture",
                         "requires_payment_method", "canceled"):
            raise SyncError("A standalone payment has an unknown lifecycle state.")
        amount = intent.get("amount")
        if (type(amount) is not int or amount <= 0 or intent.get("currency") != config["currency"]
                or intent.get("livemode") is not config["livemode"]):
            raise SyncError("A standalone lifecycle record failed amount, currency, or mode validation.")
        return {"sessionId": "", "paymentIntentId": intent_id,
                "clientReferenceId": metadata.get("lccc_reference") or "",
                "checkoutType": "payment_intent_status_v1", "kind": "basket_intent_status",
                "amountCents": amount, "currency": intent["currency"], "livemode": intent["livemode"],
                "created": intent.get("created"), "intentStatus": state}
    charge = intent.get("latest_charge")
    if (not isinstance(charge, dict) or charge.get("status") != "succeeded"
            or charge.get("payment_intent") != intent_id):
        raise SyncError("A standalone payment failed charge validation.")
    # Reuse the settled-payment checks without allowing metadata to set amounts
    # or allocations. The backend resolves the reference against its basket.
    session = {"id": "", "payment_status": "paid", "status": "complete", "mode": "payment",
               "livemode": intent.get("livemode"), "currency": intent.get("currency"),
               "payment_link": None, "payment_intent": intent_id, "amount_total": intent.get("amount"),
               "metadata": {"lccc_checkout": "basket_v1"},
               "client_reference_id": metadata.get("lccc_reference"), "created": intent.get("created")}
    record = payment_record(session, intent, config, "entry", "basket_v1")
    record.update(kind="basket_intent", checkoutType="payment_intent_v1")
    return record


def payment_record(session, intent, config, kind, checkout_type=""):
    """Discard unconfirmed payments; pass anomalies to the private review queue."""
    if session.get("payment_status") != "paid" or session.get("status") != "complete":
        return None
    basket = checkout_type == "basket_v1"
    metadata = session.get("metadata")
    if basket:
        valid_source = (kind == "entry" and not session.get("payment_link")
                        and isinstance(metadata, dict) and metadata.get("lccc_checkout") == "basket_v1")
    else:
        valid_source = not checkout_type and session.get("payment_link") == config[kind]["paymentLinkId"]
    if (session.get("mode") != "payment" or session.get("livemode") is not config["livemode"]
            or session.get("currency") != config["currency"]
            or not valid_source):
        raise SyncError("A paid session failed mode, currency, or link validation.")
    amount = session.get("amount_total")
    charge = intent.get("latest_charge")
    if (type(amount) is not int or amount <= 0 or not isinstance(charge, dict)
            or intent.get("id") != session.get("payment_intent")
            or intent.get("status") != "succeeded" or intent.get("amount_received") != amount
            or intent.get("currency") != config["currency"]
            or intent.get("livemode") is not config["livemode"]
            or charge.get("paid") is not True or charge.get("captured") is not True
            or charge.get("amount") != amount or charge.get("currency") != config["currency"]
            or charge.get("livemode") is not config["livemode"]):
        raise SyncError("A paid session failed payment verification.")
    refunded = charge.get("amount_refunded")
    if type(refunded) is not int or not 0 <= refunded <= amount or type(charge.get("disputed")) is not bool:
        raise SyncError("A charge has invalid reversal information.")
    receipt_url = charge.get("receipt_url")
    if receipt_url is not None and (not isinstance(receipt_url, str)
                                    or not re.fullmatch(r"https://pay\.stripe\.com/receipts/[A-Za-z0-9/_?=&%-]+", receipt_url)):
        raise SyncError("A charge has an invalid receipt URL.")
    # Wrong amounts and missing references are retained for backend review, never
    # silently dropped. Backend also checks the registration's current balance.
    return {"sessionId": session["id"], "paymentIntentId": intent["id"],
            "paymentLinkId": session.get("payment_link") or "", "clientReferenceId": session.get("client_reference_id") or "",
            **({"checkoutType": "basket_v1"} if basket else {}),
            "amountCents": amount, "currency": session["currency"], "livemode": session["livemode"],
            "paymentStatus": "paid", "status": "complete", "kind": kind,
            "refundCents": refunded, "disputed": charge["disputed"], "created": session.get("created"),
            "receiptUrl": receipt_url or ""}


def send_records(endpoint, secret, records):
    data = urlencode({"action": "stripeSync", "syncSecret": secret,
                      "records": json.dumps(records, separators=(",", ":"))}).encode()
    response = request_json(Request(endpoint, data=data,
                                    headers={"Content-Type": "application/x-www-form-urlencoded"}))
    results = response.get("results", [])
    if (response.get("ok") is not True or len(results) != len(records)
            or [r.get("sessionId") for r in results] != [r["sessionId"] for r in records]
            or any(not record["sessionId"] and result.get("paymentIntentId") != record["paymentIntentId"]
                   for record, result in zip(records, results))
            or any(r.get("status") not in ("imported", "duplicate", "review", "test", "pending", "failed") for r in results)
            or any(record.get("checkoutType") == "payment_intent_status_v1" and result.get("status") == "imported"
                   for record, result in zip(records, results))):
        raise SyncError("Registration backend did not acknowledge the entire batch.")
    return results


def sync(stripe, config, sender=None):
    counts = {"verified": 0, "skipped": 0, "imported": 0, "duplicate": 0, "review": 0, "test": 0,
              "pending": 0, "failed": 0}
    batch = []
    checkout_intents = set()

    def flush():
        if batch and sender:
            for result in sender(batch):
                counts[result["status"]] += 1
        batch.clear()

    # Full history is deliberate: it catches late settlements, refunds and
    # disputes without a runner cache or a lossy timestamp checkpoint.
    for kind, link, checkout_type in (("entry", config["entry"]["paymentLinkId"], ""),
                                      ("donation", config["donation"]["paymentLinkId"], ""),
                                      ("entry", None, "basket_v1")):
        if not checkout_type and not link:
            continue
        for session in stripe.sessions(link):
            if isinstance(session.get("payment_intent"), str):
                checkout_intents.add(session["payment_intent"])
            if checkout_type:
                # Stripe has no metadata list filter; inspect the full history
                # and exclude Payment Links already handled by the scans above.
                metadata = session.get("metadata")
                if (session.get("payment_link") or not isinstance(metadata, dict)
                        or metadata.get("lccc_checkout") != checkout_type):
                    continue
            if session.get("payment_status") != "paid" or session.get("status") != "complete":
                counts["skipped"] += 1
                continue
            intent_id = session.get("payment_intent", "")
            if not isinstance(intent_id, str) or not re.fullmatch(r"pi_[A-Za-z0-9]+", intent_id):
                raise SyncError("Paid session has no valid PaymentIntent.")
            intent = stripe.get("payment_intents/" + intent_id, {"expand[]": "latest_charge"})
            batch.append(payment_record(session, intent, config, kind, checkout_type))
            counts["verified"] += 1
            if len(batch) == 50:
                flush()
    for intent in stripe.intents():
        metadata = intent.get("metadata")
        if (not isinstance(metadata, dict) or metadata.get("lccc_checkout") != "payment_intent_v1"
                or intent.get("id") in checkout_intents):
            continue
        record = intent_record(intent, config)
        if record is None:
            counts["skipped"] += 1
            continue
        batch.append(record)
        counts["verified"] += 1
        if len(batch) == 50:
            flush()
    flush()
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Read Stripe only; do not update registrations")
    args = parser.parse_args()
    try:
        config = json.loads((ROOT / "stripe-payment-links.json").read_text(encoding="utf-8"))
        key = os.environ.get("LCCC_STRIPE_SECRET_KEY", "")
        validate_config(config, key)
        sender = None
        if not args.dry_run:
            endpoint = os.environ.get("LCCC_STRIPE_SYNC_URL", "")
            secret = os.environ.get("LCCC_STRIPE_SYNC_SECRET", "")
            parsed = urlparse(endpoint)
            if (parsed.scheme != "https" or parsed.netloc != "script.google.com"
                    or not re.fullmatch(r"/macros/s/[A-Za-z0-9_-]+/exec", parsed.path)
                    or parsed.query or parsed.fragment or len(secret) < 32):
                raise SyncError("Configure Apps Script deployment URL and a sync secret of at least 32 characters.")
            sender = lambda records: send_records(endpoint, secret, records)
        counts = sync(Stripe(key), config, sender)
        print(("Dry run: " if args.dry_run else "Sync: ") + json.dumps(counts, sort_keys=True))
        if counts["review"]:
            print("Payments need review in the private Stripe review sheet.", file=sys.stderr)
            return 2
        return 0
    except SyncError as error:
        print(str(error), file=sys.stderr)
    except Exception:
        # Never expose remote payloads, registration references or credentials.
        print("Payment sync failed; check configuration and private Stripe/backend records.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
