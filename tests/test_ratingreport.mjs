// Tests for ratingreport.js, the rating report files the TD desk offers once every round is in.
//   node --test tests/test_ratingreport.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const RatingReport = createRequire(import.meta.url)("../ratingreport.js");
const fixtures = JSON.parse(readFileSync(new URL("fixtures/tournaments.json", import.meta.url), "utf8")).tournaments;
const SECTIONS = fixtures.find((t) => t.key === "second-saturday-sections/2026-12-12");
const REPORT = { td: "31847334", affiliate: "A4003249", timeControl: "G/70;d10", city: "Fort Collins", state: "CO", zip: "80524",
  begin: "2026-12-12", end: "2026-12-12" };

function read(bytes) {
  const data = Buffer.from(bytes);
  const headerLength = data.readUInt16LE(8);
  const recordLength = data.readUInt16LE(10);
  const fields = [];
  for (let at = 32; data[at] !== 0x0d; at += 32) fields.push([data.subarray(at, at + 11).toString().replace(/\0+$/, ""), data[at + 16]]);
  return [...Array(data.readUInt32LE(4))].map((_, i) => {
    let at = headerLength + i * recordLength + 1;
    return Object.fromEntries(fields.map(([name, length]) => [name, data.subarray(at, (at += length)).toString().trim()]));
  });
}

test("each section is a section of the report, its players numbered within it", () => {
  const files = RatingReport.files(SECTIONS, REPORT);
  const [header] = read(files["THEXPORT.DBF"]);
  assert.deepEqual([header.H_FORMAT, header.H_NAME, header.H_TOT_SECT, header.H_BEG_DATE, header.H_CTD_ID, header.H_AFF_ID],
    ["2C", "Second Saturday Sections", "2", "20261212", "31847334", "A4003249"]);
  assert.deepEqual(read(files["TSEXPORT.DBF"]).map((s) => [s.S_SEC_NUM, s.S_SEC_NAME, s.S_R_SYSTEM, s.S_TIMECTL, s.S_LST_PAIR]),
    [["1", "Open", "R", "Game/70;d10", "4"], ["2", "Under 1400", "R", "Game/70;d10", "3"]]);
  assert.deepEqual(read(files["TDEXPORT.DBF"]).map((p) => [p.D_SEC_NUM, p.D_PAIR_NUM, p.D_NAME, p.D_RATING, p.D_RND01, p.D_RND02]), [
    ["1", "1", "IRONWOOD, IVY", "2000", "W3W", "D2B"], ["1", "2", "JUNIPER, JO", "1800", "W4B", "D1W"],
    ["1", "3", "KAPOK, KIT", "1600", "L1B", "L4W"], ["1", "4", "MAPLE, MAX", "1300", "L2W", "W3B"],
    ["2", "1", "LARCH, LU", "1350", "W3W", "W2B"], ["2", "2", "NUTMEG, NED", "1100", "B0", "L1W"],
    ["2", "3", "OLIVE, OZ", "0", "L1B", "B0"]]);
});

test("the files don't change by accident", () => {
  const files = RatingReport.files(SECTIONS, REPORT);
  const hash = (name) => createHash("sha256").update(files[name]).digest("hex").slice(0, 16);
  assert.deepEqual(["THEXPORT.DBF", "TSEXPORT.DBF", "TDEXPORT.DBF"].map(hash), ["35a4a4c50e0a32cd", "90984067af4c6d0e", "90e9692a09800a67"]);
});

test("a quad's sections are round robins, a Swiss's Swiss", () => {
  const quad = fixtures.find((t) => t.format === "quad");
  assert.deepEqual([...new Set(read(RatingReport.files(quad, REPORT)["TSEXPORT.DBF"]).map((s) => s.S_TRN_TYPE))], ["R"]);
  assert.deepEqual(read(RatingReport.files(SECTIONS, REPORT)["TSEXPORT.DBF"]).map((s) => s.S_TRN_TYPE), ["S", "S"]);
});

test("the rating system follows the time control", () => {
  assert.deepEqual(["G/70;d10", "G/30;+10", "G/20;d5", "G/90;+30", ""].map(RatingReport.ratingSystem), ["R", "D", "Q", "R", "R"]);
  // Rule 5C's examples, in its notation: every control's minutes count.
  assert.deepEqual(["G/60 d/5", "G/61 d/5", "G/25 d/5", "G/26 d/3", "30/30 SD/30 d/5", "40/90, SD/30; inc/30", "G/10 d/3"]
    .map(RatingReport.ratingSystem), ["D", "R", "D", "Q", "D", "R", "Q"]);
  assert.equal(RatingReport.lastFirst("José de la Cruz"), "CRUZ, JOSE DE LA");
});
