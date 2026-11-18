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
