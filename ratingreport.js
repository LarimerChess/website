// The US Chess rating report files for a Swiss or quad tournament: THEXPORT.DBF (the event),
// TSEXPORT.DBF (its sections), and TDEXPORT.DBF (each section's players and their rounds), in
// the draft 2C layout of US Chess's Rating Report Upload File Format page, with every field
// left-justified, space-filled text as its September 2025 note asks. The TD desk offers them
// once every round is in, for the TD to upload in MUIR; tests/test_ratingreport.mjs checks them.
//
// files(t, report) takes a tournament in the registration script's shape and
//   report: { td, affiliate, timeControl, city, state, zip, begin, end }  begin and end YYYY-MM-DD
// and returns { "THEXPORT.DBF": Uint8Array, ... }. Each section of a Swiss, and each quad, is a
// section of the report, its players numbered within it as Pairing.sections numbers them.

(function (root) {
  "use strict";

  const Pairing = root.Pairing || require("./pairing.js");

  const THEXPORT = [["H_FORMAT", 5], ["H_PROGRAM", 10], ["H_EVENT_ID", 12], ["H_NAME", 35], ["H_TOT_SECT", 2],
    ["H_BEG_DATE", 8, "D"], ["H_END_DATE", 8, "D"], ["H_AFF_ID", 8], ["H_CITY", 21], ["H_STATE", 2], ["H_ZIPCODE", 10],
    ["H_COUNTRY", 21], ["H_SENDCROS", 1], ["H_CTD_ID", 8], ["H_ATD_ID", 8], ["H_OTHER_TD", 255]];
  const TSEXPORT = [["S_EVENT_ID", 12], ["S_SEC_NUM", 2], ["S_SEC_NAME", 30], ["S_R_SYSTEM", 1], ["S_TIMECTL", 40],
    ["S_CTD_ID", 8], ["S_ATD_ID", 8], ["S_TRN_TYPE", 1], ["S_TOT_RNDS", 2], ["S_LST_PAIR", 4], ["S_BEG_DATE", 8, "D"],
    ["S_END_DATE", 8, "D"], ["S_SCH_LVL", 1], ["S_GR_PRIX", 1], ["S_GP_PTS", 3]];
  const TDEXPORT = [["D_EVENT_ID", 12], ["D_SEC_NUM", 2], ["D_PAIR_NUM", 4], ["D_MEM_ID", 8], ["D_NAME", 30],
    ["D_STATE", 2], ["D_RATING", 4]];

  const ascii = (value) => String(value ?? "").normalize("NFKD").replace(/[^\x20-\x7e]/g, "");

  /** A dBase III table; the header's last-updated date is the event's end, so the same tournament gives the same bytes. */
  function dbf(fields, records, end) {
    const headerLength = 32 + 32 * fields.length + 1;
    const recordLength = 1 + fields.reduce((n, [, length]) => n + length, 0);
    const out = new Uint8Array(headerLength + records.length * recordLength + 1);
    const view = new DataView(out.buffer);
    const [year, month, day] = end.split("-").map(Number);
    out.set([0x03, year - 1900, month, day]);
    view.setUint32(4, records.length, true);
    view.setUint16(8, headerLength, true);
    view.setUint16(10, recordLength, true);
    fields.forEach(([name, length, kind], i) => {
      const at = 32 + 32 * i;
      for (let c = 0; c < name.length; c++) out[at + c] = name.charCodeAt(c);
      out[at + 11] = (kind || "C").charCodeAt(0);
      out[at + 16] = length;
    });
    out[headerLength - 1] = 0x0d;
    let at = headerLength;
    for (const record of records) {
      out[at++] = 0x20;
      for (const [name, length] of fields) {
        const text = ascii(record[name]).slice(0, length).padEnd(length);
        for (let c = 0; c < length; c++) out[at++] = text.charCodeAt(c);
      }
    }
    out[at] = 0x1a;
    return out;
  }

  /** 'Ada Alder' as 'ALDER, ADA', the order US Chess lists names in. */
  function lastFirst(name) {
    const parts = ascii(name).trim().split(/\s+/);
    return (parts.length > 1 ? `${parts.at(-1)}, ${parts.slice(0, -1).join(" ")}` : parts[0] || "").toUpperCase();
  }

  /** US Chess adds base minutes to increment or delay seconds: above 65 regular, 30 to 65 dual, below quick. */
  function ratingSystem(control) {
    const m = /G\/(\d+)(?:;[+d](\d+))?/.exec(control || "");
    if (!m) return "R";
    const total = Number(m[1]) + Number(m[2] || 0);
    return total > 65 ? "R" : total >= 30 ? "D" : "Q";
  }

  /** Each player's D_RNDnn: the result letter, the opponent's number (0 without a game), and the color.
   *  W, L, D; X and F for a win or loss by forfeit; B and H for a full- or half-point bye; U not played. */
  function roundCells(section, count) {
    const numbers = new Map(section.players.map((p) => [p.id, p.number]));
    const cells = new Map(section.players.map((p) => [p.id, Array(count).fill("U0")]));
    section.rounds.forEach((r, i) => {
      if (i >= count) return;
      for (const g of r.games) {
        const points = Pairing.POINTS[g.result];
        if (!points) continue;
        [[g.white, g.black, "W", 0], [g.black, g.white, "B", 1]].forEach(([me, them, color, side]) => {
          cells.get(me)[i] = /F/.test(g.result) ? `${points[side] ? "X" : "F"}0`
            : `${{ 1: "W", 0.5: "D", 0: "L" }[points[side]]}${numbers.get(them)}${color}`;
        });
      }
      for (const b of r.byes || []) cells.get(b.id)[i] = `${{ bye: "B", half: "H" }[Pairing.byeKind(b)] || "U"}0`;
    });
    return cells;
  }

  function files(t, report) {
    const ymd = (d) => d.replaceAll("-", "");
    const name = t.name.split(",")[0];
    let sections = Pairing.sections(t).filter((s) => s.players.length);
    if (sections.length === 1 && t.format !== "quad") sections = [{ ...sections[0], name }];
    const count = t.rounds.length;
    const sectionRecords = [];
    const players = [];
    sections.forEach((s, i) => {
      const number = String(i + 1);
      sectionRecords.push({ S_SEC_NUM: number, S_SEC_NAME: s.name, S_R_SYSTEM: ratingSystem(report.timeControl),
        S_TIMECTL: (report.timeControl || "").replace("G/", "Game/"), S_CTD_ID: report.td, S_TRN_TYPE: "S",
        S_TOT_RNDS: String(count), S_LST_PAIR: String(s.players.length), S_BEG_DATE: ymd(report.begin),
        // S_SCH_LVL is MUIR's participant code: N Non-Scholastic, S Scholastic, J JTP K-12, P JTP Primary.
        // Club events are open to all ages and not tied to a school (docs/tds/rating-an-event.md).
        S_END_DATE: ymd(report.end), S_SCH_LVL: "N", S_GR_PRIX: "N", S_GP_PTS: "0" });
      const cells = roundCells(s, count);
      for (const p of s.players) {
        const row = { D_SEC_NUM: number, D_PAIR_NUM: String(p.number), D_MEM_ID: p.id, D_NAME: lastFirst(p.name),
          D_RATING: p.rating ? String(p.rating) : "0" };
        cells.get(p.id).forEach((c, n) => { row[`D_RND${String(n + 1).padStart(2, "0")}`] = c; });
        players.push(row);
      }
    });
    const header = { H_FORMAT: "2C", H_PROGRAM: "LCCC", H_NAME: name, H_TOT_SECT: String(sections.length),
      H_BEG_DATE: ymd(report.begin), H_END_DATE: ymd(report.end), H_AFF_ID: report.affiliate, H_CITY: report.city,
      H_STATE: report.state, H_ZIPCODE: report.zip, H_COUNTRY: "USA", H_SENDCROS: "N", H_CTD_ID: report.td };
    const rounds = [...Array(count)].map((_, n) => [`D_RND${String(n + 1).padStart(2, "0")}`, 7]);
    return {
      "THEXPORT.DBF": dbf(THEXPORT, [header], report.end),
      "TSEXPORT.DBF": dbf(TSEXPORT, sectionRecords, report.end),
      "TDEXPORT.DBF": dbf([...TDEXPORT, ...rounds], players, report.end),
    };
  }

  const RatingReport = { files, ratingSystem, lastFirst };
  if (typeof module !== "undefined" && module.exports) module.exports = RatingReport;
  else root.RatingReport = RatingReport;
})(typeof window !== "undefined" ? window : globalThis);
