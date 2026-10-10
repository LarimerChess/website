// Tests for scripts/rating_check.mjs against the results fixtures and US Chess's, tests/fixtures/uschess.json.
//   node --test tests/test_rating_check.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check, ratedEvent, endedOn, USChess } from "../scripts/rating_check.mjs";

const fixtures = JSON.parse(readFileSync(new URL("fixtures/tournaments.json", import.meta.url), "utf8")).tournaments;
const US_CHESS = new USChess(new URL("fixtures/uschess.json", import.meta.url).pathname);
const EMAILS = { 31847334: "td@example.org" };
const quiet = () => {};

function saturday(changes = {}) {
  const t = structuredClone(fixtures.find((x) => x.key === "first-saturday-classic/2026-11-07"));
  return { ...t, status: "running", td: "31847334", ...changes };
}

test("the same results make it rated", async () => {
  assert.deepEqual(await check(saturday(), "2026-11-08 10:17", US_CHESS, EMAILS, quiet), { rated: "202611070123" });
});

test("a different result, a missing one, and a missing player are each named", async () => {
  const t = saturday();
  t.rounds[2].games[1].result = "1/2-1/2";
  t.rounds[0].games[0].result = "";
  t.players.push({ id: "90000009", number: 6, name: "Fay Fir", rating: null, out: null });
  t.rounds[3].byes.push({ id: "90000009", points: 1, kind: "bye" });
  const { event, found } = await ratedEvent(t, US_CHESS);
  assert.equal(event.id, "202611070123");
  assert.deepEqual(found, [
    "Fay Fir (90000009) isn't in US Chess's event.",
    "Ada Alder, round 1: on the desk, a game against Cal Cedar as White with no result; on US Chess, won against Cal Cedar as White.",
    "Ben Birch, round 3: on the desk, drew against Cal Cedar as Black; on US Chess, won against Cal Cedar as Black.",
    "Cal Cedar, round 1: on the desk, a game against Ada Alder as Black with no result; on US Chess, lost against Ada Alder as Black.",
    "Cal Cedar, round 3: on the desk, drew against Ben Birch as White; on US Chess, lost against Ben Birch as White."]);
});

test("reminders come at 9:00 AM each day from 24 hours after the day play ended, to the chief TD and the President", async () => {
  const t = saturday({ key: "first-saturday-classic/2026-11-14" });
  t.rounds.at(-1).postedAt = "2026-11-14 17:05";
  assert.equal(endedOn(t, "2026-11-14 18:00"), "2026-11-14");
  assert.deepEqual(await check(t, "2026-11-15 09:17", US_CHESS, EMAILS, quiet), {}, "not 24 hours after the day ended yet");
  assert.deepEqual(await check(t, "2026-11-16 08:17", US_CHESS, EMAILS, quiet), {});
  const { remind } = await check(t, "2026-11-16 09:17", US_CHESS, EMAILS, quiet);
  assert.deepEqual(remind.to, ["td@example.org", "president@larimerchess.org"]);
  assert.equal(remind.subject, "Rating report due: First Saturday Classic, Saturday, November 7, 2026");
  assert.match(remind.body, /^Play in the .* ended November 14, 2026\.\nUS Chess doesn't show it rated yet\./);
  assert.ok((await check(t, "2026-11-17 09:17", US_CHESS, EMAILS, quiet)).remind);
  const nobody = await check({ ...t, td: "" }, "2026-11-17 09:17", US_CHESS, EMAILS, quiet);
  assert.deepEqual(nobody.remind.to, ["president@larimerchess.org"]);
  assert.match(nobody.remind.body, /President only/);
});

test("play goes on until the planned rounds are in, or the event's last day is over", () => {
  const t = saturday({ key: "first-saturday-classic/2026-11-14", plannedRounds: 5 });
  assert.equal(endedOn(t, "2026-11-14 23:59"), null);
  assert.equal(endedOn(t, "2026-11-15 00:00"), "2026-11-14");
  assert.equal(endedOn({ ...t, key: "monday-club-night-at-peak/2026-02" }, "2026-02-28 23:00"), null);
  assert.equal(endedOn({ ...t, key: "monday-club-night-at-peak/2026-02" }, "2026-03-01 00:00"), "2026-02-28");
});
