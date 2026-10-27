// The rating report files, restarts, extra games sections, time controls, byes by the rules, and the Results page.
import { PHONE, Pairing, axeBoth, axeSource, base, browser, deskState, dismissRefusal, done, fail, fitsPhone, fourPlayers, mocked, pass, press, signIn, sixPlayers, twoSections } from "./common.mjs";

// With every round in, the desk has no Finish button: it offers the rating report files for MUIR and keeps
// them in a folder the TD picks (a stand-in here for the browser's folder picker), rewritten when a result
// changes and deleted when one is missing, when rounds are added, or on a restart. A rated tournament
// offers nothing to change.
const played = (pairs) => ({ games: pairs.map(([white, black, result], i) => ({ board: i + 1, white, black, result, section: "" })),
  byes: [], out: [], posted: true, postedAt: "2026-11-07 15:05" });
const doneDesk = deskState([played([["11111111", "33333333", "1-0"], ["44444444", "22222222", "0-1"]]),
  played([["22222222", "11111111", "1/2-1/2"], ["33333333", "44444444", "1-0"]]),
  played([["11111111", "44444444", "1-0"], ["22222222", "33333333", "0-1"]])]);
const keptRounds = JSON.parse(JSON.stringify(doneDesk.held.rounds));
const deskAnswer = doneDesk.answer;
doneDesk.answer = (p) => {
  if (p.action === "rounds") {
    doneDesk.held.plannedRounds = Number(p.rounds);
    return { ok: true, message: `It plays ${p.rounds} rounds.` };
  }
  if (p.action === "restart") {
    doneDesk.held = null;
    return { ok: true, message: "Deleted. Start it again when ready." };
  }
  return deskAnswer(p);
};
const donePage = await mocked("/td/ after the last round", (p) => doneDesk.answer(p));
await donePage.evaluateOnNewDocument(() => {
  window.keptFiles = {};
  const folder = { name: "Rating report", queryPermission: async () => "granted", requestPermission: async () => "granted",
    getFileHandle: async (name) => ({ createWritable: async () => {
      let bytes = null;
      return { write: async (b) => { bytes = Array.from(b); }, close: async () => { window.keptFiles[name] = bytes; } };
    } }),
    removeEntry: async (name) => {
      if (!(name in window.keptFiles)) throw new DOMException("No such file", "NotFoundError");
      delete window.keptFiles[name];
    } };
  window.showDirectoryPicker = async () => folder;
});
// What the TD types when Restart asks for the tournament's name.
let typedName = "";
donePage.on("dialog", (dialog) => dialog.accept(dialog.type() === "prompt" ? typedName : undefined));
await signIn(donePage);
await donePage.waitForFunction(() => document.querySelectorAll(".run-report-download").length === 3);
const kept = () => donePage.evaluate(() => Object.keys(window.keptFiles).sort().join(","));
const keptPlayers = () => donePage.evaluate(() => JSON.stringify(window.keptFiles["TDEXPORT.DBF"]));
const reload = async () => {
  await press(donePage, ".run-report-download");
  await new Promise((r) => setTimeout(r, 500));
};
const afterPlay = await donePage.evaluate(() => ({ status: document.querySelector(".run-status").textContent,
  td: document.getElementById("run-report-td").selectedOptions[0]?.textContent,
  finish: Boolean(document.querySelector(".run-finish, .run-arena-finish")), round: document.querySelector(".run-round").hidden }));
await press(donePage, ".run-report-folder");
await donePage.waitForFunction(() => Object.keys(window.keptFiles).length === 3);
const first = await keptPlayers();
const records = await donePage.evaluate(() => new DataView(new Uint8Array(window.keptFiles["TDEXPORT.DBF"]).buffer).getUint32(4, true));
const told = await donePage.$eval(".run-report-folder-status", (p) => p.textContent);
await axeBoth(donePage, "TD desk with the rating report");
doneDesk.held.rounds[2].games[0].result = "0-1";
await reload();
const rewritten = (await kept()) === "TDEXPORT.DBF,THEXPORT.DBF,TSEXPORT.DBF" && (await keptPlayers()) !== first;
doneDesk.held.rounds[2].games[1].result = "";
await reload();
const goneWhenMissing = (await kept()) === "" && await donePage.$eval(".run-report", (d) => d.hidden);
doneDesk.held.rounds = JSON.parse(JSON.stringify(keptRounds));
typedName = "Slow";
await press(donePage, ".run-restart");
const wrongName = { popup: await dismissRefusal(donePage), status: await donePage.$eval(".run-status", (p) => p.textContent), held: Boolean(doneDesk.held) };
wrongName.held && wrongName.status === "That isn't Classic, so nothing was restarted." && wrongName.popup === wrongName.status
  ? pass("TD desk won't restart a tournament unless its name is typed") : fail(`TD desk restart with the wrong name: ${JSON.stringify(wrongName)}`);
typedName = " classic ";
await press(donePage, ".run-restart");
await donePage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Deleted"));
await donePage.waitForFunction(() => Object.keys(window.keptFiles).length === 0);
// Restarted and played again, then a round added: the files go until the new round is in.
doneDesk.held = { key: "classic/2026-11-07", name: "Classic", format: "swiss", plannedRounds: 3, status: "running", coin: "white",
  players: fourPlayers(), rounds: JSON.parse(JSON.stringify(keptRounds)), timeControl: "G/70;d10" };
await donePage.evaluate(() => document.dispatchEvent(new Event("td-choice")));
await donePage.waitForFunction(() => Object.keys(window.keptFiles).length === 3);
await donePage.$eval("#run-planned-rounds", (input) => { input.value = "4"; });
await press(donePage, ".run-planned button");
await donePage.waitForFunction(() => Object.keys(window.keptFiles).length === 0 && document.querySelector(".run-report").hidden);
const roundAdded = doneDesk.held.plannedRounds === 4;
await donePage.close();
doneDesk.held.plannedRounds = 3;
doneDesk.held.status = "rated";
const ratedPage = await mocked("/td/ once rated", (p) => doneDesk.answer(p));
await signIn(ratedPage);
await ratedPage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Rated by US Chess"));
const afterRating = await ratedPage.evaluate(() => ({ round: document.querySelector(".run-round").hidden,
  standings: !document.querySelector(".run-standings-wrap").hidden, manage: document.querySelector(".run-manage").hidden }));
afterPlay.status.includes("The rating report is below") && afterPlay.td === "Jared Hall (31847334)" && !afterPlay.finish && afterPlay.round
  && records === 4 && told.includes("up to date in the folder Rating report") && rewritten && goneWhenMissing && roundAdded
  && afterRating.round && afterRating.standings && afterRating.manage
  ? pass("TD desk has no Finish: after the last round it keeps the rating report files in a folder, rewritten when a result changes "
    + "and deleted when one is missing, rounds are added, or it restarts; a rated tournament can't change")
  : fail(`TD desk after the last round: ${JSON.stringify({ afterPlay, records, told, rewritten, goneWhenMissing, roundAdded, afterRating })}`);
await ratedPage.close();

// An extra games section (28M4) once the Open is over: the TD adds it with everyone, and round 4 checks in, pairs,
// and posts only it; it has its own standings and its own section in the rating report, with the players again.
const inOpen = (pairs) => ({ ...played(pairs), games: played(pairs).games.map((g) => ({ ...g, section: "Open" })) });
const extraDesk = deskState([inOpen([["11111111", "33333333", "1-0"], ["44444444", "22222222", "0-1"]]),
  inOpen([["22222222", "11111111", "1/2-1/2"], ["33333333", "44444444", "1-0"]]),
  inOpen([["11111111", "44444444", "1-0"], ["22222222", "33333333", "0-1"]])]);
extraDesk.held.sections = [{ name: "Open" }];
extraDesk.held.players.forEach((p) => { p.section = "Open"; });
const extraAnswer = extraDesk.answer;
extraDesk.answer = (p) => {
  const held = extraDesk.held;
  if (p.action === "extraSection") {
    const first = held.rounds.length + 1;
    held.sections = [...held.sections.map((s) => ({ ...s, last: s.last || held.plannedRounds })),
      { name: p.name, extra: true, first, last: first + Number(p.rounds) - 1, players: JSON.parse(p.players) }];
    held.plannedRounds = first + Number(p.rounds) - 1;
    return { ok: true, message: `${p.name}: added.` };
  }
  if (p.action === "result") {
    held.rounds[Number(p.number) - 1].games.find((g) => g.board === Number(p.board) && g.section === p.section).result = p.result;
    return { ok: true };
  }
  return extraAnswer(p);
};
const extraPage = await mocked("/td/ adding an extra games section", (p) => extraDesk.answer(p));
await signIn(extraPage);
await extraPage.waitForFunction(() => !document.querySelector(".run-report").hidden);
await extraPage.$eval(".run-extra-wrap summary", (s) => s.click());
const extraForm = await extraPage.evaluate(() => ({ name: document.getElementById("run-extra-name").value,
  rounds: document.getElementById("run-extra-rounds").value,
  players: [...document.querySelectorAll(".run-extra-players input")].map((b) => b.checked) }));
await press(extraPage, ".run-extra button[type=submit]");
await extraPage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 4: check in");
const extraCheckin = await extraPage.evaluate(() => ({ headings: [...document.querySelectorAll(".run-attendance-all h4")].map((h) => h.textContent),
  rows: document.querySelectorAll(".run-attendance tbody tr").length, report: document.querySelector(".run-report").hidden,
  list: document.querySelector(".run-extra-list").textContent, planned: [...document.querySelectorAll("#run-planned-section option")].map((o) => o.value),
  rounds: document.getElementById("run-planned-rounds").value }));
await press(extraPage, ".run-pair");
await extraPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("pairings to review"));
await press(extraPage, ".run-post");
await extraPage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 4: results");
const extraPosted = extraDesk.held.rounds[3].games.map((g) => g.section);
for (const label of ["Extra games board 1 result", "Extra games board 2 result"]) {
  await extraPage.select(`select[aria-label="${label}"]`, "1-0");
  await new Promise((r) => setTimeout(r, 200));
}
await extraPage.waitForFunction(() => !document.querySelector(".run-report").hidden);
const extraDone = await extraPage.evaluate(async () => {
  const files = await reportFiles(current);
  const records = (name) => new DataView(files[name].buffer).getUint32(4, true);
  return { standings: [...document.querySelectorAll(".run-standings-all h4")].map((h) => h.textContent),
    openScores: [...document.querySelectorAll(".run-standings")[0].querySelectorAll("tbody tr")].map((r) => r.cells[3].textContent),
    sections: records("TSEXPORT.DBF"), players: records("TDEXPORT.DBF") };
});
// Each section's time control: blitz can't go in the files, so they wait; a dual one goes in its own section.
const sectionControl = async (value) => {
  await extraPage.$eval('input[data-section="Extra games"]', (input, v) => {
    input.value = v;
    input.dispatchEvent(new Event("change"));
  }, value);
  await new Promise((r) => setTimeout(r, 300));
};
await sectionControl("G/5;+3");
const blitzShown = await extraPage.evaluate(async () => ({ problems: document.querySelector(".run-report-problems").textContent,
  fields: [...document.querySelectorAll(".run-report-sections label")].map((l) => l.textContent) }));
await sectionControl("30+30");
const dualShown = await extraPage.evaluate(async () => {
  const files = await reportFiles(current);
  const text = new TextDecoder().decode(files["TSEXPORT.DBF"]);
  return { problems: document.querySelector(".run-report-problems").textContent, dual: text.includes("Game/30;+30"), main: text.includes("Game/70;d10") };
});
await sectionControl("thirty plus thirty");
const unreadable = await extraPage.evaluate(() => ({ error: document.getElementById("run-report-control-error").textContent,
  invalid: document.querySelector('input[data-section="Extra games"]').getAttribute("aria-invalid") }));
await sectionControl("");
const controlCalls = extraDesk.calls.filter((c) => c.action === "timeControl").map((c) => [c.section, c.value]);
blitzShown.problems.startsWith("Extra games: G/5;+3 is blitz") && blitzShown.fields.join() === "Open,Extra games"
  && dualShown.problems === "" && dualShown.dual && dualShown.main
  && JSON.stringify(controlCalls) === JSON.stringify([["Extra games", "G/5;+3"], ["Extra games", "G/30;+30"], ["Extra games", ""]])
  && unreadable.invalid === "true" && unreadable.error.startsWith('Extra games: "thirty plus thirty" isn\'t a time control')
  ? pass("TD desk keeps a time control for each section, and holds back the files for one the upload can't carry")
  : fail(`TD desk section time controls: ${JSON.stringify({ blitzShown, dualShown, unreadable, controlCalls })}`);
await axeBoth(extraPage, "TD desk with an extra games section");
for (const width of [1600, 390]) {
  await extraPage.setViewport({ width, height: 900 });
  if (process.env.SHOTS) await extraPage.screenshot({ path: `${process.env.SHOTS}/extra-${width}.png`, fullPage: true });
}
await fitsPhone(extraPage, "TD desk with an extra games section");
extraForm.name === "Extra games" && extraForm.rounds === "1" && extraForm.players.length === 4 && extraForm.players.every(Boolean)
  && JSON.stringify(extraCheckin.headings) === JSON.stringify(["Extra games (4)"]) && extraCheckin.rows === 4 && extraCheckin.report
  && extraCheckin.list.startsWith("Extra games: 4 players, round 4.") && extraCheckin.planned.join() === "Open,Extra games" && extraCheckin.rounds === "3"
  && extraPosted.join() === "Extra games,Extra games" && extraDone.standings.join() === "Open,Extra games"
  && extraDone.openScores.join() === "2.5,2,1.5,0" && extraDone.sections === 2 && extraDone.players === 8
  ? pass("TD desk adds an extra games section after the last round: it pairs and scores apart, and the rating report has it as a section")
  : fail(`TD desk extra games section: ${JSON.stringify({ extraForm, extraCheckin, extraPosted, extraDone })}`);
await extraPage.close();

// The Pairings page numbers an extra games section's rounds from 1, and a report from it names the tournament's round.
const withExtra = () => {
  const [t] = twoSections();
  t.sections = [{ name: "Open", last: 2 }, { name: "Under 1400", under: 1400, last: 2 },
    { name: "Extra games", extra: true, first: 3, last: 4, players: ["a", "e"] }];
  t.plannedRounds = 4;
  t.rounds[1].games.forEach((g) => { g.result ||= "1-0"; });
  t.rounds.push({ games: [{ board: 1, white: "e", black: "a", result: "", section: "Extra games" }], byes: [], out: [], posted: true });
  return [t];
};
const extraReports = [];
const extraPairings = await mocked("/pairings/ with an extra games section", (p) => {
  if (p.action === "report") extraReports.push(p);
  return p.action === "report" ? { ok: true, message: "Reported." } : { tournaments: withExtra() };
});
await extraPairings.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const extraShown = await extraPairings.evaluate(() => [...document.querySelectorAll(".pairings-all h3")].map((h) =>
  [h.textContent, h.nextElementSibling.querySelector("select")?.selectedOptions[0].textContent]));
JSON.stringify(extraShown) === JSON.stringify([["Open", "2 of 2"], ["Under 1400", "2 of 2"], ["Extra games", "1 of 2"]])
  ? pass("Pairings page numbers an extra games section's rounds from 1") : fail(`Pairings page extra games section: ${JSON.stringify(extraShown)}`);
await extraPairings.evaluate(() => { found.add("e"); redrawAll(); });
await extraPairings.$$eval(".report button", (b) => b[0].click());
await extraPairings.waitForFunction(() => document.querySelector(".report [role=status]")?.textContent === "Reported.");
extraReports.length === 1 && extraReports[0].number === "3" && extraReports[0].section === "Extra games"
  ? pass("Pairings page reports an extra games section's game by the tournament's round")
  : fail(`Pairings page extra games report: ${JSON.stringify(extraReports)}`);
await extraPairings.close();

// Quads with an extra games section: its round checks in as a Swiss's, with byes, and it ranks as a Swiss beside the quads.
const quadPlayers = [...Array(8)].map((_, i) => ({ id: `9000002${i}`, number: i + 1, name: `Q${i + 1}`, rating: 2000 - i * 50,
  section: i < 4 ? "Quad 1" : "Quad 2", out: null }));
const quadRounds = [1, 2, 3].map((n) => {
  const games = Pairing.pairQuadRound(quadPlayers, n).games.map((g) => ({ ...g, result: "1-0",
    section: quadPlayers.find((p) => p.id === g.white).section }));
  games.forEach((g) => { if (g.section === "Quad 2") g.board -= 2; });
  return { games, byes: [], out: [], posted: true };
});
const quadDesk = deskState(quadRounds);
Object.assign(quadDesk.held, { format: "quad", players: quadPlayers,
  sections: [{ name: "Quad 1", last: 3 }, { name: "Quad 2", last: 3 },
    { name: "Extra games", extra: true, first: 4, last: 4, players: quadPlayers.slice(0, 3).map((p) => p.id) }], plannedRounds: 4 });
const quadExtra = await mocked("/td/ quads with an extra games section", (p) => quadDesk.answer(p));
await signIn(quadExtra);
await quadExtra.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 4: check in");
const quadShown = await quadExtra.evaluate(() => ({
  options: [...document.querySelector(".run-this-round").options].map((o) => o.value),
  standings: [...document.querySelectorAll(".run-standings")].map((t) => [...t.tHead.rows[0].cells].map((c) => c.textContent)
    .find((h) => !/^(Place|Name|Rating|Score|Round \d+)$/.test(h))),
  planned: [...document.querySelectorAll("#run-planned-section option")].map((o) => o.value), plannedShown: !document.querySelector(".run-planned").hidden,
  quadHead: [...document.querySelector(".run-standings").tHead.rows[0].cells].map((c) => c.textContent),
  quadTop: [...document.querySelector(".run-standings").tBodies[0].rows[0].cells].slice(0, 9).map((c) => c.textContent) }));
await axeBoth(quadExtra, "TD desk with quads and an extra games section");
for (const width of [1600, 390]) {
  await quadExtra.setViewport({ width, height: 900 });
  if (process.env.SHOTS) await quadExtra.screenshot({ path: `${process.env.SHOTS}/quad-standings-${width}.png`, fullPage: true });
}
await fitsPhone(quadExtra, "TD desk with quads and an extra games section");
// Q3 beats Q1 and Q4 and loses to Q2, and Q1 beats Q2 and Q4: tied on 2, Q3 is ahead on Sonneborn-Berger, so no head-to-head.
quadShown.quadHead.join("|") === "Place|Name|Rating|Score|Round 1|Round 2|Round 3|Sonneborn-Berger|Head-to-head|Performance|Est. rating|Withdraw"
  && quadShown.quadTop.join("|") === "1|Q3|1900|2|L3 b|W2 w|W4 w|3|"
  ? pass("TD desk quad standings show each round and head-to-head, as the Standings page does")
  : fail(`TD desk quad standings: ${JSON.stringify([quadShown.quadHead, quadShown.quadTop])}`);
JSON.stringify(quadShown.options) === JSON.stringify(["play", "absent", "zero", "withdraw"])
  && quadShown.standings.join() === "Sonneborn-Berger,Sonneborn-Berger,Median" && quadShown.planned.join() === "Extra games" && quadShown.plannedShown
  ? pass("TD desk runs quads' extra games section as a Swiss without half-point byes, and changes only its rounds")
  : fail(`TD desk quads with an extra games section: ${JSON.stringify(quadShown)}`);
await quadExtra.close();

// An entrant who came after the quads were made plays in an extra games section only: the form lists them unchosen,
// adding the section sends them, and each extra section's menu adds another player.
const lateDesk = deskState(quadRounds.map((r) => ({ ...r, games: r.games.filter((g) => g.section === "Quad 1") })));
const quadOne = quadPlayers.slice(0, 4);
Object.assign(lateDesk.held, { format: "quad", players: quadOne, sections: [{ name: "Quad 1" }] });
const cory = { id: "13802751", name: "Cory Kohler", rating: "1882", for: "Saturday", out: "" };
const lateAnswer = lateDesk.answer;
lateDesk.answer = (p) => {
  const held = lateDesk.held;
  if (p.action === "entries") return { entries: [cory, ...quadOne.map((q) => ({ id: q.id, name: q.name, rating: String(q.rating), out: "" }))] };
  if (p.action === "extraSection") {
    lateDesk.calls.push(p);
    const ids = JSON.parse(p.players);
    if (ids.includes(cory.id)) held.players.push({ id: cory.id, number: 5, name: cory.name, rating: 1882, section: p.name, out: null });
    held.sections = [{ name: "Quad 1", last: 3 }, { name: p.name, extra: true, first: 4, last: 4, players: ids }];
    held.plannedRounds = 4;
    return { ok: true, message: `${p.name}: ${ids.length} players, 1 round from round 4.` };
  }
  if (p.action === "extraPlayer") {
    lateDesk.calls.push(p);
    held.sections[1].players.push(p.id);
    return { ok: true, message: "Added." };
  }
  return lateAnswer(p);
};
const latePage = await mocked("/td/ an entrant in an extra games section only", (p) => lateDesk.answer(p));
await signIn(latePage);
await latePage.waitForFunction(() => [...document.querySelectorAll(".run-extra-players label")].some((l) => l.textContent.includes("Cory")));
await latePage.click(".run-extra-wrap summary");
const lateForm = await latePage.$$eval(".run-extra-players label", (labels) => labels.map((l) => [l.textContent.trim(), l.querySelector("input").checked]));
for (const id of ["90000021", "90000022", "90000023"]) await latePage.click(`.run-extra-players input[value="${id}"]`);
await latePage.click(`.run-extra-players input[value="${cory.id}"]`);
await press(latePage, ".run-extra button[type=submit]");
await latePage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 4: check in");
const lateSent = JSON.parse(lateDesk.calls.find((c) => c.action === "extraSection")?.players || "[]");
const lateIn = await latePage.$$eval('.run-this-round[data-id="13802751"]', (s) => s.map((x) => x.dataset.section));
await latePage.waitForSelector(".run-extra-add");
const lateMenu = await latePage.$$eval(".run-extra-add option", (o) => o.map((x) => x.value));
await latePage.select(".run-extra-add", "90000021");
await press(latePage, '.run-extra-list button[data-focus="add-Extra games"]');
await latePage.waitForFunction(() => document.querySelector(".run-status").textContent === "Added.");
const lateAdded = lateDesk.calls.find((c) => c.action === "extraPlayer") || {};
JSON.stringify(lateForm) === JSON.stringify([["Q1 (2000)", true], ["Q2 (1950)", true], ["Q3 (1900)", true], ["Q4 (1850)", true],
  ["Cory Kohler (1882), entered, not in a quad yet", false]])
  && lateSent.join() === "90000020,13802751" && lateIn.join() === "Extra games" && lateMenu.join() === "90000021,90000022,90000023"
  && lateAdded.section === "Extra games" && lateAdded.id === "90000021"
  ? pass("TD desk puts an entrant who isn't in a quad into an extra games section only, and adds a player to one")
  : fail(`TD desk entrant in an extra games section: ${JSON.stringify({ lateForm, lateSent, lateIn, lateMenu, lateAdded })}`);
await axeBoth(latePage, "TD desk adding a player to an extra games section");
await latePage.close();

// Byes by the rules on the desk: Cal lost round 1 by forfeit, so he starts round 2 as not here (28P); Fay entered
// late and has no round 1, which the TD can make a half-point bye (28K); and a full-point bye the TD gives Ann,
// who had one in round 1, keeps the round from being saved or posted (28L3).
const byeRules = deskState([{ games: [{ board: 1, white: "22222222", black: "33333333", result: "1F-0F", section: "" },
  { board: 2, white: "44444444", black: "55555555", result: "1-0", section: "" }],
byes: [{ id: "11111111", points: 1, kind: "bye", section: "" }], out: [], posted: true }]);
byeRules.held.players = sixPlayers;
const byePage = await mocked("/td/ byes by the rules", (p) => byeRules.answer(p));
await signIn(byePage);
await byePage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 2: check in");
const noShow = await byePage.evaluate(() => {
  const select = document.querySelector('.run-this-round[data-id="33333333"]');
  return { value: select.value, name: select.closest("tr").cells[1].textContent };
});
await byePage.select('.run-byes-all select[aria-label="Fay (1100), round 1"]', "half");
await byePage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Half-point bye"));
const lateBye = byeRules.calls.find((c) => c.action === "byeKind") || {};
await press(byePage, ".run-pair");
await byePage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("pairings to review"));
await byePage.select("#run-move-0", "11111111");
await byePage.select("#run-move-kind-0", "bye");
await press(byePage, ".run-tools button[data-focus='0|move']");
await press(byePage, ".run-post");
const warned = await byePage.evaluate(() => ({ items: [...document.querySelectorAll(".run-problems li")].map((li) => li.textContent),
  status: document.querySelector(".run-status").textContent }));
const postedAnyway = byeRules.calls.some((c) => c.action === "round");
noShow.value === "absent" && noShow.name.includes("28P") && lateBye.id === "66666666" && lateBye.number === "1" && lateBye.kind === "half"
  && lateBye.section === "" && warned.items.includes("Ann has had a full-point bye already, and 28L3 allows one.")
  && warned.status.startsWith("Not saved yet.") && !postedAnyway
  ? pass("TD desk starts a forfeit loser as not here (28P), lets a late entrant's missed round be a half-point bye (28K), and refuses a second full-point bye (28L3)")
  : fail(`TD desk byes by the rules: ${JSON.stringify({ noShow, lateBye, warned })}`);
await axeBoth(byePage, "TD desk refusing a full-point bye");
await byePage.close();

// Give a bye, under the standings, offers only the byes the rules allow: Fay's missed round 1 can't be a second
// full-point bye (28L1), a round to come is saved as the half-point bye she asks for through her entry, and then
// she has her one (22C), which check-in starts her on; Ann can't add a last-round half-point bye once round 1 is posted
// (22C4), but can have a zero-point bye in any round to come, which check-in starts her on too.
const giveRules = deskState(JSON.parse(JSON.stringify(byeRules.held.rounds.slice(0, 1))));
giveRules.held.players = sixPlayers;
const giveAnswer = giveRules.answer;
giveRules.answer = (p) => {
  const asked = giveRules.asked ??= {};
  const list = (text) => (text ? text.split(", ") : []);
  if (p.action === "entries") return { entries: sixPlayers.map((x) => ({ name: x.name, id: x.id, rating: x.rating, for: "Saturday, November 7",
    date: "2026-11-07", token: `t-${x.id}`, ...asked[x.id] })) };
  if (p.action === "byes") {
    giveRules.calls.push(p);
    const id = p.token.slice(2);
    asked[id] = { byes: list(p.byes), zeroByes: list(p.zeroByes) };
    giveRules.held.players = sixPlayers.map((x) => (asked[x.id] ? { ...x, byes: asked[x.id].byes.map(Number), zeroByes: asked[x.id].zeroByes.map(Number) } : x));
    return { ok: true, message: `${sixPlayers.find((x) => x.id === id).name}'s byes are saved.` };
  }
  return giveAnswer(p);
};
const givePage = await mocked("/td/ giving a bye", (p) => giveRules.answer(p));
await signIn(givePage);
await givePage.waitForFunction(() => !document.querySelector(".run-give-bye").hidden && document.querySelectorAll(".td-entries tbody tr").length === 6);
const offered = () => givePage.evaluate(() => ({ rounds: [...document.querySelectorAll("#run-bye-round option")].map((o) => o.textContent),
  kinds: [...document.querySelectorAll("#run-bye-kind option")].map((o) => o.value), why: document.getElementById("run-bye-why").textContent }));
await givePage.select("#run-bye-player", "66666666");
const fayRound1 = await offered();
await givePage.select("#run-bye-round", "Round 2");
await givePage.select("#run-bye-kind", "half");
await press(givePage, ".run-give-bye button");
await givePage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("half-point bye asked for"));
const asked = giveRules.calls.find((c) => c.action === "byes") || {};
await givePage.select("#run-bye-round", "Round 3");
const fayRound3 = await offered();
const checkinStart = await givePage.waitForFunction(() => document.querySelector('.run-this-round[data-id="66666666"]')?.value === "half")
  .then(() => "half", () => "");
await givePage.select("#run-bye-player", "11111111");
await givePage.select("#run-bye-round", "Round 3");
const annRound3 = await offered();
await givePage.select("#run-bye-round", "Round 2");
await givePage.select("#run-bye-kind", "zero");
await press(givePage, ".run-give-bye button");
await givePage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("zero-point bye asked for"));
const annAsked = giveRules.calls.filter((c) => c.action === "byes").at(-1);
const annCheckin = await givePage.waitForFunction(() => document.querySelector('.run-this-round[data-id="11111111"]')?.value === "zero")
  .then(() => "zero", () => "");
JSON.stringify(fayRound1.rounds) === JSON.stringify(["Round 1, unplayed (0)", "Round 2, to come", "Round 3, to come"])
  && fayRound1.kinds.join() === "half,zero,unplayed" && fayRound1.why.includes("28L1")
  && asked.token === "t-66666666" && asked.byes === "2" && asked.zeroByes === ""
  && fayRound3.rounds[1] === "Round 2, half-point bye asked for" && fayRound3.kinds.join() === "play,zero" && fayRound3.why.includes("allows one per player")
  && annRound3.kinds.join() === "play,zero" && annRound3.why.includes("22C4") && checkinStart === "half"
  && annAsked?.token === "t-11111111" && annAsked.byes === "" && annAsked.zeroByes === "2" && annCheckin === "zero"
  ? pass("TD desk's Give a bye offers only the byes the rules allow, in rounds played and to come, saves one to come with the entry, half-point or zero-point, and check-in starts the player on it")
  : fail(`TD desk Give a bye: ${JSON.stringify({ fayRound1, asked, fayRound3, annRound3, checkinStart, annAsked, annCheckin })}`);
await givePage.setViewport(PHONE);
await fitsPhone(givePage, "TD desk giving a bye");
await axeBoth(givePage, "TD desk giving a bye");
await givePage.close();

// The Results page pages its table 20 rows at a time; it is served here with 45 made-up rows
// in place of the real ones.
const resultsPage = await browser.newPage();
resultsPage.on("pageerror", (error) => fail(`JavaScript error on /results/: ${error.message}`));
await resultsPage.setRequestInterception(true);
resultsPage.on("request", async (request) => {
  if (new URL(request.url()).pathname !== "/results/") return request.continue();
  const rows = [...Array(45)].map((_, i) => `<tr><td>Day ${i + 1}</td><td><a href="/results/t-${i + 1}/">Tournament ${i + 1}</a></td></tr>`).join("");
  const page = (await (await fetch(base + "/results/")).text())
    .replace(/(<h2 class="visually-hidden">Tournaments<\/h2>)[\s\S]*?(<\/section>)/, `$1<table class="entries results-table"><thead><tr><th scope="col">Date</th><th scope="col">Tournament</th></tr></thead><tbody>${rows}</tbody></table><nav class="results-pages" aria-label="Pages of results" hidden></nav>$2`)
    .replace(/<script src="\.\.\/results\.js[^"]*" defer><\/script>/, "")
    .replace("</body>", '<script src="../results.js" defer></script></body>');
  request.respond({ contentType: "text/html", body: page });
});
await resultsPage.goto(base + "/results/", { waitUntil: "networkidle0" });
const resultsShown = () => resultsPage.evaluate(() => ({
  visible: [...document.querySelectorAll(".results-table tbody tr:not([hidden])")].map((r) => r.cells[1].textContent),
  where: document.querySelector(".results-pages [role=status]")?.textContent, address: location.search }));
const firstPage = await resultsShown();
await resultsPage.click(".results-pages button:last-child");
await resultsPage.click(".results-pages button:last-child");
const lastPage = await resultsShown();
firstPage.visible.length === 20 && firstPage.visible[0] === "Tournament 1" && firstPage.where === "Page 1 of 3"
  && lastPage.visible.length === 5 && lastPage.visible[0] === "Tournament 41" && lastPage.where === "Page 3 of 3" && lastPage.address === "?page=3"
  ? pass("Results page shows 20 tournaments a page, with the page in the address")
  : fail(`Results paging: ${JSON.stringify({ firstPage, lastPage })}`);
await resultsPage.evaluate(axeSource);
const resultsAxe = await resultsPage.evaluate(() => axe.run());
resultsAxe.violations.length ? fail(`Results page paged: ${resultsAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("Results page paged has no axe violations");
await resultsPage.close();

await done();
