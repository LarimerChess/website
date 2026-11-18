# Stripe checkout and payment reconciliation

The GitHub Pages payment page lets anyone select active entries for one or more
players without signing in. The Name or US Chess ID field searches club registration
records only, returning at most 12 names and IDs after two typed characters. It
never searches US Chess or private contacts. Historical registrants can be found
even if they have no current balance. The existing registration Apps Script recalculates
all balances, stores a private basket allocation, and creates one Stripe Checkout
Session for the exact total in USD. After selecting entries, the Pay on Stripe
button opens secure Checkout directly; a visible checkout link remains available
if navigation is blocked. Client amounts are never trusted. The club
absorbs processing fees. Donations remain a separate anonymous Payment Link.

## Configure sandbox deployment

1. Deploy `scripts/registration.gs` to the existing registration web app. Add
   `LCCC_STRIPE_SECRET_KEY` to its Script Properties using a Stripe **test** key
   with permission to create Checkout Sessions (and inline prices/products).
   The key stays server-side. GitHub secrets cannot be retrieved to populate this
   property. The publishable key is unused.
2. Add a random secret of at least 32 characters as Script Property and GitHub
   Actions secret `LCCC_STRIPE_SYNC_SECRET`. Configure repository variable
   `LCCC_STRIPE_SYNC_URL` with the existing Apps Script deployment URL.
3. In `stripe-payment-links.json`, keep `livemode: false`, `currency: "usd"`,
   and the legacy entry amount `1750`. Set `dynamicCheckout.enabled: true` and
   `enabled: true` only after the script and its key are ready. Create an optional
   test donation Payment Link and fill in its ID and URL. Legacy entry links may
   remain configured so their historical payments continue to be monitored.
   Empty link IDs disable their legacy scan; dynamic entry checkout needs no
   entry Payment Link.
4. Publish the site and run **Stripe payment sync** manually with dry run checked.
   The Actions `LCCC_STRIPE_SECRET_KEY` needs read access to Checkout Sessions,
   PaymentIntents and Charges. It may be separate from the Apps Script create key.
   Run again without dry run for isolated sandbox imports.
5. Enable scheduled polling only after acceptance passes by setting Actions
   variable `LCCC_STRIPE_SYNC_ENABLED` to `true`.

Keep the private Sheet private. `Stripe checkout baskets` stores registration
allocation and opaque random references; Stripe receives only the reference,
generic entry-fee description and total, without player names, US Chess IDs,
registration-edit credentials or stored contact details. Stripe collects the
payer's receipt/billing information independently; it is never used for matching.

## Text a player payment link

Use `https://larimerchess.org/pay/?id=12345678`, replacing the example eight-digit
ID with the player's actual ID. `?uscfid=12345678` is also accepted. The page loads
that player's balances automatically and labels their group as the player from
the link. Existing saved players remain visible; payable entries start selected.
Opening the link does not save the player or any contact credentials. Invalid
IDs are ignored. A valid ID without active registrations shows that no active
registrations were found. This link cannot change a registration or prove payment.

## Reconciliation and recovery

Actions paginates the entire session history, finding marked `basket_v1` sessions
and configured legacy Payment Links. It verifies complete/paid status, mode,
currency, successful PaymentIntent and captured charge. No date cutoff or runner
cache can hide old refunds or disputes. Only trusted sync requests can import.

Under a script lock, the importer checks the basket mode, session, exact total,
every allocation, current registration and outstanding balance before any new
credit. It writes one ledger row per selected entry and uses the Stripe IDs plus
allocation identity for durable deduplication. Interrupted writes resume missing
allocations and repair entry summaries on retry. A balance changed by another
payer goes to private review instead of overcrediting. A checkout return page
never proves payment. Polling can take longer than 15 minutes.

A browser retries the same unchanged checkout request with the same random
request ID and Stripe idempotency key. Changing selection creates another ID.
Reload balances if an old checkout has expired or the amount changed.

**Test mode never credits the live Payments ledger or marks real registrations
paid.** It validates the full basket and records one isolated row in `Stripe test
payments`; exceptions go to `Stripe test review`. Repeated sandbox checkout does
not reduce the real balance. Live exceptions use `Stripe review`.

Refunds/disputes never invent ledger reversals. They flag all affected players'
entries for the TD and retain the original payment facts. Reconcile the actual
refund/dispute and any moved credits privately, clear affected Entries payment
review flags, then mark the matching review row `Resolution` as lowercase
`resolved`. The row's Snapshot identifies the reviewed reversal state; changed
states reopen review. No code here issues Stripe refunds.

Anonymous donations never create player contacts. Missing/altered basket
references and unexpected amounts are reviewed, never reclassified as donations.

## Acceptance and live rollout

- Pay two players' entries with unequal balances in a single sandbox checkout;
  verify the exact total, one isolated record and no live balance change.
- Repeat sync, interrupt allocation writes in tests, and confirm no duplicate
  credits. Test changed balances, another payer, withdrawn/moved registrations,
  wrong mode, wrong references and abandoned/unpaid checkout.
- Complete an anonymous test donation. Refund/dispute test payments and verify
  review flags. Confirm wrong sync secrets fail and dry run makes no writes.
- Before real payments, explicitly switch both server/Actions keys and public
  configuration to live mode together. Complete a separately approved live
  acceptance check. Tax, discounts, shipping, adaptive pricing and currency
  conversion are not enabled in the exact-total basket flow.
- Pause scheduling by removing `LCCC_STRIPE_SYNC_ENABLED`. Stop new checkout by
  disabling public configuration. Monitor failed/missing Actions runs.

Developer checks: `npm run test:payments` and
`.venv/Scripts/python.exe -m unittest discover -s tests -p test_sync_stripe_payments.py`.
Never put keys in command arguments, logs or commits.

Official references: [create Checkout Sessions](https://docs.stripe.com/api/checkout/sessions/create),
[list Sessions](https://docs.stripe.com/api/checkout/sessions/list),
[idempotent requests](https://docs.stripe.com/api/idempotent_requests),
[restricted keys](https://docs.stripe.com/keys/restricted-api-keys).
