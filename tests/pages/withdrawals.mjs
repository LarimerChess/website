// Withdrawals must agree at check-in, pairing, and posting, including a withdrawal
// that starts in the round being paired and isn't in the round history yet.
import { deskState, done, fail, mocked, pass, press, signIn, sixPlayers } from "./common.mjs";

const completed = () => ({ posted: true, out: [], byes: [], games: [
  { board: 1, white: "11111111", black: "33333333", result: "1-0", section: "" },
  { board: 2, white: "22222222", black: "44444444", result: "1-0", section: "" },
] });

for (const scenario of [
  { label: "all players present" },
  { label: "withdrawn this round", from: 2 },
  { label: "withdrawn before the first round", from: 1, first: true },
  { label: "withdrawn in an earlier round", from: 1, history: true },
  { label: "withdrawn in a future round", from: 3 },
  { label: "withdrawn during check-in", fresh: true },
  { label: "withdrawn this round, paired by hand", from: 2, hand: true },
  { label: "withdrawn this round in a round robin", from: 2, robin: true },
]) {
  const state = deskState(scenario.first ? [] : [completed()]);
  const number = scenario.first ? 1 : 2;
  state.held.players[2].out = scenario.from || null;
  if (scenario.history) state.held.rounds[0].out = ["33333333"];
  if (scenario.robin) state.held.sections = [{ name: "Open", format: "rr" }];
  const tab = await mocked(`/td/ ${scenario.label}`, (p) => {
    if (p.action === "out") state.held.players.find((x) => x.id === p.id).out = Number(p.from) || null;
    return state.answer(p);
  });
  await signIn(tab);
  await tab.waitForFunction((n) => document.querySelector(".run-round-title").textContent === `Round ${n}: check in`, {}, number);
  const attending = await tab.$$eval(".run-this-round", (items) => items.map((s) => s.dataset.id));
  const alreadyOut = scenario.from && scenario.from <= number;
  attending.length === (alreadyOut ? 3 : 4) && attending.includes("33333333") === !alreadyOut
    ? pass(`${scenario.label}: check-in offers only players eligible this round`)
    : fail(`${scenario.label}: unexpected check-in ${JSON.stringify(attending)}`);
  if (scenario.fresh) {
    tab.on("dialog", (dialog) => dialog.accept());
    await tab.select('select[aria-label="Cal this round"]', "withdraw");
  }
  await press(tab, scenario.hand ? ".run-by-hand" : ".run-pair");
  await tab.waitForSelector(".run-pairings:not([hidden])");
  if (scenario.hand) {
    await press(tab, ".run-tools p:first-child button");
    await tab.select('select[aria-label="Dee (1300) this round"]', "unplayed");
  }
  const draft = await tab.evaluate(() => ({
    problems: [...document.querySelectorAll(".run-problems li")].map((li) => li.textContent),
    placed: [...document.querySelectorAll(".run-games tbody select[aria-label$='white'], .run-games tbody select[aria-label$='black']")].map((s) => s.value),
    off: [...document.querySelectorAll(".run-off tbody tr")].map((r) => r.cells[0].textContent),
  }));
  const excluded = alreadyOut || scenario.fresh;
  !draft.problems.length && draft.placed.includes("33333333") === !excluded && !draft.off.some((s) => s.startsWith("Cal"))
    ? pass(`${scenario.label}: the draft respects the withdrawal's starting round`)
    : fail(`${scenario.label}: unexpected draft ${JSON.stringify(draft)}`);
  if (!draft.problems.length) {
    await press(tab, ".run-post");
    await tab.waitForFunction((n) => document.querySelector(".run-round-title").textContent === `Round ${n}: results`, {}, number);
    const posted = state.calls.find((c) => c.action === "round");
    const games = JSON.parse(posted.games), byes = JSON.parse(posted.byes);
    posted.post === "yes" && games.some((g) => g.white === "33333333" || g.black === "33333333") === !excluded
      && !byes.some((b) => b.id === "33333333") && !state.calls.some((c) => c.action === "remove")
      && state.calls.filter((c) => c.action === "out").length === (scenario.fresh ? 1 : 0)
      ? pass(`${scenario.label}: posts without removing an entrant`)
      : fail(`${scenario.label}: unexpected post ${JSON.stringify(posted)}`);
  }
  await tab.close();
}

for (const hand of [false, true]) {
  const state = deskState([completed()]);
  const tab = await mocked("/td/ cancelling an unintended withdrawal", state.answer);
  await signIn(tab);
  await tab.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 2: check in");
  let warning = "";
  tab.on("dialog", (dialog) => { warning = dialog.message(); return dialog.dismiss(); });
  await tab.select('select[aria-label="Cal this round"]', "withdraw");
  await press(tab, hand ? ".run-by-hand" : ".run-pair");
  const stillCheckingIn = await tab.$eval(".run-checkin", (el) => !el.hidden);
  warning.includes("Cal (1500)") && warning.includes("round 2") && stillCheckingIn
    && !state.calls.some((c) => c.action === "out") && state.held.players.every((p) => !p.out)
    ? pass("Cancelling the withdrawal warning leaves all players active and the check-in open")
    : fail(`Unexpected cancelled withdrawal: ${JSON.stringify({ warning, stillCheckingIn, calls: state.calls.map((c) => c.action) })}`);
  await tab.close();
}

for (const hand of [false, true]) {
  const state = deskState([completed()]);
  const tab = await mocked("/td/ a withdrawal the service refused", (p) => {
    if (p.action === "out") return { error: "The withdrawal was refused." };
    return state.answer(p);
  });
  tab.on("dialog", (dialog) => dialog.accept());
  await signIn(tab);
  await tab.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 2: check in");
  await tab.select('select[aria-label="Cal this round"]', "withdraw");
  await press(tab, hand ? ".run-by-hand" : ".run-pair");
  await tab.waitForFunction(() => document.querySelector(".run-status").textContent === "The withdrawal was refused.");
  const unchanged = await tab.evaluate(() => !document.querySelector(".run-checkin").hidden && current.players.every((p) => !p.out) && !draft);
  unchanged && !state.calls.some((c) => c.action === "round")
    ? pass("A refused withdrawal leaves the roster active and stops pairing")
    : fail("A refused withdrawal changed the roster or created pairings");
  await tab.close();
}

// A saved draft can retain zero-point unplayed records for players who withdrew.
// Those records must not prevent the remaining players' pairings from posting.
for (const legacy of [false, true]) {
  const ids = sixPlayers.slice(2).map((p) => p.id);
  const state = deskState([{ posted: false, out: ids,
    games: [{ board: 1, white: "11111111", black: "22222222", result: "", section: "Open" }],
    byes: ids.map((id) => ({ id, points: 0, ...(legacy ? {} : { kind: "unplayed" }), section: "Open" })),
  }]);
  state.held.sections = [{ name: "Open" }, { name: "Reserve" }];
  state.held.players = sixPlayers.map((p) => ({ ...p, section: "Open", out: ids.includes(p.id) ? 1 : null }));
  const tab = await mocked("/td/ posting with withdrawn unplayed records", state.answer);
  await signIn(tab);
  await tab.waitForSelector(".run-pairings:not([hidden])");
  const problems = await tab.$$eval(".run-problems li", (items) => items.map((li) => li.textContent));
  !problems.length ? pass("Withdrawn players' unplayed records do not block posting")
    : fail(`Withdrawn unplayed records block posting: ${JSON.stringify(problems)}`);
  if (!problems.length) {
    await press(tab, ".run-post");
    await tab.waitForFunction(() => document.querySelector(".run-round-title").textContent === "Round 1: results");
    const posted = state.calls.find((c) => c.action === "round");
    const byes = JSON.parse(posted.byes);
    JSON.parse(posted.games).length === 1 && byes.length === 4 && byes.every((b) => b.kind === "unplayed" && b.points === 0)
      && state.held.players.length === 6 && !state.calls.some((c) => ["remove", "out"].includes(c.action))
      ? pass("Posts existing pairings intact without removing or withdrawing anyone")
      : fail(`Unexpected post with withdrawn unplayed records: ${JSON.stringify(posted)}`);
  }
  await tab.close();
}

for (const kind of ["game", "half", "bye", "zero"]) {
  const state = deskState([{ posted: false, out: ["33333333"],
    games: [{ board: 1, white: "11111111", black: kind === "game" ? "33333333" : "22222222", result: "", section: "" }],
    byes: [{ id: kind === "game" ? "22222222" : "33333333", kind: kind === "game" ? "unplayed" : kind,
      points: kind === "half" ? 0.5 : kind === "bye" ? 1 : 0, section: "" },
    { id: "44444444", kind: "unplayed", points: 0, section: "" }],
  }]);
  state.held.players[2].out = 1;
  const tab = await mocked("/td/ validating a genuinely withdrawn player", state.answer);
  await signIn(tab);
  await tab.waitForSelector(".run-pairings:not([hidden])");
  const problems = await tab.$$eval(".run-problems li", (items) => items.map((li) => li.textContent));
  problems.some((p) => p.startsWith("Cal (1500) is withdrawn"))
    ? pass(`An actual withdrawal still prevents a ${kind} placement`)
    : fail(`An actual withdrawal incorrectly allowed a ${kind} placement`);
  await tab.close();
}

await done();
