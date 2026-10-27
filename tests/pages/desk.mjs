// The TD desk's results view, editing and pairing drafts, and byes at check-in.
import { PHONE, axeBoth, deskState, done, fail, fitsPhone, fourPlayers, mocked, pass, press, signIn, sixPlayers } from "./common.mjs";

const draftShown = (tab) => tab.evaluate(() => ({
  games: [...document.querySelectorAll(".run-games tbody tr")].map((r) => [r.cells[0].textContent, ...[...r.querySelectorAll("select")].map((s) => s.value)]),
  off: [...document.querySelectorAll(".run-off tbody tr")].map((r) => [r.cells[0].textContent, r.querySelector("select").value]),
  problems: document.querySelector(".run-problems").hidden ? [] : [...document.querySelectorAll(".run-problems li")].map((li) => li.textContent),
  status: document.querySelector(".run-status").textContent, title: document.querySelector(".run-round-title").textContent,
  cancel: !document.querySelector(".run-cancel").hidden }));

// The desk's results view with players' reports: Confirm one, then Confirm agreed results; a conflict is flagged.
const reportDesk = deskState([{ games: [
  { board: 1, white: "11111111", black: "33333333", result: "", section: "", reports: { white: "1-0", black: "1-0" } },
  { board: 2, white: "44444444", black: "22222222", result: "", section: "", reports: { white: "", black: "0-1" } }], byes: [], out: [], posted: true }]);
reportDesk.held.players = sixPlayers;
reportDesk.held.rounds[0].games.push({ board: 3, white: "55555555", black: "66666666", result: "", section: "", reports: { white: "1-0", black: "0-1" } });
const confirmPage = await mocked("/td/ confirming reported results", reportDesk.answer);
await signIn(confirmPage);
await confirmPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const reportedCells = () => confirmPage.evaluate(() => [...document.querySelectorAll(".run-games tbody tr")].map((r) => ({
  text: r.cells[3].childNodes[0]?.textContent || "", confirm: Boolean(r.cells[3].querySelector("button")), conflict: r.cells[3].className === "run-conflict",
  result: r.querySelector("select").value })));
const onArrival = await reportedCells();
const agreedButton = () => confirmPage.$eval(".run-confirm-agreed", (b) => (b.hidden ? "" : b.textContent));
JSON.stringify(onArrival) === JSON.stringify([
  { text: "1–0, both reported", confirm: true, conflict: false, result: "" }, { text: "0–1, Black reported", confirm: true, conflict: false, result: "" },
  { text: "Conflict: White reported 1–0, Black 0–1", confirm: false, conflict: true, result: "" }]) && await agreedButton() === "Confirm agreed results (1)"
  ? pass("TD desk shows each board's reports, flags a conflict, and offers to confirm the agreed ones")
  : fail(`TD desk reports: ${JSON.stringify(onArrival)}, ${await agreedButton()}`);
await axeBoth(confirmPage, "TD desk with reported results");
await press(confirmPage, ".run-games tbody tr:nth-child(2) td:nth-child(4) button");
await confirmPage.waitForFunction(() => document.querySelector(".run-games tbody tr:nth-child(2) select").value === "0-1");
await press(confirmPage, ".run-confirm-agreed");
await confirmPage.waitForFunction(() => document.querySelector(".run-games tbody tr:nth-child(1) select").value === "1-0");
const confirmed = await reportedCells();
const one = reportDesk.calls.find((c) => c.action === "result") || {};
const together = reportDesk.calls.find((c) => c.action === "results") || {};
one.board === "2" && one.result === "0-1" && one.section === "" && together.number === "1"
  && together.results === JSON.stringify([{ board: 1, section: "", result: "1-0" }])
  && !confirmed[0].confirm && !confirmed[1].confirm && confirmed[2].result === "" && await agreedButton() === ""
  && await confirmPage.$eval(".run-edit", (b) => b.hidden)
  ? pass("TD desk confirms one report, then the agreed results together; the conflict waits for the TD")
  : fail(`TD desk confirming: ${JSON.stringify({ one, together, confirmed })}`);
await confirmPage.close();

// Editing a draft on a phone: swap colors, remove a board, refuse to save with players not yet
// paired, add a board, take a player out of a game for a bye, and seat a player from a bye.
const editDesk = deskState();
const editPage = await mocked("/td/ editing a draft", editDesk.answer, PHONE);
await signIn(editPage);
await editPage.waitForSelector(".run-start:not([hidden])");
await editPage.type("#run-rounds", "3");
await press(editPage, ".run-start button[type=submit]");
await editPage.waitForFunction(() => document.querySelectorAll(".run-attendance tbody tr").length === 4);
await press(editPage, ".run-pair");
await editPage.waitForSelector(".run-pairings:not([hidden])");
await press(editPage, ".run-games tbody tr:nth-child(1) .td-buttons button:nth-child(1)");
const swapped = await draftShown(editPage);
await press(editPage, ".run-games tbody tr:nth-child(2) .td-buttons button:nth-child(2)");
const removed = await draftShown(editPage);
await press(editPage, ".run-post");
const refused = await draftShown(editPage);
JSON.stringify(swapped.games) === JSON.stringify([["1", "33333333", "11111111", ""], ["2", "44444444", "22222222", ""]])
  && JSON.stringify(removed.games) === JSON.stringify([["1", "33333333", "11111111", ""]])
  && JSON.stringify(removed.off) === JSON.stringify([["Ben (1700)", "waiting"], ["Dee (1300)", "waiting"]])
  && removed.problems.length === 2 && removed.problems[0].startsWith("Ben (1700) isn't paired yet")
  && refused.status.startsWith("Not saved yet. Ben (1700) isn't paired yet") && !editDesk.calls.some((c) => c.action === "round")
  ? pass("TD desk swaps a board's colors, removes a board, and won't save with players not yet paired")
  : fail(`TD desk draft edits: ${JSON.stringify({ swapped, removed, refused })}`);
await editPage.select("#run-add-white-0", "44444444");
await editPage.select("#run-add-black-0", "22222222");
await press(editPage, ".run-tools p:nth-child(1) button");
const added = await draftShown(editPage);
await editPage.select("#run-move-0", "44444444");
await editPage.select("#run-move-kind-0", "bye");
await press(editPage, ".run-tools p:last-child button");
await editPage.select('select[aria-label="Ben (1700) this round"]', "half");
await editPage.select('select[aria-label="Board 1 white"]', "22222222");
const edited = await draftShown(editPage);
JSON.stringify(added.games) === JSON.stringify([["1", "33333333", "11111111", ""], ["2", "44444444", "22222222", ""]]) && added.problems.length === 0
  && JSON.stringify(edited.games) === JSON.stringify([["1", "22222222", "11111111", ""]])
  && JSON.stringify(edited.off) === JSON.stringify([["Cal (1500)", "unplayed"], ["Dee (1300)", "bye"]]) && edited.problems.length === 0
  ? pass("TD desk adds a board, moves a player out of a game to a bye, and seats a player from a bye, leaving the one displaced unplayed")
  : fail(`TD desk draft edits: ${JSON.stringify({ added, edited })}`);
await axeBoth(editPage, "TD desk editing a draft");
await fitsPhone(editPage, "TD desk editing a draft");
await press(editPage, ".run-post");
await editPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const editedRound = editDesk.calls.find((c) => c.action === "round") || {};
editedRound.games === JSON.stringify([{ board: 1, white: "22222222", black: "11111111", section: "", result: "" }])
  && editedRound.byes === JSON.stringify([{ id: "44444444", points: 1, kind: "bye", section: "" }, { id: "33333333", points: 0, kind: "unplayed", section: "" }])
  ? pass("TD desk posts the edited pairings") : fail(`TD desk edited round: ${JSON.stringify(editedRound)}`);
await editPage.close();

// Changing a posted round: Eve, who had the full-point bye, plays Cal in Ann's place, leaving Ann's round unplayed;
// the TD gives Ann the bye, which the rules would give Eve (28L2), and it posts with a note (29E7).
const byeDesk = deskState([{ games: [{ board: 1, white: "11111111", black: "33333333", result: "", section: "" },
  { board: 2, white: "22222222", black: "44444444", result: "", section: "" }],
byes: [{ id: "55555555", points: 1, kind: "bye", section: "" }], out: [], posted: true }]);
byeDesk.held.players = sixPlayers.slice(0, 5);
const byeChoicePage = await mocked("/td/ choosing the full-point bye", byeDesk.answer);
await signIn(byeChoicePage);
await byeChoicePage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
await press(byeChoicePage, ".run-edit");
await byeChoicePage.select('select[aria-label="Board 1 white"]', "55555555");
const displaced = await draftShown(byeChoicePage);
await byeChoicePage.select('select[aria-label="Ann (1900) this round"]', "bye");
const chosen = { ...await draftShown(byeChoicePage),
  notes: await byeChoicePage.$$eval(".run-notes li", (items) => items.map((li) => li.textContent)) };
await press(byeChoicePage, ".run-post");
await byeChoicePage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const chosenRound = byeDesk.calls.find((c) => c.action === "round") || {};
JSON.stringify(displaced.off) === JSON.stringify([["Ann (1900)", "unplayed"]]) && displaced.problems.length === 0
  && chosen.problems.length === 0 && chosen.notes.length === 1 && chosen.notes[0].startsWith("Ann is rated 1900; 28L2")
  && chosenRound.byes === JSON.stringify([{ id: "11111111", points: 1, kind: "bye", section: "" }])
  ? pass("TD desk leaves a player displaced by the bye player unplayed, and posts the full-point bye the TD chooses, noting 28L2")
  : fail(`TD desk choosing the full-point bye: ${JSON.stringify({ displaced, chosen, chosenRound })}`);
await byeChoicePage.close();

// Pairing by hand, then changing the posted round once a player has reported.
const handDesk = deskState();
const handPage = await mocked("/td/ pairing by hand", handDesk.answer);
handPage.on("dialog", (d) => d.accept());
await signIn(handPage);
await handPage.waitForSelector(".run-start:not([hidden])");
await handPage.type("#run-rounds", "3");
await press(handPage, ".run-start button[type=submit]");
await handPage.waitForFunction(() => document.querySelectorAll(".run-attendance tbody tr").length === 4);
await press(handPage, ".run-by-hand");
await handPage.waitForSelector(".run-pairings:not([hidden])");
const empty = await draftShown(handPage);
await press(handPage, ".run-tools p:nth-child(1) button");
await press(handPage, ".run-tools p:nth-child(1) button");
const byHand = await draftShown(handPage);
empty.games.length === 0 && empty.off.every(([, kind]) => kind === "waiting") && empty.off.length === 4 && empty.problems.length === 4
  && JSON.stringify(byHand.games) === JSON.stringify([["1", "11111111", "22222222", ""], ["2", "33333333", "44444444", ""]])
  && byHand.off.length === 0 && byHand.problems.length === 0
  ? pass("TD desk pairs a round by hand, starting with everyone not yet paired")
  : fail(`TD desk pairing by hand: ${JSON.stringify({ empty, byHand })}`);
await press(handPage, ".run-post");
await handPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
handDesk.held.rounds[0].games[0].reports = { white: "1-0", black: "" };
await press(handPage, ".run-refresh");
await handPage.waitForFunction(() => document.querySelector(".run-games tbody tr td:nth-child(4)").textContent.startsWith("1–0, White reported"));
await press(handPage, ".run-edit");
await handPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("change the posted"));
const reopened = await draftShown(handPage);
await press(handPage, ".run-games tbody tr:nth-child(2) .td-buttons button:nth-child(1)");
await axeBoth(handPage, "TD desk changing a posted round");
await press(handPage, ".run-post");
await handPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const reposted = handDesk.calls.filter((c) => c.action === "round");
reopened.cancel && JSON.stringify(reopened.games) === JSON.stringify(byHand.games) && reposted.length === 2
  && reposted[1].number === "1" && reposted[1].post === "yes"
  && JSON.parse(reposted[1].games).map((g) => [g.board, g.white, g.black]).join("|") === "1,11111111,22222222|2,44444444,33333333"
  && !(await handPage.$eval(".run-games tbody tr td:nth-child(4)", (c) => c.textContent))
  ? pass("TD desk changes a posted round without results and posts it again, which clears its reports")
  : fail(`TD desk editing a posted round: ${JSON.stringify({ reopened, reposted })}`);
await handPage.close();

// Byes asked for in advance at check-in: Ben and Cal asked for round 2, so both start round 2
// as half-point byes, which the pairing takes, without counting as unsaved work that holds back the desk's
// reloads. The rounds not yet paired are listed under Byes and unplayed rounds, and the register form offers only those.
const checkinByeDesk = deskState([{ games: [{ board: 1, white: "11111111", black: "33333333", result: "1-0", section: "" },
  { board: 2, white: "44444444", black: "22222222", result: "0-1", section: "" }], byes: [], out: [], posted: true }]);
checkinByeDesk.held.players[1].byes = [2];
checkinByeDesk.held.players[2].byes = [2];
const checkinByePage = await mocked("/td/ checking in byes asked for", checkinByeDesk.answer);
await signIn(checkinByePage);
await checkinByePage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 2: check in");
const checkinByes = await checkinByePage.evaluate(() => {
  document.activeElement?.blur();
  return { head: [...document.querySelectorAll(".run-attendance th")].map((th) => th.textContent),
    rows: [...document.querySelectorAll(".run-attendance tbody tr")].map((r) => [r.cells[1].textContent, r.cells[4].textContent, r.querySelector("select").value]),
    hint: document.querySelector(".run-checkin-hint").textContent, busy: runBusy(),
    asked: document.querySelector(".run-byes-all p:last-child").textContent,
    offered: [...document.querySelectorAll(".td-byes:not([hidden]) label")].map((l) => l.textContent.trim()) };
});
await checkinByePage.select('select[aria-label="Ann this round"]', "absent");
const checkinByesBusy = await checkinByePage.evaluate(() => { document.activeElement?.blur(); return runBusy(); });
await checkinByePage.select('select[aria-label="Ann this round"]', "play");
JSON.stringify(checkinByes.head) === JSON.stringify(["No.", "Name", "Rating", "Score", "Byes asked for", "This round"])
  && JSON.stringify(checkinByes.rows) === JSON.stringify([["Ann", "", "play"], ["Ben", "2", "half"], ["Cal", "2", "half"], ["Dee", "", "play"]])
  && checkinByes.hint.startsWith("Everyone starts as Present, or as a half-point bye if they asked for one this round;")
  && !checkinByes.busy && checkinByesBusy
  ? pass("TD desk starts a player who asked for a bye this round as a half-point bye, shows the byes asked for, and counts only a changed choice as unsaved")
  : fail(`TD desk check-in with byes: ${JSON.stringify({ checkinByes, checkinByesBusy })}`);
checkinByes.asked === "Asked for: Ben (1700), round 2; Cal (1500), round 2. Change them under Give a bye or in the entries list."
  && JSON.stringify(checkinByes.offered) === JSON.stringify(["Round 2", "Round 3"])
  ? pass("TD desk lists the byes asked for rounds not yet paired, and the register form offers only those rounds")
  : fail(`TD desk byes asked for: ${JSON.stringify({ asked: checkinByes.asked, offered: checkinByes.offered })}`);
await axeBoth(checkinByePage, "TD desk checking in byes asked for");
await checkinByePage.setViewport(PHONE);
await fitsPhone(checkinByePage, "TD desk checking in byes asked for");
await press(checkinByePage, ".run-pair");
await checkinByePage.waitForSelector(".run-pairings:not([hidden])");
const checkinByeDraft = await draftShown(checkinByePage);
checkinByeDraft.games.length === 1 && checkinByeDraft.games[0].slice(1, 3).sort().join() === "11111111,44444444"
  && JSON.stringify(checkinByeDraft.off) === JSON.stringify([["Ben (1700)", "half"], ["Cal (1500)", "half"]])
  ? pass("TD desk pairs the round with the half-point byes asked for") : fail(`TD desk pairing byes asked for: ${JSON.stringify(checkinByeDraft)}`);
await checkinByePage.close();

// A started month's tournament that comes back after the entries gives them its nights, past ones too; a bye
// saved from the entries list reaches check-in through the tournament's copy; and a player who entered only
// another night starts as not here.
const monthByeEntries = [{ name: "Ann", id: "11111111", rating: "1900", for: "Whole month", category: "Adult", amount: "17", due: "17",
  card: "17.80", email: "", expires: "2027-01-31", token: "ann1", date: "2026-10", byes: [] }];
const monthByeHeld = { key: "club-night/2026-10", name: "Club Night", format: "swiss", plannedRounds: 3, status: "running", coin: "white",
  roundDates: ["2026-10-12", "2026-10-19", "2026-10-26"],
  players: fourPlayers().map((p) => ({ ...p, ...{ "33333333": { nights: [2] }, "44444444": { nights: [1] } }[p.id] })),
  halfByes: { limit: 1, everyRound: true },
  rounds: [{ games: [{ board: 1, white: "22222222", black: "33333333", result: "1-0", section: "" },
    { board: 2, white: "11111111", black: "44444444", result: "1-0", section: "" }], byes: [], out: [], posted: true }] };
let releaseMonthBye;
const monthByeLoad = new Promise((resolve) => { releaseMonthBye = resolve; });
const monthByePage = await mocked("/td/ with a month's byes", async (p) => {
  if (p.action === "tournament") await monthByeLoad;
  if (p.action === "byes") {
    monthByeEntries[0].byes = p.byes.split(", ");
    monthByeHeld.players[0].byes = monthByeEntries[0].byes.map((date) => monthByeHeld.roundDates.indexOf(date) + 1);
    return { ok: true, message: "Ann's byes are saved." };
  }
  return { login: { ok: true, changes: null },
    choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" },
      { key: "club-night/2026-10-19", name: "Club Night", label: "Monday, October 19, 2026", kind: "night", first: "2026-10-19" },
      { key: "club-night/2026-10-26", name: "Club Night", label: "Monday, October 26, 2026", kind: "night", first: "2026-10-26" }] },
    people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: JSON.parse(JSON.stringify(monthByeEntries)) },
    ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
    incidents: { incidents: [] }, tournament: { tournament: JSON.parse(JSON.stringify(monthByeHeld)) } }[p.action] || { ok: true };
});
await signIn(monthByePage);
const monthByeCell = () => monthByePage.$eval(".td-entries tbody td:nth-child(5)", (c) => [...c.childNodes]
  .map((n) => (n.querySelector ? `${n.querySelector("input").value}${n.querySelector("input").checked ? " (checked)" : ""}` : n.textContent.trim())).filter(Boolean));
await monthByePage.waitForSelector(".td-entries tbody td:nth-child(5) input");
const monthByesEarly = await monthByeCell();
releaseMonthBye();
const monthByesRedrawn = await monthByePage.waitForFunction(() => document.querySelectorAll(".td-entries tbody td:nth-child(5) input").length === 3,
  { timeout: 5000 }).then(() => true, () => false);
const monthByesLoaded = await monthByeCell();
await monthByePage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 2: check in");
await monthByePage.click('.td-entries input[value="2026-10-19"]');
const monthByeCheckin = await monthByePage.waitForFunction(() => [...document.querySelectorAll(".run-attendance tbody tr")]
  .find((r) => r.cells[1].textContent === "Ann" && r.querySelector("select").value === "half")?.cells[4].textContent, { timeout: 5000 })
  .then((cell) => cell.jsonValue(), () => null);
const nightsCheckin = await monthByePage.$$eval(".run-attendance tbody tr", (rows) => rows.slice(2).map((r) => [r.cells[1].textContent, r.querySelector("select").value]));
JSON.stringify(nightsCheckin) === JSON.stringify([["Cal", "play"], ["Dee (entered for October 12 only)", "absent"]])
  ? pass("TD desk's check-in starts a player who entered only another night of the month as not here")
  : fail(`TD desk check-in by nights: ${JSON.stringify(nightsCheckin)}`);
JSON.stringify(monthByesEarly) === JSON.stringify(["2026-10-19", "2026-10-26"]) && monthByesRedrawn
  && JSON.stringify(monthByesLoaded) === JSON.stringify(["2026-10-12", "2026-10-19", "2026-10-26"])
  && monthByeCheckin?.replaceAll(" ", " ") === "2 (October 19)"
  ? pass("TD desk shows a started month's nights, past ones too, once its tournament loads, and check-in follows a bye saved from the entries")
  : fail(`TD desk month byes: ${JSON.stringify({ monthByesEarly, monthByesRedrawn, monthByesLoaded, monthByeCheckin })}`);
await monthByePage.close();

await done();
