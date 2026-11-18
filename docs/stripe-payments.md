# Stripe checkout and payment reconciliation

The GitHub Pages payment page lets anyone select active entries for one or more
players without signing in. The Name or US Chess ID field searches club registration
records only, returning at most 12 names and IDs after two typed characters. It
never searches US Chess or private contacts. Historical registrants can be found
even if they have no current balance. The existing registration Apps Script recalculates
all balances, stores a private basket allocation, and creates one Stripe Checkout
Session for the exact total in USD. After selecting entries, the Pay on Stripe
button opens secure Checkout directly; a visible checkout link remains available
if navigation is blocked. Client amounts are never trusted. The club absorbs
processing costs for online payments. Donations remain a separate anonymous
Payment Link.

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
request ID. Each new basket durably stores its contract version, Stripe API
version, exact form payload and versioned idempotency key before contacting
Stripe; retries replay that nonsecret descriptor unchanged. No Stripe key is
stored in the basket. A saved successful checkout URL is reused. Pending baskets
from before this descriptor was introduced require a page reload to start a new
reference; they never silently rotate keys after an uncertain outcome. Future
payload changes must introduce a new contract while preserving existing request
snapshots. Stripe idempotency errors show explicit reload guidance. Changing
selection creates another browser request ID.

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

## Card payments

`cardProcessing.enabled` selects the Payment Element flow. Keep it false until the
latest `scripts/registration.gs` is deployed as a new version of the existing web
app. The publishable key is public browser configuration; secret keys remain in
Script Properties and GitHub secrets. Sandbox mode permits testing with
`complianceReady: false`; live mode requires that flag to be explicitly true after
applicable merchant/acquirer notification and surcharge requirements are met.
The flag is a deployment gate, not a substitute for those requirements.

After balances load, the secure Stripe card form appears automatically. The player
enters card details and presses the single Pay button. The club absorbs card
processing costs; the Stripe amount is exactly the selected entry balance. The
server retrieves a ConfirmationToken and records a zero Card fee. This online
payment policy does not change in-person TD accounting or the event's entry fees.

New quotes in **Stripe card quotes** store immutable allocations, subtotal, zero
Card fee, total, token identifier, funding classification, and exact confirmation
request. They contain no card number or client secret. Confirmation uses the same
token and durable idempotency key; a consumed token recovers the existing intent
following an interrupted sheet write. Other unsettled payments for overlapping
entries block a second confirmation until reconciliation. Existing fee-bearing
quotes continue to reconcile, but an unconfirmed old quote cannot charge a fee.
Test reservations clear after their isolated test import; they never change live
balances.

The sync reads both Checkout sessions and standalone marked PaymentIntents.

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


## Funding-aware card payments

`cardProcessing.enabled` selects the Payment Element flow. Keep it false until the
latest `scripts/registration.gs` is deployed as a new version of the existing web
app. The publishable key is public browser configuration; secret keys remain in
Script Properties and GitHub secrets. Sandbox mode permits testing with
`complianceReady: false`; live mode requires that flag to be explicitly true after
applicable merchant/acquirer notification and surcharge requirements are met.
The flag is a deployment gate, not a substitute for those requirements.

The player selects entries, enters card details directly in Stripe's iframe,
reviews the exact Card fee and total, then explicitly presses Pay. Opening the
form and reviewing the fee never confirms a payment. The server retrieves a
ConfirmationToken and uses Stripe's trusted funding classification. Credit cards
use the existing `prices.json` 2.5% plus $0.50 calculation, limited to the lesser
of that amount, a configured processing-cost estimate, and 3% of the entry
subtotal rounded down to whole cents. Debit, prepaid, and unknown funding have
no required Card fee. An unchecked optional additional-cost checkbox can add
estimated uncovered costs, while the total Card fee still cannot exceed 3%.
Existing `prices.json` fees and TD accounting calculations are unchanged.

The separate `cardProcessing.rateBasisPoints: 290` and `fixedCents: 30` estimate
standard domestic Stripe card processing; settlement costs can differ. These
values are not an assertion of the actual settlement fee. The server uses integer
cents and a rounded estimate, with one fixed component per combined payment.
At a $17.50 subtotal, the 3% ceiling is $0.52. At $200, the existing formula gives
$5.50; optional additional coverage can raise the total Card fee to at most $6.

Quotes in **Stripe card quotes** store the immutable allocations, subtotal, Card
fee, gross total, token identifier, funding classification, and exact confirmation
request. They contain no card number or client secret. Confirmation uses the same
token and durable idempotency key; a consumed token recovers the existing intent
following an interrupted sheet write. Other unsettled payments for overlapping
entries block a second confirmation until reconciliation. Unused or declined
quotes do not reserve debt. Test reservations clear after their isolated test
import; they never change live balances.

The sync reads both Checkout sessions and standalone marked PaymentIntents.
It verifies the gross charge but credits only entry/rating allocations; the Card
fee is recorded separately on the first allocation's ledger row. Existing Paid
summaries retain gross-received semantics. Partial ledger writes resume without
repeating either debt credit or the fee. Test records use the existing isolated
test tabs. Refunds and disputes continue to require review.

Official integration references: [server-side finalization](https://docs.stripe.com/payments/finalize-payments-on-the-server?platform=web&type=payment),
[ConfirmationToken funding preview](https://docs.stripe.com/api/confirmation_tokens/object),
and [Stripe API schema](https://github.com/stripe/openapi/blob/master/openapi/spec3.json).
Checkout funding restrictions do not include `unknown`; they cannot provide the
same fail-closed funding classification for this fee policy.


## Pending verification

After a confirmed card submission, every selected entry shows **Payment pending
verification** and cannot be selected again. For live payments, this state comes
from the durable confirmation request and survives a reload. It is not a Paid
credit. Actions must verify a succeeded, captured charge before importing entry
and rating credit. Processing/authentication/capture-pending intents remain
pending. Verified declines and cancellations release the reservation without
writing payment credit. Lifecycle records are authenticated with the same sync
secret and validated against the stored quote, gross amount, mode, and intent.

If creation succeeded but saving the intent ID was interrupted, the durable
request still reserves the entries; sync can recover and bind the verified
intent. An uncertain transport failure can remain pending until the tournament
director reconciles it. Do not repay merely because confirmation was interrupted.
A quote that was only reviewed, without a final confirmation request, does not
reserve entries.

Sandbox submissions show **Test payment pending verification** for their exact
selected registrations. This server-derived test state survives a refresh while
the site is in sandbox mode. A verified isolated test import or verified failure
clears it; it never changes real balances, Paid summaries, or the live ledger.
Switching the site to live mode excludes sandbox reservations. Test imports remain
isolated.

Pending verification clears through a scheduled or manually dispatched Stripe
payment-sync Action. Scheduling is currently disabled unless the repository
variable `LCCC_STRIPE_SYNC_ENABLED` is explicitly set to `true`; with it unset,
run the Action manually with `dry_run: false`. A dry run reads Stripe but cannot
update pending states or credit any ledger.
