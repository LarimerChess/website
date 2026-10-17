// Records each club tournament in ratings.json once US Chess shows it rated with the TD desk's results,
// and reminds the TD and the President each morning until it does.
//
//   node scripts/rating_check.mjs [--email] [--now 2026-10-12T09:17] [--from FILE] [--uschess FILE]
//
// For each tournament in the registration script's ?tournaments=current that ratings.json doesn't list:
//   1. Play has ended when the planned rounds are all posted with their results (an arena: past its
//      cutoff with every game in), on the day the last round was posted, or anyway once the event's
//      last day (a month's, for a club night's Swiss) is over.
//   2. Once it has, the club affiliate's rated events in its dates come from US Chess's public v1 API,
//      and the one sharing the most players is compared with the tournament, player by player and
//      round by round. When nothing differs, ratings.json gets { key: US Chess event ID }. The
//      registration script reads it to refuse desk changes and show the tournament as rated; the
//      Results Action then writes its page, and the Archive tournaments Action takes it from there.
//   3. Otherwise, in the 9:00 AM run each day from 24 hours after the day play ended, it emails the
//      tournament's chief TD (the TD the desk started it with, by US Chess ID in LCCC_TD_EMAILS, or
//      locally ~/.config/lccc/td-emails.json) and the President with what US Chess is missing or
//      has differently. Without --email it says what it would send. Addresses never print, since
//      the Action's log is public.
//
// --from reads the tournaments from a saved copy of that JSON, --uschess reads US Chess from a file
// ({ events: [...], standings: { "<event id>/<section>": [...] } }), and --now sets the time in Colorado.
// The Results Action runs it hourly, before build_results.py.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const Pairing = require("../pairing.js");
const Arena = require("../arena.js");
const ROOT = new URL("..", import.meta.url).pathname;
const RATINGS = `${ROOT}ratings.json`;
const API = "https://ratings-api.uschess.org/api/v1";
const AFFILIATE = JSON.parse(readFileSync(`${ROOT}scripts/tds.json`, "utf8")).affiliate;
const PRESIDENT = "president@larimerchess.org";
const CONFIG = `${homedir()}/.config/lccc`;
const REMINDER_HOUR = 9;
const OUTCOMES = { Win: "W", Loss: "L", Draw: "D", WinForfeit: "X", Forfeit: "F", ByeFull: "B", ByeHalf: "H", Unpaired: "U",
  NotReported: "U" };
const SHOWN = { W: "won", L: "lost", D: "drew", X: "won by forfeit", F: "lost by forfeit", B: "full-point bye", H: "half-point bye",
  U: "no game" };
const DAY = 86400000;

// Times are in Colorado, as "YYYY-MM-DD HH:MM" strings, which compare in order.
const colorado = (date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Denver", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date).replace(",", "");
const nextDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) + DAY).toISOString().slice(0, 10);

/** The tournament's first and last day: its date, or a month's first and last. */
function daysOf(key) {
  const when = key.split("/")[1];
  if (when.length === 10) return [when, when];
  const [year, month] = when.split("-").map(Number);
  return [`${when}-01`, new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)];
}

export function playOver(t, now) {
  if (t.format === "arena") return Boolean(t.cutoff) && now >= `${daysOf(t.key)[0]} ${t.cutoff}` && (t.games || []).every((g) => g.result);
  return Boolean(t.plannedRounds) && t.rounds.length >= t.plannedRounds
    && t.rounds.every((r) => r.posted && r.games.every((g) => g.result));
}

/** The day play ended on, or null while it goes on. */
export function endedOn(t, now) {
  const last = daysOf(t.key)[1];
  if (playOver(t, now)) {
    const posted = t.rounds.map((r) => (r.postedAt || "").slice(0, 10)).filter(Boolean).sort().at(-1);
    return t.format === "arena" ? daysOf(t.key)[0] : posted || last;
  }
  return now >= `${nextDay(last)} 00:00` ? last : null;
}

/** { player: { round: [outcome, opponent, color] } } as the desk has it, for one section's rounds; an arena's games are
 *  numbered in order, leaving out those with time odds, which US Chess doesn't rate (5C1). Players with no game, bye, or
 *  result in any round are left out, as MUIR drops them. */
function played(t) {
  const players = Object.fromEntries(t.players.map((p) => [p.id, {}]));
  const games = t.format === "arena"
    ? [...(t.games || [])].filter((g) => !Arena.timeOdds(g) || Arena.FORFEIT(g.result)).sort((a, b) => a.game - b.game).map((g, i) => [i + 1, g])
    : t.rounds.flatMap((r, i) => (r.posted ? r.games.map((g) => [i + 1, g]) : []));
  if (t.format !== "arena") {
    t.rounds.forEach((r, i) => {
      if (!r.posted) return;
      for (const b of r.byes || []) {
        if (players[b.id]) players[b.id][i + 1] = [{ bye: "B", half: "H" }[Pairing.byeKind(b)] || "U", "", ""];
      }
    });
  }
  for (const [n, g] of games) {
    const points = Pairing.POINTS[g.result];
    for (const [me, them, color, side] of [[g.white, g.black, "W", 0], [g.black, g.white, "B", 1]]) {
      if (!players[me]) continue;
      players[me][n] = !points ? ["?", them, color]
        : /F/.test(g.result) ? [points[side] ? "X" : "F", "", ""]
          : [{ 1: "W", 0.5: "D", 0: "L" }[points[side]], them, color];
    }
  }
  return Object.fromEntries(Object.entries(players).filter(([, rounds]) => Object.values(rounds).some(([o]) => o !== "U")));
}

/** The desk's sections as US Chess rates them, [{ name, players }], players as played gives them: an extra rated
 *  games section (28M4) has its own rounds, from its round 1, and players who are also in another section. */
export function ours(t) {
  if (t.format === "arena") return [{ name: "", players: played(t) }];
  return Pairing.sections(t).filter((s) => s.players.length).map((s) => ({ name: s.name, players: played({ ...s, format: t.format }) }));
}

/** The same from US Chess's standings, { section number: { player: rounds } }. */
function theirs(standings) {
  const sections = {};
  for (const [section, rows] of Object.entries(standings)) {
    const players = (sections[section] = {});
    for (const row of rows) {
      const rounds = (players[row.memberId || ""] ||= {});
      for (const o of row.roundOutcomes || []) {
        const outcome = OUTCOMES[o.outcome] || o.outcome || "?";
        const played = ["W", "L", "D"].includes(outcome);
        rounds[o.roundNumber] = [outcome, played ? o.opponentMemberId || "" : "", played ? { White: "W", Black: "B" }[o.color] || "" : ""];
      }
    }
  }
  return sections;
}

function described([outcome, them, color], names) {
  if (!["W", "L", "D", "?"].includes(outcome)) return SHOWN[outcome] || outcome;
  const game = `against ${names[them] || them} as ${color === "W" ? "White" : "Black"}`;
  return outcome === "?" ? `a game ${game} with no result` : `${SHOWN[outcome]} ${game}`;
}

/** What US Chess's rated event has differently from the desk, as sentences; none when it matches. Each of US
 *  Chess's sections is compared with the desk's section sharing the most players with it. */
export function differences(t, standings) {
  const names = Object.fromEntries(t.players.map((p) => [p.id, p.name || p.id]));
  const mine = ours(t);
  const found = theirs(standings);
  const extra = (t.sections || []).some((s) => s.extra);
  const byName = (a, b) => (names[a] || a).localeCompare(names[b] || b);
  const key = (cell) => cell.join("|");
  const matched = new Map();
  for (const [number, players] of Object.entries(found)) {
    const ids = Object.keys(players);
    const best = mine.map((s, i) => [i, ids.filter((id) => s.players[id]).length]).filter(([i, n]) => n && !matched.has(i))
      .sort((a, b) => b[1] - a[1])[0];
    if (best) matched.set(best[0], number);
  }
  const out = [];
  const missing = [];
  const pairs = [];
  mine.forEach((s, i) => {
    const there = found[matched.get(i)] || {};
    for (const id of Object.keys(s.players)) (there[id] ? pairs.push([s, id, there[id]]) : missing.push([s, id]));
  });
  const inSection = (s) => (extra ? ` in ${s.name}` : "");
  for (const [s, id] of missing.sort(([, a], [, b]) => byName(a, b))) out.push(`${names[id]} (${id})${inSection(s)} isn't in US Chess's event.`);
  const ourIds = new Set(mine.flatMap((s) => Object.keys(s.players)));
  for (const id of [...new Set(Object.values(found).flatMap((p) => Object.keys(p)))].filter((id) => !ourIds.has(id)).sort()) {
    out.push(`US Chess has ${id}, who didn't play here.`);
  }
  for (const [s, id, theirRounds] of pairs.sort(([, a], [, b]) => byName(a, b))) {
    const ourRounds = s.players[id];
    if (t.format === "arena") {
      // An arena has no rounds, and MUIR numbers its games in some order of its own.
      const count = (rounds) => Object.values(rounds).reduce((m, c) => m.set(key(c), (m.get(key(c)) || 0) + 1), new Map());
      const [a, b] = [count(ourRounds), count(theirRounds)];
      for (const [cell, n] of a) for (let i = b.get(cell) || 0; i < n; i++) out.push(`${names[id]}: on the desk but not US Chess, ${described(cell.split("|"), names)}.`);
      for (const [cell, n] of b) for (let i = a.get(cell) || 0; i < n; i++) out.push(`${names[id]}: on US Chess but not the desk, ${described(cell.split("|"), names)}.`);
      continue;
    }
    const rounds = [...new Set([...Object.keys(ourRounds), ...Object.keys(theirRounds)].map(Number))].sort((x, y) => x - y);
    for (const n of rounds) {
      const here = ourRounds[n] || ["U", "", ""];
      const there = theirRounds[n] || ["U", "", ""];
      if (key(here) !== key(there)) {
        out.push(`${names[id]}, ${extra ? `${s.name} ` : ""}round ${n}: on the desk, ${described(here, names)}; on US Chess, ${described(there, names)}.`);
      }
    }
  }
  if (t.format !== "arena") {
    for (const [number, players] of Object.entries(found)) {
      const members = Object.keys(players).filter((id) => ourIds.has(id));
      if (members.length && !mine.some((s) => members.every((id) => s.players[id]))) {
        out.push(`US Chess's section ${number} mixes players from different sections here: ${members.map((id) => names[id]).sort().join(", ")}.`);
      }
    }
  }
  return out;
}

// US Chess

async function paged(path, query = {}) {
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const response = await fetch(`${API}${path}?${new URLSearchParams({ ...query, Offset: offset, Size: 100 })}`,
      { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`US Chess answered ${response.status} to ${path}`);
    const page = await response.json();
    items.push(...(page.items || []));
    if (!page.hasNextPage) return items;
  }
}

export class USChess {
  constructor(fixture) {
    this.data = fixture ? JSON.parse(readFileSync(fixture, "utf8")) : null;
  }

  async events(first, last) {
    if (this.data) return this.data.events.filter((e) => first <= e.startDate && e.startDate <= last);
    return paged(`/affiliates/${AFFILIATE}/events`, { FromDate: first, ToDate: last });
  }

  async standings(event) {
    const numbers = [...Array(event.sectionCount || 1)].map((_, i) => i + 1);
    const lists = await Promise.all(numbers.map((n) => (this.data ? this.data.standings[`${event.id}/${n}`] || []
      : paged(`/rated-events/${event.id}/sections/${n}/standings`))));
    return Object.fromEntries(numbers.map((n, i) => [n, lists[i]]));
  }
}

/** { event, found } for the rated event most like the tournament, found being its differences; or null. */
export async function ratedEvent(t, uschess) {
  const [first, last] = daysOf(t.key);
  const mine = new Set(ours(t).flatMap((s) => Object.keys(s.players)));
  let best = null;
  for (const event of await uschess.events(first, last)) {
    const standings = await uschess.standings(event);
    const players = new Set(Object.values(theirs(standings)).flatMap((p) => Object.keys(p)));
    const shared = [...mine].filter((id) => players.has(id)).length;
    if (shared && (!best || shared > best.shared)) best = { shared, event, standings };
  }
  return best && { event: best.event, found: differences(t, best.standings) };
}

// The reminder

function setting(env, file) {
  if (process.env[env] !== undefined) return process.env[env].trim();
  return existsSync(`${CONFIG}/${file}`) ? readFileSync(`${CONFIG}/${file}`, "utf8").trim() : "";
}

export function reminder(t, ended, match, tdFound, over) {
  const [year, month, day] = ended.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  const lines = [`Play in the ${t.name} ended ${date}.`];
  if (!over) lines.push("The TD desk doesn't have every round and result.");
  if (!match) {
    lines.push("US Chess doesn't show it rated yet.");
  } else {
    lines.push(`US Chess's event ${match.event.id}, https://ratings.uschess.org/event/${match.event.id}, differs from the TD desk:`);
    lines.push(...match.found.slice(0, 40).map((d) => `- ${d}`), ...(match.found.length > 40 ? [`- and ${match.found.length - 40} more`] : []));
  }
  const muir = "MUIR, https://ratings.uschess.org/portal/events";
  const files = t.format === "arena" ? `enter its games in ${muir}`
    : "download the rating report files from the TD desk, https://larimerchess.org/td/ (choose the event; Rating report is "
      + `under Run the tournament), and upload them in ${muir}, or enter the results there by hand`;
  lines.push("", `To report it, ${files}. Review the event in MUIR before submitting.`,
    "If the desk is wrong, correct it there; if US Chess is wrong, correct the event in MUIR.", "",
    "This reminder comes each morning until US Chess shows the event rated with the desk's results.");
  if (!tdFound) lines.push("The tournament has no chief TD with an email on file, so this went to the President only.");
  return { subject: `Rating report due: ${t.name}`, body: `${lines.join("\n")}\n` };
}

async function sendEmail(to, subject, body) {
  const raw = setting("LCCC_GMAIL_TOKEN", "google-token-gmail-send.json");
  if (!raw) throw new Error("No Gmail token: set the secret LCCC_GOOGLE_GMAIL_SEND_TOKEN");
  const token = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  const refreshed = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
    client_id: token.client_id, client_secret: token.client_secret, refresh_token: token.refresh_token, grant_type: "refresh_token" }) });
  if (!refreshed.ok) throw new Error(`Google answered ${refreshed.status} to the token refresh`);
  const { access_token: access } = await refreshed.json();
  const message = [`From: ${PRESIDENT}`, `To: ${to.join(", ")}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from(body).toString("base64")].join("\r\n");
  const sent = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(message).toString("base64url") }) });
  if (!sent.ok) throw new Error(`Gmail answered ${sent.status}`);
}

/** What to do about one tournament: { rated: event ID } once US Chess matches, or { remind: { to, subject, body } }, or {}. */
export async function check(t, now, uschess, tdEmails, log = console.log) {
  const ended = endedOn(t, now);
  if (!ended) {
    log(`${t.key}: still playing`);
    return {};
  }
  const match = await ratedEvent(t, uschess);
  if (match && !match.found.length) {
    log(`${t.key}: rated by US Chess as event ${match.event.id}, with the same results`);
    return { rated: match.event.id };
  }
  log(`${t.key}: ${match ? `US Chess's event ${match.event.id} differs in ${match.found.length} place(s)` : "not rated by US Chess yet"}`);
  const due = now >= `${nextDay(nextDay(ended))} 00:00` && Number(now.slice(11, 13)) === REMINDER_HOUR;
  if (!due) return {};
  const td = tdEmails[t.td] || "";
  return { remind: { to: [...new Set([td, PRESIDENT].filter(Boolean))], ...reminder(t, ended, match, Boolean(td), playOver(t, now)) } };
}

async function main(args) {
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const now = value("--now") ? value("--now").replace("T", " ").slice(0, 16) : colorado(new Date());
  let tournaments;
  if (value("--from")) {
    tournaments = JSON.parse(readFileSync(value("--from"), "utf8")).tournaments;
  } else {
    const endpoint = /^const ENDPOINT = "(.*)";$/m.exec(readFileSync(`${ROOT}register.js`, "utf8"))?.[1];
    if (!endpoint) return console.log("No ENDPOINT in register.js; nothing to check.");
    tournaments = (await (await fetch(`${endpoint}?tournaments=current`)).json()).tournaments;
  }
  const ratings = JSON.parse(readFileSync(RATINGS, "utf8"));
  const tdEmails = JSON.parse(setting("LCCC_TD_EMAILS", "td-emails.json") || "{}");
  const uschess = new USChess(value("--uschess"));
  const open = tournaments.filter((t) => !ratings[t.key] && t.status !== "rated");
  console.log(`${open.length} tournament(s) not yet rated, at ${now} in Colorado`);
  let failed = false;
  for (const t of open) {
    const done = await check(t, now, uschess, tdEmails);
    if (done.rated) ratings[t.key] = done.rated;
    if (!done.remind) continue;
    const who = done.remind.to.includes(PRESIDENT) && done.remind.to.length > 1 ? "the chief TD and the President" : "the President";
    if (!args.includes("--email")) {
      console.log(`  would email ${who}: ${done.remind.subject}\n${done.remind.body.replace(/^/gm, "    ")}`);
      continue;
    }
    try {
      await sendEmail(done.remind.to, done.remind.subject, done.remind.body);
      console.log(`  emailed ${who}`);
    } catch (error) {
      failed = true;
      console.log(`::error::${t.key}: the reminder wasn't sent: ${error.message}`);
    }
  }
  const sorted = Object.fromEntries(Object.entries(ratings).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(RATINGS, `${JSON.stringify(sorted, null, 2)}\n`);
  if (failed) process.exit(1);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main(process.argv.slice(2));
