"""Receive signed Stripe events and reconcile the affected checkout or intent."""

import hashlib
import hmac
import json
import os
import re
import time
from urllib.request import Request

from sync_stripe_payments import (
    Stripe, SyncError, backend_sender, intent_record, payment_record, request_json, validate_config,
)

CONFIG_URL = "https://larimerchess.org/stripe-payment-links.json"
SESSION_EVENTS = {"checkout.session.completed", "checkout.session.async_payment_succeeded"}
INTENT_EVENTS = {"payment_intent.succeeded", "payment_intent.processing", "payment_intent.payment_failed",
                 "payment_intent.canceled"}


def signed_payload(raw, signature, secret, now):
    timestamps, signatures = [], []
    for part in signature.split(","):
        name, _, value = part.strip().partition("=")
        if name == "t":
            timestamps.append(value)
        elif name == "v1":
            signatures.append(value)
    if len(timestamps) != 1 or not re.fullmatch(r"[0-9]{1,12}", timestamps[0]):
        return False
    timestamp = timestamps[0]
    if abs(now - int(timestamp)) > 300:
        return False
    digest = hmac.new(secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256).hexdigest()
    return any(re.fullmatch(r"[a-f0-9]{64}", value) and hmac.compare_digest(digest, value) for value in signatures)


def event_record(event, stripe, config):
    """Use the event only to locate the current object in Stripe."""
    if event.get("livemode") is not config["livemode"]:
        raise SyncError("Stripe event mode does not match the receiver.")
    event_type = event.get("type")
    if event_type not in SESSION_EVENTS and event_type not in INTENT_EVENTS:
        return None
    object_id = event["data"]["object"]["id"]
    expansion = {"expand[]": "latest_charge.balance_transaction"}
    if event_type in SESSION_EVENTS:
        mode = "live" if config["livemode"] else "test"
        if not re.fullmatch(rf"cs_{mode}_[A-Za-z0-9]+", object_id):
            raise SyncError("Invalid Checkout Session identifier.")
        session = stripe.get("checkout/sessions/" + object_id)
        if session.get("id") != object_id:
            raise SyncError("Checkout Session identifier changed.")
        link = session.get("payment_link")
        if not link and (session.get("metadata") or {}).get("lccc_checkout") == "basket_v1":
            kind, checkout_type = "entry", "basket_v1"
        else:
            kind = next((name for name in ("entry", "donation")
                         if link and config[name].get("paymentLinkId") == link), None)
            checkout_type = ""
        if not kind or session.get("payment_status") != "paid" or session.get("status") != "complete":
            return None
        intent_id = session.get("payment_intent")
        if not isinstance(intent_id, str) or not re.fullmatch(r"pi_[A-Za-z0-9]+", intent_id):
            raise SyncError("Paid session has no valid PaymentIntent.")
        intent = stripe.get("payment_intents/" + intent_id, expansion)
        record = payment_record(session, intent, config, kind, checkout_type)
    else:
        if not re.fullmatch(r"pi_[A-Za-z0-9]+", object_id):
            raise SyncError("Invalid PaymentIntent identifier.")
        intent = stripe.get("payment_intents/" + object_id, expansion)
        if intent.get("id") != object_id:
            raise SyncError("PaymentIntent identifier changed.")
        if (intent.get("metadata") or {}).get("lccc_checkout") != "payment_intent_v1":
            return None
        record = intent_record(intent, config)
    if record and "feeCents" in record and (record["refundCents"] or record["disputed"]):
        record["adjustments"] = stripe.reversals(intent["latest_charge"])
    return record


def deliver(event):
    config = request_json(Request(CONFIG_URL))
    key = os.environ.get("LCCC_STRIPE_SECRET_KEY", "")
    validate_config(config, key)
    record = event_record(event, Stripe(key), config)
    if record is None:
        return
    result, = backend_sender()([record])
    # Retry a successful charge until the settled amount and fee have been imported.
    if record.get("paymentStatus") == "paid" and (result["status"] == "pending" or "feeCents" not in record):
        raise SyncError("Stripe settlement is pending.")


def app(environ, start_response):
    def respond(status):
        start_response(status, [("Content-Length", "0")])
        return [b""]

    if environ.get("REQUEST_METHOD") != "POST":
        return respond("405 Method Not Allowed")
    secret = os.environ.get("LCCC_STRIPE_WEBHOOK_SECRET", "")
    if not secret.startswith("whsec_"):
        return respond("503 Service Unavailable")
    length = environ.get("CONTENT_LENGTH", "")
    if not re.fullmatch(r"[0-9]{1,7}", length) or not 0 < int(length) <= 1_048_576:
        return respond("400 Bad Request")
    raw = environ["wsgi.input"].read(int(length))
    if not signed_payload(raw, environ.get("HTTP_STRIPE_SIGNATURE", ""), secret, time.time()):
        return respond("400 Bad Request")
    try:
        event = json.loads(raw)
        if not isinstance(event, dict) or not re.fullmatch(r"evt_[A-Za-z0-9]+", event.get("id", "")):
            return respond("400 Bad Request")
        deliver(event)
    except Exception:
        return respond("503 Service Unavailable")
    return respond("204 No Content")
