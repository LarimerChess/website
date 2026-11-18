import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { stripeURL, verifiedLink, requestFor } = createRequire(import.meta.url)("../pay.js");
const config = { enabled: true, livemode: false, entry: { url: "https://buy.stripe.com/test_fixture" } };
const result = { ok: true, url: `${config.entry.url}?client_reference_id=payment_only_1234567890`, amount: 1750, currency: "usd", livemode: false };

test("only the configured Stripe link with a payment reference may open", () => {
  assert.equal(verifiedLink(result, config), result.url);
  for (const url of ["javascript:alert(1)", "https://buy.stripe.com.evil.test/a", "https://evil.test/a", "https://user@buy.stripe.com/a"])
    assert.equal(stripeURL(url), null);
  for (const change of [{ url: config.entry.url }, { url: "https://buy.stripe.com/another?client_reference_id=payment_only_1234567890" },
    { amount: 750 }, { currency: "eur" }, { livemode: true }, { ok: false }]) {
    assert.throws(() => verifiedLink({ ...result, ...change }, config));
  }
  assert.throws(() => verifiedLink(result, { ...config, enabled: false }));
});

test("month entries pay the month; individual entries pay the exact event date without credentials", () => {
  const event = { key: "club-night/2026-11-23" };
  assert.deepEqual(Object.fromEntries(requestFor(event, { id: "12345678", for: "Whole month" })),
    { action: "paymentLink", event: "club-night", date: "2026-11", id: "12345678" });
  assert.equal(requestFor(event, { id: "12345678", for: "One night" }).get("date"), "2026-11-23");
});

test('combined hosted checkout verifies server total, selection size, host and mode', () => {
  const { verifiedCheckout } = createRequire(import.meta.url)('../pay.js');
  const c={enabled:true,livemode:false,dynamicCheckout:{enabled:true}};
  const r={ok:true,checkoutUrl:'https://checkout.stripe.com/c/pay/cs_test_fixture',amount:3000,count:2,currency:'usd',livemode:false};
  assert.equal(verifiedCheckout(r,c,3000,2),r.checkoutUrl);
  for (const patch of [{amount:2999},{count:1},{livemode:true},{currency:'eur'},{checkoutUrl:'https://checkout.stripe.com.evil.test/pay'},{checkoutUrl:'https://user@checkout.stripe.com/pay'}]) assert.throws(() => verifiedCheckout({...r,...patch},c,3000,2));
});


test("textable payment links accept exact IDs and the uscfid alias without trusting malformed input", () => {
  const { requestedPlayerId } = createRequire(import.meta.url)("../pay.js");
  assert.equal(requestedPlayerId("?id=12345678"),"12345678");
  assert.equal(requestedPlayerId("?uscfid=87654321"),"87654321");
  assert.equal(requestedPlayerId("?id=12345678&uscfid=87654321"),"12345678");
  for (const search of ["", "?id=123", "?uscfid=123456789", "?id=bad&uscfid=87654321", "?id=%3Cscript%3E", "?id=%2012345678"]) assert.equal(requestedPlayerId(search),null);
});

test('card flow requires matching publishable-key mode and live compliance readiness', () => {
  const {cardEnabled}=createRequire(import.meta.url)('../pay.js');
  const c={enabled:true,livemode:false,cardProcessing:{enabled:true,publishableKey:'pk_test_fixture',complianceReady:false}};
  assert.equal(cardEnabled(c),true);
  assert.equal(cardEnabled({...c,livemode:true}),false);
  assert.equal(cardEnabled({...c,livemode:true,cardProcessing:{...c.cardProcessing,publishableKey:'pk_live_fixture',complianceReady:true}}),true);
  assert.equal(cardEnabled({...c,cardProcessing:{...c.cardProcessing,enabled:false}}),false);
});

test('card quote must equal the selected entry total with no card fee', () => {
  const {verifiedQuote}=createRequire(import.meta.url)('../pay.js');
  const c={enabled:true,livemode:false,cardProcessing:{enabled:true,publishableKey:'pk_test_fixture'}};
  const q={ok:true,quoteId:'quote_abcdefghijklmnop',subtotal:5000,cardFee:0,amount:5000,count:4,currency:'usd',livemode:false};
  assert.equal(verifiedQuote(q,c,5000,4),q);
  for(const patch of [{subtotal:4999},{cardFee:1,amount:5001},{cardFee:-1,amount:4999},{cardFee:1.5,amount:5001.5},{amount:5001},{count:3},{currency:'eur'},{livemode:true},{quoteId:'bad'},{ok:false}]) {
    assert.throws(()=>verifiedQuote({...q,...patch},c,5000,4));
  }
});

test('card confirmation validates gross and intent before any authentication action', () => {
  const {verifiedCardPayment}=createRequire(import.meta.url)('../pay.js');
  const c={enabled:true,livemode:false,cardProcessing:{enabled:true,publishableKey:'pk_test_fixture'}};
  const r={ok:true,paymentIntentId:'pi_fixture',clientSecret:'pi_fixture_secret_private',status:'requires_action',amount:5000,currency:'usd',livemode:false};
  assert.equal(verifiedCardPayment(r,c,5000),r);
  for(const patch of [{amount:5000},{paymentIntentId:'pi_other'},{clientSecret:null},{clientSecret:'pi_other_secret_bad'},{status:'unknown'},{livemode:true},{currency:'eur'}]) assert.throws(()=>verifiedCardPayment({...r,...patch},c,5150));
  assert.equal(verifiedCardPayment({...r,status:'succeeded',clientSecret:null},c,5000).status,'succeeded');
});
