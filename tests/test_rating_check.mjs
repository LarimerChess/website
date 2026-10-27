// Tests for scripts/rating_check.mjs against the results fixtures and US Chess's, tests/fixtures/uschess.json.
//   node --test tests/test_rating_check.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check, ratedDates, ratedEvent, endedOn, USChess } from "../scripts/rating_check.mjs";

const fixtures = JSON.parse(readFileSync(new URL("fixtures/tournaments.json", import.meta.url), "utf8")).tournaments;
const US_CHESS = new USChess(new URL("fixtures/uschess.json", import.meta.url).pathname);
const EMAILS = { 31847334: "td@example.org" };
const quiet = () => {};

function saturday(changes = {}) {
  const t = structuredClone(fixtures.find((x) => x.key === "first-saturday-classic/2026-11-07"));
  return { ...t, status: "running", td: "31847334", ...changes };
}

test("the same results make it rated, with US Chess's days", async () => {
  assert.deepEqual(await check(saturday(), "2026-11-08 10:17", US_CHESS, EMAILS, quiet),
    { rated: "202611070123", dates: { start: "2026-11-07", end: "2026-11-07" } });
});

test("an event US Chess has starting before the desk's date is found, and its days are US Chess's", async () => {
  const uschess = new USChess(new URL("fixtures/uschess.json", import.meta.url).pathname);
  const [event] = uschess.data.events;
  uschess.data.events = [{ ...event, startDate: "2026-10-31", endDate: "2026-11-07" }, ...uschess.data.events.slice(1)];
  assert.deepEqual(await check(saturday(), "2026-11-08 10:17", uschess, EMAILS, quiet),
    { rated: "202611070123", dates: { start: "2026-10-31", end: "2026-11-07" } });
  assert.deepEqual(await ratedDates("first-saturday-classic/2026-11-07", "202611070123", uschess), { start: "2026-10-31", end: "2026-11-07" });
  assert.equal(await ratedDates("first-saturday-classic/2026-11-07", "202611079999", uschess), null);
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

test("an extra games section is compared with US Chess's section that has its players, by its own rounds", async () => {
  const { ours, differences } = await import("../scripts/rating_check.mjs");
  const t = structuredClone(fixtures.find((x) => x.key === "second-saturday-sections/2026-12-12"));
  t.sections = [...t.sections.map((s) => ({ ...s, last: 2 })),
    { name: "Extra games", extra: true, first: 3, last: 3, players: ["90000061", "90000062", "90000064", "90000066"] }];
  t.rounds.push({ games: [{ board: 1, white: "90000064", black: "90000061", result: "0-1", section: "Extra games" },
    { board: 2, white: "90000062", black: "90000066", result: "1/2-1/2", section: "Extra games" }], byes: [], out: [], posted: true });
  const words = { W: "Win", L: "Loss", D: "Draw", B: "ByeFull", H: "ByeHalf", U: "Unpaired", X: "WinForfeit", F: "Forfeit" };
  const rated = (s) => Object.entries(s.players).map(([memberId, rounds]) => ({ memberId, roundOutcomes: Object.entries(rounds)
    .map(([n, [outcome, them, color]]) => ({ roundNumber: Number(n), outcome: words[outcome], opponentMemberId: them,
      color: { W: "White", B: "Black" }[color] })) }));
  // US Chess numbers the extra games first.
  const [open, under, extra] = ours(t).map(rated);
  assert.deepEqual(differences(t, { 1: extra, 2: open, 3: under }), []);
  extra.find((r) => r.memberId === "90000062").roundOutcomes[0].outcome = "Win";
  assert.deepEqual(differences(t, { 1: extra, 2: open, 3: under }), ["Jo Juniper, Extra games round 1: on the desk, "
    + "drew against Ned Nutmeg as White; on US Chess, won against Ned Nutmeg as White."]);
  assert.deepEqual(differences(t, { 1: open, 2: under }), ["Ivy Ironwood (90000061) in Extra games isn't in US Chess's event.",
    "Jo Juniper (90000062) in Extra games isn't in US Chess's event.", "Lu Larch (90000064) in Extra games isn't in US Chess's event.",
    "Ned Nutmeg (90000066) in Extra games isn't in US Chess's event."]);
});

test("an arena game where only one player took the Blood Pact has time odds, so it isn't expected in US Chess's event (5C1)", async () => {
  const { differences } = await import("../scripts/rating_check.mjs");
  const t = { key: "knightmare-arena-classical/2026-10-31", format: "arena", name: "Arena",
    players: [{ id: "11111111", name: "Ann A" }, { id: "22222222", name: "Bob B" }, { id: "33333333", name: "Cy C" }],
    games: [{ game: 1, white: "11111111", black: "22222222", whitePact: true, blackPact: false, result: "1-0" },
      { game: 2, white: "22222222", black: "33333333", whitePact: true, blackPact: true, result: "1/2-1/2" }] };
  const standings = { 1: [
    { memberId: "22222222", roundOutcomes: [{ roundNumber: 1, outcome: "Draw", opponentMemberId: "33333333", color: "White" }] },
    { memberId: "33333333", roundOutcomes: [{ roundNumber: 1, outcome: "Draw", opponentMemberId: "22222222", color: "Black" }] }] };
  assert.deepEqual(differences(t, standings), []);
});
