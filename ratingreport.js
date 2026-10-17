// The US Chess rating report files for a Swiss or quad tournament: THEXPORT.DBF (the event),
// TSEXPORT.DBF (its sections), and TDEXPORT.DBF (each section's players and their rounds), in
// the draft 2C layout of US Chess's Rating Report Upload File Format page, with every field
// left-justified, space-filled text as its September 2025 note asks. The TD desk offers them
// once every round is in, for the TD to upload in MUIR; tests/test_ratingreport.mjs checks them.
//
// files(t, report) takes a tournament in the registration script's shape and
//   report: { td, affiliate, timeControl, timeControls, city, state, zip, begin, end }  begin and end YYYY-MM-DD,
//   timeControls a section's own time control by its key, where it differs
// and returns { "THEXPORT.DBF": Uint8Array, ... }. Each section of a Swiss, and each quad, is a
// section of the report, its players numbered within it as Pairing.sections numbers them; an extra
// rated games section (28M4) too, whose players are also in another section.

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

  /**
   * A time control as rule 5C counts it: { minutes, seconds, total, text }, or null when it has no base
   * time to read. minutes are every control's (40/90 SD/30 is 90 and 30) and seconds the increment or
   * delay. It reads US Chess's notation (G/30;+30, G/70;d10, SD/30;d5, G/5 d/0, inc/30), G15;+30, a base
   * and increment (30+30), and words (30 minutes + 30 seconds per move). text is a single control as
   * MUIR writes it, G/30;+30, with ;d0 when it has neither; several controls stay as written.
   */
  function parseControl(control) {
    const written = String(control || "").trim();
    const text = written.replace(/\b(?:minutes?|mins?)\b/gi, "").replace(/\b(?:seconds?|secs?)\b/gi, "");
    let minutes = [...text.matchAll(/(?:\b(?:G|SD|Game)\s*\/?\s*|\b\d+\s*\/\s*)(\d+)/gi)].map((m) => Number(m[1]));
    let added = /(\+|\binc(?:rement)?|\bd(?:elay)?)\s*\/?\s*(\d+)/i.exec(text);
    const bare = /^(\d+)\s*\+\s*(\d+)/.exec(text);
    if (!minutes.length && bare) {
      minutes = [Number(bare[1])];
      added = ["", "+", bare[2]];
    }
    if (!minutes.length) return null;
    const seconds = Number(added?.[2] || 0);
    const kind = added && /^d/i.test(added[1]) ? "d" : added ? "+" : "d";
    return { minutes, seconds, total: minutes.reduce((a, b) => a + b, 0) + seconds,
      text: minutes.length === 1 ? `G/${minutes[0]};${kind}${seconds}` : written };
  }

  /** Rule 5C's rating system for a time control: R (regular, a total over 65), D (dual, 30 to 65), Q (quick,
   *  over 10 and under 30), B (blitz, 5 to 10), or "" when it isn't ratable or can't be read. The first
   *  control has at least 5 minutes, or 3 for blitz. */
  function ratingSystem(control) {
    const c = parseControl(control);
    if (!c) return "";
    const primary = c.minutes[0];
    if (c.total > 10) return primary < 5 ? "" : c.total > 65 ? "R" : c.total >= 30 ? "D" : "Q";
    return c.total >= 5 && primary >= 3 ? "B" : "";
  }

  /** Why a time control can't go in the upload files, in words for the TD, or "". */
  function controlProblem(control, where = "") {
    const named = where ? `${where}: ` : "";
    if (!String(control || "").trim()) return `${named}enter the time control, such as G/30;+30.`;
    const system = ratingSystem(control);
    if (!parseControl(control)) return `${named}the desk can't read "${control}"; write it like G/30;+30 or 40/90 SD/30;d5.`;
    if (!system) return `${named}${control} can't be rated under rule 5C: blitz is 5 to 10 minutes in all, with at least 3 to start, and the other systems need at least 5 to start.`;
    // The upload format's rating systems are R, D, and Q (S_R_SYSTEM).
    if (system === "B") return `${named}${control} is blitz, which the upload files can't carry; enter it in MUIR by hand and mark it blitz.`;
    return "";
  }

  /** Each player's D_RNDnn: the result letter, the opponent's number (0 without a game), and the color.
   *  W, L, D; X and F for a win or loss by forfeit; B and H for a full- or half-point bye; U not played. */
  function roundCells(section, count) {
    const numbers = new Map(section.players.map((p) => [p.id, p.number]));
    // A section with fewer rounds than the report's longest leaves the fields after its own empty,
    // since a section has as many results as its S_TOT_RNDS.
    const cells = new Map(section.players.map((p) => [p.id, Array(count).fill("").fill("U0", 0, section.rounds.length)]));
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
    // An extra rated games section (28M4) reports only its own rounds, from its round 1.
    const count = Math.max(...sections.map((s) => s.rounds.length));
    const sectionRecords = [];
    const players = [];
    sections.forEach((s, i) => {
      const number = String(i + 1);
      // Rule 5C, TD tip, note 2: each section's time control, when they differ.
      const control = (report.timeControls || {})[s.key] || report.timeControl;
      const written = parseControl(control)?.text || control || "";
      sectionRecords.push({ S_SEC_NUM: number, S_SEC_NAME: s.name, S_R_SYSTEM: ratingSystem(control),
        S_TIMECTL: written.replace(/^G\//, "Game/"), S_CTD_ID: report.td,
        // R for Round Robin: each quad plays rule 30G's table, the order US Chess reads its rounds in.
        S_TRN_TYPE: s.format === "quad" ? "R" : "S",
        S_TOT_RNDS: String(s.rounds.length), S_LST_PAIR: String(s.players.length), S_BEG_DATE: ymd(report.begin),
        // S_SCH_LVL is MUIR's participant code: N Non-Scholastic, S Scholastic, J JTP K-12, P JTP Primary.
        // Club events are open to all ages and not tied to a school (docs/tds/rating-an-event.md).
        S_END_DATE: ymd(report.end), S_SCH_LVL: "N", S_GR_PRIX: "N", S_GP_PTS: "0" });
      const cells = roundCells(s, count);
      for (const p of s.players) {
        // MUIR warns about a player whose state differs from the rest; an unknown one is the event's.
        const row = { D_SEC_NUM: number, D_PAIR_NUM: String(p.number), D_MEM_ID: p.id, D_NAME: lastFirst(p.name),
          D_STATE: p.state || report.state || "", D_RATING: p.rating ? String(p.rating) : "0" };
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

  const RatingReport = { files, parseControl, ratingSystem, controlProblem, lastFirst };
  if (typeof module !== "undefined" && module.exports) module.exports = RatingReport;
  else root.RatingReport = RatingReport;
})(typeof window !== "undefined" ? window : globalThis);
