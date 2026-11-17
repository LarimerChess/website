// Tournament withdrawal controls beside registration removal, before any round and
// while a draft is open. Bringing a player back must preserve that draft.
import { PHONE, axeBoth, deskState, done, fail, fitsPhone, mocked, pass, press, signIn } from "./common.mjs";

function rosterState(rounds) {
  const state = deskState(rounds);
  state.answerBase = state.answer;
  state.answer = (p) => {
    if (p.action === "entries") return { entries: state.held.players.map((player) => ({ ...player, out: null,
      rating: String(player.rating), for: "Tournament", category: "Adult", amount: "0", due: "0", card: "0", balance: "0",
      email: "", expires: "2027-01-31", token: player.id, date: "2026-11-07" })) };
    if (p.action === "out") {
      state.calls.push(p);
      if (state.refuse) return { error: "The status change was refused." };
      const player = state.held.players.find((x) => x.id === p.id);
      player.out = Number(p.from) || null;
      return { ok: true, message: player.out ? `${player.name} is withdrawn.` : `${player.name} is back in.` };
    }
    return state.answerBase(p);
  };
  return state;
}

const actions = (tab, name) => tab.$$eval(".td-entries tbody tr", (rows, who) => {
  const row = rows.find((r) => r.cells[0].textContent === who);
  return [...row.cells[row.cells.length - 1].querySelectorAll("button")].map((b) => b.textContent.trim());
}, name);
const control = '.td-entries tbody tr:nth-child(3) .td-entry-withdrawal button';

const before = rosterState([]);
before.held.players[2].out = 1;
const tab = await mocked("/td/ managing tournament withdrawal from the roster", before.answer, PHONE);
tab.on("dialog", (dialog) => dialog.accept());
await signIn(tab);
await tab.waitForSelector(control);
JSON.stringify(await actions(tab, "Cal")) === JSON.stringify(["Remove Cal", "Bring back Cal"])
  ? pass("The full roster offers Bring back beside Remove before round one")
  : fail(`Unexpected roster controls: ${JSON.stringify(await actions(tab, "Cal"))}`);
await press(tab, control);
await tab.waitForFunction(() => document.querySelectorAll(".run-this-round").length === 4);
JSON.stringify(await actions(tab, "Cal")) === JSON.stringify(["Remove Cal", "Withdraw Cal"])
  && before.calls.some((p) => p.action === "out" && p.id === "33333333" && p.from === "")
  ? pass("Bring back restores the player to check-in and changes the roster action to Withdraw")
  : fail("Bring back did not update the roster and check-in");
await tab.select('select[aria-label="Ann this round"]', "absent");
await press(tab, control);
await tab.waitForFunction(() => document.querySelectorAll(".run-this-round").length === 3);
const ann = await tab.$eval('select[aria-label="Ann this round"]', (s) => s.value);
ann === "absent" && before.calls.some((p) => p.action === "out" && p.id === "33333333" && p.from === "1")
  && !before.calls.some((p) => p.action === "remove")
  ? pass("Withdraw saves the tournament status while preserving other check-in choices and the entry")
  : fail("Roster withdrawal lost check-in choices or removed the entry");
await axeBoth(tab, "TD roster with withdrawal controls");
await fitsPhone(tab, "TD roster with withdrawal controls");
before.refuse = true;
await press(tab, control);
await tab.waitForSelector(".td-refused[open]");
before.held.players[2].out === 1 && (await actions(tab, "Cal"))[1] === "Bring back Cal"
  ? pass("A refused roster status change leaves the withdrawal and action unchanged")
  : fail("A refused status change altered the roster");
await tab.close();

const draftState = rosterState([{ posted: false, out: ["33333333"], byes: [], games: [
  { board: 1, white: "11111111", black: "33333333", result: "", section: "" },
  { board: 2, white: "22222222", black: "44444444", result: "", section: "" },
] }]);
draftState.held.players[2].out = 1;
const draftPage = await mocked("/td/ restoring a falsely withdrawn player without losing pairings", draftState.answer);
await signIn(draftPage);
await draftPage.waitForSelector(control);
await draftPage.waitForSelector(".run-pairings:not([hidden])");
await press(draftPage, ".run-games tbody tr:nth-child(1) .td-buttons button:first-child");
const draftBefore = await draftPage.evaluate(() => JSON.stringify(draft));
await press(draftPage, control);
await draftPage.waitForFunction(() => document.querySelector(".run-problems").hidden);
const preserved = await draftPage.evaluate(() => ({ draft: JSON.stringify(draft), out: current.rounds[0].out }));
preserved.draft === draftBefore && !preserved.out.includes("33333333")
  ? pass("Bring back clears the false flag and round history while preserving unsaved pairings exactly")
  : fail(`Restoring the player changed unsaved pairings: ${JSON.stringify(preserved)}`);
await press(draftPage, ".run-post");
await draftPage.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 1: results");
const posted = draftState.calls.find((c) => c.action === "round");
const games = JSON.parse(posted.games);
games.length === 2 && games[0].white === "33333333" && games[0].black === "11111111"
  && !draftState.calls.some((c) => c.action === "remove")
  ? pass("The unchanged draft posts with the restored player still paired")
  : fail(`Unexpected restored pairings: ${JSON.stringify(games)}`);
await draftPage.close();

await done();
