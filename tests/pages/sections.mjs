// Pairings and Standings with sections, the desk's payments and donations, and players reporting results.
import { PHONE, axeBoth, axeSource, base, done, fail, fitsPhone, fourPlayers, mocked, pass, press, signIn, twoSections } from "./common.mjs";

// The Pairings page: each section in its own table, with a round menu that starts at the latest round.
// On a night's list, the desk switches a paid whole month to just the night, refunds what's left over, and
// gives a discount, each with the entry's token.
const moneyCalls = [];
const monthEntry = { name: "Month Player", id: "22345678", rating: "1400", for: "Whole month", category: "Adult", amount: "17", paid: "17",
  paidBy: "cash", due: "0", card: "", email: "", expires: "2027-01-31", token: "month1", date: "2026-10", refundable: "17", over: "",
  refunded: "", discount: "", credit: "" };
let moneyEntry = monthEntry;
const moneyDesk = await mocked("/td/ switching, refunding, and discounting", (p) => {
  if (!["login", "choices", "people", "contacts", "entries", "ledger", "incidents", "tournament", "changes"].includes(p.action)) moneyCalls.push(p);
  if (p.action === "toNight") {
    moneyEntry = { ...moneyEntry, for: "Monday, October 12", amount: "7.50", paid: "", paidBy: "", token: "night1", date: "2026-10-12",
      credit: "17", over: "9.50" };
  }
  return { login: { ok: true, changes: null },
    choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" },
      { key: "club-night/2026-10-12", name: "Club Night", label: "Monday, October 12, 2026", kind: "night", first: "2026-10-12" },
      { key: "club-night/2026-10-19", name: "Club Night", label: "Monday, October 19, 2026", kind: "night", first: "2026-10-19" }] },
    people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: [moneyEntry] },
    ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
    incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true, message: `${p.action} done` };
});
moneyDesk.on("dialog", (d) => d.accept(d.type() !== "prompt" ? undefined : /Reason/.test(d.message()) ? "Hardship" : /Discount/.test(d.message()) ? "5" : d.defaultValue()));
await moneyDesk.goto(base + "/td/", { waitUntil: "domcontentloaded" });
await moneyDesk.type("#td-password", "secret");
await moneyDesk.click(".td-login button");
await moneyDesk.waitForSelector(".td-entries tbody tr");
const moneyButtons = () => moneyDesk.$$eval(".td-entries tbody tr button", (b) => b.map((x) => x.firstChild.textContent));
const moneyMonthButtons = await moneyButtons();
const moneyNights = await moneyDesk.$$eval(".td-entries tbody tr select[aria-label^=Night] option", (o) => o.map((x) => x.textContent));
await moneyDesk.select(".td-entries select[aria-label^=Night]", "2026-10-19");
await moneyDesk.$$eval(".td-entries tbody tr button", (b) => b.find((x) => x.firstChild.textContent === "One night only").click());
await moneyDesk.waitForFunction(() => document.querySelector(".td-register-status").textContent.endsWith("done"));
await moneyDesk.$eval(".td-register-status", (s) => { s.textContent = ""; });
moneyEntry = monthEntry;
await moneyDesk.select("#td-event", "club-night/2026-10-12");
await moneyDesk.waitForFunction(() => [...document.querySelectorAll(".td-entries button")].some((b) => b.textContent.startsWith("This night only")));
const moneyClick = async (text) => {
  await moneyDesk.$$eval(".td-entries tbody tr button", (b, t) => b.find((x) => x.firstChild.textContent === t).click(), text);
  await moneyDesk.waitForFunction((n) => document.querySelector(".td-register-status").textContent.endsWith("done"), {}, text);
  await moneyDesk.$eval(".td-register-status", (s) => { s.textContent = ""; });
};
await moneyClick("This night only");
await moneyDesk.waitForFunction(() => [...document.querySelectorAll(".td-entries button")].some((b) => b.textContent.startsWith("Refund $9.50")));
const moneyNightDue = await moneyDesk.$eval(".td-entries tbody tr", (r) => r.cells[6].firstChild.textContent);
await moneyClick("Refund $9.50");
await moneyClick("Discount");
const moneyAsked = moneyCalls.map(({ action, token, event, date, amount, by, note }) => ({ action, token, event, date, amount, by, note }));
JSON.stringify(moneyMonthButtons) === JSON.stringify(["One night only", "Discount", "$17 cash ✓", "Refund", "Incident", "Remove"])
  && JSON.stringify(moneyNights) === JSON.stringify(["October 12", "October 19"]) && moneyNightDue === "$0 after $17 credit" && JSON.stringify(moneyAsked) === JSON.stringify([
    { action: "toNight", token: "month1", event: "club-night", date: "2026-10-19" },
    { action: "toNight", token: "month1", event: "club-night", date: "2026-10-12" },
    { action: "refund", token: "night1", amount: "9.50", by: "cash" },
    { action: "discount", token: "night1", amount: "5", note: "Hardship" }])
  ? pass("TD desk switches a whole month to a night picked on the month's list or to the night shown, refunds what's over, and gives a discount with its reason")
  : fail(`TD desk money: ${JSON.stringify({ moneyMonthButtons, moneyNights, moneyNightDue, moneyAsked })}`);
await moneyDesk.evaluate(axeSource);
const moneyAxe = await moneyDesk.evaluate(() => axe.run({ include: [".td-entries"] }));
moneyAxe.violations.length ? fail(`TD desk money buttons: ${moneyAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("TD desk money buttons have no axe violations");
await moneyDesk.close();

// Paying over the fee: the desk asks whether the rest is a donation, then shows it on the row and in the money.
let giftEntry = { name: "Gift Player", id: "32345678", rating: "1500", for: "Monday, October 12", category: "Adult", amount: "17", paid: "",
  paidBy: "", due: "17", card: "17.80", email: "", expires: "2027-01-31", token: "gift1", date: "2026-10-12", refundable: "", over: "",
  refunded: "", discount: "", credit: "", donation: "" };
let giftLedger = { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", donation: "0", games: null, uschess: "0" };
const giftCalls = [];
const giftAsked = [];
const giftDesk = await mocked("/td/ donation", (p) => {
  if (p.action === "paid") {
    giftCalls.push({ amount: p.amount, by: p.by, donate: p.donate });
    giftEntry = { ...giftEntry, paid: "22", paidBy: "cash", donation: "5", refundable: "17" };
    giftLedger = { ...giftLedger, received: { ...giftLedger.received, cash: "22" }, entry: "15", rating: "2", donation: "5" };
  }
  return { login: { ok: true, changes: null },
    choices: { choices: [{ key: "club-night/2026-10-12", name: "Club Night", label: "Monday, October 12, 2026", kind: "night", first: "2026-10-12" }] },
    people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: [giftEntry] }, ledger: { ledger: giftLedger },
    incidents: { incidents: [] }, tournament: { tournament: null }, paid: { ok: true, message: "paid done" } }[p.action] || { ok: true };
});
giftDesk.on("dialog", (d) => { giftAsked.push(d.message()); d.accept(d.type() === "prompt" ? "22" : undefined); });
await giftDesk.goto(base + "/td/", { waitUntil: "domcontentloaded" });
await giftDesk.type("#td-password", "secret");
await giftDesk.click(".td-login button");
await giftDesk.waitForSelector(".td-entries tbody tr");
await giftDesk.$$eval(".td-entries tbody tr button", (b) => b.find((x) => x.firstChild.textContent === "Mark paid").click());
await giftDesk.waitForFunction(() => document.querySelector(".td-entries tbody tr td:nth-child(9)").textContent.includes("donation"));
await giftDesk.waitForFunction(() => document.querySelector(".td-ledger").textContent.includes("Donations"));
const giftPaid = await giftDesk.$eval(".td-entries tbody tr td:nth-child(9)", (c) => c.textContent);
const giftMoney = await giftDesk.$eval(".td-ledger", (l) => l.lastElementChild.textContent);
JSON.stringify(giftCalls) === JSON.stringify([{ amount: "22", by: "cash", donate: "1" }]) && /\$5 more than the \$17 due/.test(giftAsked[1])
  && giftPaid.includes("mark unpaid + $5 donation") && giftMoney === "Donations to the club: $5."
  ? pass("TD desk records what's paid over the fee as the player's donation and shows it on the row and in the money")
  : fail(`TD desk donation: ${JSON.stringify({ giftCalls, giftAsked, giftPaid, giftMoney })}`);
await giftDesk.close();

// Paying part of the fee: the row shows what's still due and takes another payment, which can be by another method.
let partEntry = { name: "Part Player", id: "42345678", rating: "1500", for: "Monday, October 12", category: "Adult", amount: "17", paid: "",
  paidBy: "", due: "17", balance: "17", card: "17.93", email: "", expires: "2027-01-31", token: "part1", date: "2026-10-12", refundable: "",
  over: "", refunded: "", discount: "", credit: "", donation: "" };
const partCalls = [];
const partAsked = [];
const partDesk = await mocked("/td/ part payments", (p) => {
  if (p.action === "paid") {
    partCalls.push({ amount: p.amount, by: p.by, donate: p.donate });
    partEntry = partCalls.length === 1 ? { ...partEntry, paid: "10", paidBy: "cash", balance: "7", card: "7.68", refundable: "10" }
      : { ...partEntry, paid: "17.68", paidBy: "cash, card", balance: "0", card: "", refundable: "17" };
  }
  return { login: { ok: true, changes: null },
    choices: { choices: [{ key: "club-night/2026-10-12", name: "Club Night", label: "Monday, October 12, 2026", kind: "night", first: "2026-10-12" }] },
    people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: [partEntry] },
    ledger: { ledger: giftLedger }, incidents: { incidents: [] }, tournament: { tournament: null }, paid: { ok: true, message: "paid done" } }[p.action]
    || { ok: true };
});
partDesk.on("dialog", (d) => { partAsked.push(d.message()); d.accept(partCalls.length ? d.defaultValue() : "10"); });
await partDesk.goto(base + "/td/", { waitUntil: "domcontentloaded" });
await partDesk.type("#td-password", "secret");
await partDesk.click(".td-login button");
await partDesk.waitForSelector(".td-entries tbody tr");
const partClick = (label) => partDesk.$$eval(".td-entries tbody tr button", (b, label) => b.find((x) => x.firstChild.textContent === label).click(), label);
await partClick("Mark paid");
await partDesk.waitForFunction(() => [...document.querySelectorAll(".td-entries button")].some((b) => b.firstChild.textContent === "Add payment"));
const partShort = await partDesk.$eval(".td-entries tbody tr td:nth-child(9)", (c) => c.textContent);
const partOwed = await partDesk.$eval(".td-entries-status", (s) => s.textContent);
await partDesk.select(".td-entries .td-method", "card");
await partClick("Add payment");
await partDesk.waitForFunction(() => document.querySelector(".td-entries tbody tr td:nth-child(9)").textContent.includes("cash, card"));
const partDone = await partDesk.$$eval(".td-entries tbody tr td:nth-child(9) :is(button, select)", (b) => b.map((x) => x.firstChild?.textContent ?? ""));
JSON.stringify(partCalls) === JSON.stringify([{ amount: "10", by: "cash", donate: "" }, { amount: "7.68", by: "card", donate: "" }])
  && partShort.startsWith("$10 cash ✓ paid by Part Player; mark unpaid $7 due") && partOwed.includes("Still owed: $7.")
  && partAsked[1] === "Amount Part Player paid by card" && partDone.length === 2 && partDone[0] === "$17.68 cash, card ✓"
  ? pass("TD desk takes part of the fee, shows what's still due, and collects the rest with another payment")
  : fail(`TD desk part payment: ${JSON.stringify({ partCalls, partShort, partOwed, partAsked, partDone })}`);
await partDesk.close();

// Byes asked for in advance: the register form has a box, and each entry a menu (plays, ½, or 0), for every round
// of a one-day Swiss, or every night of a month to come. An entry's menu saves as soon as it changes, with the
// entry's token, and goes back if the script refuses.
const deskByeCalls = [];
let deskByeAnswer = { ok: true, message: "Ann Example's byes are saved." };
const deskByeEntries = {
  "classic/2026-11-07": [{ name: "Ann Example", id: "12345678", rating: "1500", for: "Saturday, November 7", category: "Adult", amount: "15",
    due: "15", card: "15.75", email: "", expires: "2027-01-31", token: "ann1", date: "2026-11-07", byes: ["3"] }],
  "club-night/2026-10": [{ name: "Month Player", id: "22345678", rating: "1400", for: "Whole month", category: "Adult", amount: "17",
    due: "17", card: "17.80", email: "", expires: "2027-01-31", token: "month1", date: "2026-10", byes: ["2026-10-19"] }],
};
const deskByePage = await mocked("/td/ with byes asked for", (p) => {
  if (p.action === "register" || p.action === "byes") deskByeCalls.push(p);
  return { login: { ok: true, changes: null },
    choices: { choices: [
      { key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry", first: "2026-11-07", format: "swiss", rounds: "4" },
      { key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12", format: "", rounds: "" },
      { key: "club-night/2026-10-19", name: "Club Night", label: "Monday, October 19, 2026", kind: "night", first: "2026-10-19", format: "", rounds: "" },
      { key: "club-night/2026-10-26", name: "Club Night", label: "Monday, October 26, 2026", kind: "night", first: "2026-10-26", format: "", rounds: "" }] },
    people: { players: [{ id: "12345678", name: "Ann Example", state: "", rating: "1500", expires: "2027-01-31", known: true }] },
    contacts: { headings: ["Name"], contacts: [] }, entries: { entries: deskByeEntries[`${p.event}/${p.date}`] || [] },
    ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
    incidents: { incidents: [] }, tournament: { tournament: null }, byes: deskByeAnswer,
    register: { ok: true, message: "Ann Example is registered." } }[p.action] || { ok: true };
});
await signIn(deskByePage);
await deskByePage.waitForSelector('.td-entries select[aria-label="Round 3 bye for Ann Example"]');
const deskByeBoxes = () => deskByePage.evaluate(() => ({ head: document.querySelector(".td-entries th:nth-child(5)").textContent,
  boxes: [...document.querySelectorAll(".td-entries tbody td:nth-child(5) select")].map((b) => `${b.getAttribute("aria-label")}: ${b.selectedOptions[0].textContent}`),
  offered: [...document.querySelectorAll(".td-byes:not([hidden]) label")].map((l) => l.textContent.trim()) }));
const deskByesShown = await deskByeBoxes();
const deskByeSaved = (text) => deskByePage.waitForFunction((t) => document.querySelector(".td-register-status").textContent.startsWith(t)
  && !document.querySelector(".td-entries select:disabled"), {}, text);
await deskByePage.select('.td-entries select[aria-label="Round 4 bye for Ann Example"]', "zero");
await deskByeSaved("Ann Example's byes are saved.");
deskByeAnswer = { error: "Round 1 is paired already." };
await deskByePage.select('.td-entries select[aria-label="Round 1 bye for Ann Example"]', "half");
await deskByeSaved("Round 1 is paired already.");
const deskByeRefusal = await deskByePage.$eval(".td-refused", (d) => d.open && d.querySelector(".td-refused-message").textContent);
await deskByePage.click(".td-refused button");
const deskByeRefusalClosed = await deskByePage.$eval(".td-refused", (d) => !d.open);
const deskByesRefused = await deskByeBoxes();
const deskByeSaves = deskByeCalls.filter((c) => c.action === "byes").map(({ token, byes, zeroByes }) => ({ token, byes, zeroByes }));
deskByesShown.head === "Byes" && JSON.stringify(deskByesShown.boxes) === JSON.stringify(["Round 1 bye for Ann Example: –", "Round 2 bye for Ann Example: –",
  "Round 3 bye for Ann Example: ½", "Round 4 bye for Ann Example: –"])
  && JSON.stringify(deskByeSaves) === JSON.stringify([{ token: "ann1", byes: "3", zeroByes: "4" }, { token: "ann1", byes: "1, 3", zeroByes: "4" }])
  && JSON.stringify(deskByesRefused.boxes) === JSON.stringify(["Round 1 bye for Ann Example: –", "Round 2 bye for Ann Example: –",
    "Round 3 bye for Ann Example: ½", "Round 4 bye for Ann Example: 0"])
  ? pass("TD desk shows an entry's byes, saves a change at once with the entry's token, and puts the box back when the script refuses")
  : fail(`TD desk entry byes: ${JSON.stringify({ deskByesShown, deskByeSaves, deskByesRefused })}`);
deskByeRefusal === "Round 1 is paired already." && deskByeRefusalClosed
  ? pass("TD desk pops up why the script refused a change, and OK closes it")
  : fail(`TD desk refusal popup: ${JSON.stringify({ deskByeRefusal, deskByeRefusalClosed })}`);
await deskByePage.type("#td-player", "ann");
await deskByePage.waitForSelector("#td-players:not([hidden]) [role=option]");
await deskByePage.keyboard.press("ArrowDown");
await deskByePage.keyboard.press("Enter");
await deskByePage.click('.td-byes input[value="2"]');
await deskByePage.click('.td-byes input[value="4"]');
await deskByePage.click(".td-register button[type=submit]");
await deskByePage.waitForSelector(".td-saving .td-save-done");
const deskByesCleared = await deskByePage.$$eval(".td-byes input:checked", (b) => b.length);
const deskByeRegistered = deskByeCalls.find((c) => c.action === "register") || {};
JSON.stringify(deskByesShown.offered) === JSON.stringify(["Round 1", "Round 2", "Round 3", "Round 4"])
  && deskByeRegistered.id === "12345678" && deskByeRegistered.byes === "2, 4" && deskByesCleared === 0
  ? pass("TD desk's register form offers each round of a one-day Swiss, sends the byes checked, and clears them for the next player")
  : fail(`TD desk register byes: ${JSON.stringify({ offered: deskByesShown.offered, deskByeRegistered, deskByesCleared })}`);
await deskByePage.select("#td-event", "club-night/2026-10");
await deskByePage.waitForSelector('.td-entries select[aria-label="October 19 bye for Month Player"]');
const deskByesMonth = await deskByeBoxes();
JSON.stringify(deskByesMonth.offered) === JSON.stringify(["October 19", "October 26"])
  && JSON.stringify(deskByesMonth.boxes) === JSON.stringify(["October 19 bye for Month Player: ½", "October 26 bye for Month Player: –"])
  ? pass("TD desk offers a month's nights to come by date, on the register form and on a whole-month entry")
  : fail(`TD desk month byes: ${JSON.stringify(deskByesMonth)}`);
await axeBoth(deskByePage, "TD desk with byes asked for");
await deskByePage.setViewport(PHONE);
await fitsPhone(deskByePage, "TD desk with byes asked for");
await deskByePage.close();

// A donation apart from any entry: from a contact, on their row, or anonymous, by the Contacts tools.
let giveBook = { headings: ["Name", "US Chess ID"], contacts: [{ id: "c1", Name: "Cora Contact", "US Chess ID": "12345678", donated: "5" }], anonymous: "" };
const giveCalls = [];
const giveDesk = await mocked("/td/ donations from contacts", (p) => {
  if (p.action === "donation") {
    giveCalls.push({ contact: p.contact, amount: p.amount, by: p.by, note: p.note });
    giveBook = p.contact ? { ...giveBook, contacts: [{ ...giveBook.contacts[0], donated: "25" }] } : { ...giveBook, anonymous: "40" };
    return { ok: true, message: "donation done" };
  }
  return { login: { ok: true, changes: null }, choices: { choices: [] }, people: { players: [] }, contacts: giveBook,
    entries: { entries: [] }, incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true };
});
const giveAnswers = [];
giveDesk.on("dialog", (d) => d.accept(giveAnswers.shift()));
await giveDesk.goto(base + "/td/", { waitUntil: "domcontentloaded" });
await giveDesk.type("#td-password", "secret");
await giveDesk.click(".td-login button");
await giveDesk.waitForSelector(".td-contacts tbody tr");
await giveDesk.click(".td-contacts-panel summary");
const giveBefore = await giveDesk.$eval(".td-contacts tbody tr", (r) => r.cells[6].textContent);
giveAnswers.push("20", "Check", "Check 101");
await giveDesk.$$eval(".td-contacts tbody tr button", (b) => b.find((x) => x.firstChild.textContent === "Donation").click());
await giveDesk.waitForFunction(() => document.querySelector(".td-contacts tbody tr").cells[6].textContent === "$25");
giveAnswers.push("40", "cash", "");
await giveDesk.click(".td-contacts-give");
await giveDesk.waitForFunction(() => document.querySelector(".td-contacts-anonymous").textContent === "Anonymous donations so far: $40.");
JSON.stringify(giveCalls) === JSON.stringify([{ contact: "c1", amount: "20", by: "check", note: "Check 101" }, { contact: "", amount: "40", by: "cash", note: "" }])
  && giveBefore === "$5"
  ? pass("TD desk records a donation from a contact or an anonymous one, and shows each contact's total and the anonymous one")
  : fail(`TD desk contact donations: ${JSON.stringify({ giveCalls, giveBefore })}`);
await giveDesk.close();

const pairingsPage = await mocked("/pairings/", () => ({ tournaments: twoSections() }));
await pairingsPage.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const sectionTables = () => pairingsPage.evaluate(() => [...document.querySelectorAll(".pairings-all h3")].map((h) => {
  const menu = h.nextElementSibling;
  const shown = menu.nextElementSibling;
  return { name: h.textContent, round: menu.querySelector("select").value, label: menu.querySelector("label").textContent,
    rows: [...shown.querySelectorAll("tbody tr")].map((r) => [...r.cells].map((c) => c.textContent)),
    byes: shown.querySelector("p")?.textContent || "" };
}));
const latest = await sectionTables();
JSON.stringify(latest.map((s) => [s.name, s.round, s.rows.length])) === JSON.stringify([["Open", "2", 2], ["Under 1400", "2", 1]])
  && latest[0].rows[0].join("|") === "1|Ben (1800)|Ann (2000)|½–½" && latest[1].byes === "Without a game: Fay (1200), full-point bye."
  && latest[0].label === "Round, Open"
  ? pass("Pairings page shows each section's latest round in its own table") : fail(`Pairings page sections: ${JSON.stringify(latest)}`);
await pairingsPage.select(".pairings-all select", "1");
const earlier = await sectionTables();
earlier[0].round === "1" && earlier[0].rows[0].join("|") === "1|Ann (2000)|Cal (1600)|1–0" && earlier[1].round === "2"
  ? pass("Pairings page's round menu shows an earlier round of one section") : fail(`Pairings page round menu: ${JSON.stringify(earlier)}`);
await axeBoth(pairingsPage, "Pairings page with two sections");
await pairingsPage.setViewport(PHONE);
await fitsPhone(pairingsPage, "Pairings page with two sections");
await pairingsPage.close();

// The Standings page: each section's standings, after the latest round with results unless another is chosen.
const standingsPage = await mocked("/standings/", () => ({ tournaments: twoSections() }));
await standingsPage.goto(base + "/standings/", { waitUntil: "networkidle0" });
const standingsTables = () => standingsPage.evaluate(() => [...document.querySelectorAll(".standings-all h3")].map((h) => {
  const menu = h.nextElementSibling;
  return { name: h.textContent, after: menu.querySelector("select").value,
    options: [...menu.querySelectorAll("option")].map((o) => o.textContent),
    head: [...menu.nextElementSibling.querySelectorAll("th")].map((c) => c.textContent),
    note: menu.nextElementSibling.querySelector(".td-table + .table-note")?.textContent.slice(0, 22) || "",
    rows: [...menu.nextElementSibling.querySelectorAll("tbody tr")].map((r) => [...r.cells].map((c) => c.textContent)) };
}));
const now = await standingsTables();
JSON.stringify(now.map((s) => [s.name, s.after, s.options, s.rows.length])) === JSON.stringify([
  ["Open", "2", ["1", "2 (in progress)"], 4], ["Under 1400", "1", ["1"], 3]])
  && now[0].head.join("|") === "Place|Name|Rating|Score|Round 1|Round 2|Median|Solkoff|Cumulative|Opp. cumulative|Performance|Est. rating ?"
  && now[0].rows.slice(0, 2).every((r) => r[3] === "1.5")
  // Ann and Ben, Cal and Dee, and Eve and Fay tie on every 34E tiebreak, so each pair shares a place.
  && now.map((s) => s.rows.map((r) => r[0]).join()).join("|") === "1,1,3,3|1,2,2"
  && now.every((s) => s.note === "")
  // Each round: the result, the opponent's row, and the color; Cal and Dee's game has no result yet.
  && now[0].rows.map((r) => `${r[1]} ${r[4]}, ${r[5]}`).join("|") === "Ann W3 w, D2 b|Ben W4 b, D1 w|Cal L1 b, 4 w|Dee L2 w, 3 b"
  && now[1].rows.map((r) => `${r[1]} ${r[4]}`).join("|") === "Gus B|Eve D3 w|Fay D2 b"
  && now.flatMap((s) => s.rows.map((r) => `${r[1]} ${r[s.head.indexOf("Performance")]} ${r[s.head.indexOf("Est. rating ?")]}`)).join("|")
    === "Ann 1891 1996|Ben 1941 1813|Cal 1200 1596|Dee 1000 1494|Gus  |Eve 1200 1293|Fay 1300 1207"
  ? pass("Standings page shows each section after its latest round with results: rounds, the 34E tiebreaks, performance, and estimated ratings")
  : fail(`Standings page: ${JSON.stringify(now)}`);
// Est. rating's ? shows its explanation over the table on hover, keeps it while the pointer moves onto it, and Escape hides it.
const tipShown = () => standingsPage.evaluate(() => {
  const tip = document.getElementById("estimate-tip");
  const at = tip.getBoundingClientRect();
  return { open: tip.matches(":popover-open"), text: tip.textContent.slice(0, 21), inside: at.left >= 0 && at.right <= innerWidth,
    expanded: document.querySelector(".standings-all th .hint-button").getAttribute("aria-expanded") };
});
await standingsPage.hover(".standings-all th .hint-button");
const tipHover = await tipShown();
await standingsPage.hover("#estimate-tip");
await new Promise((resolve) => setTimeout(resolve, 400));
const tipKept = await tipShown();
await standingsPage.keyboard.press("Escape");
const tipGone = await tipShown();
tipHover.open && tipHover.inside && tipHover.text === "Est. rating estimates" && tipHover.expanded === "true" && tipKept.open
  && !tipGone.open && tipGone.expanded === "false"
  ? pass("Standings page's Est. rating ? shows its explanation over the table, keeps it under the pointer, and hides it on Escape")
  : fail(`Standings page Est. rating hint: ${JSON.stringify({ tipHover, tipKept, tipGone })}`);
await standingsPage.mouse.move(0, 0);
await standingsPage.select(".standings-all select", "1");
const afterOne = await standingsTables();
afterOne[0].after === "1" && afterOne[0].rows[0][1] === "Ann" && afterOne[0].rows[0][3] === "1"
  ? pass("Standings page's menu shows the standings after an earlier round") : fail(`Standings page after round 1: ${JSON.stringify(afterOne)}`);
await axeBoth(standingsPage, "Standings page with two sections");
await standingsPage.setViewport(PHONE);
await fitsPhone(standingsPage, "Standings page with two sections");
await standingsPage.close();

// Byes asked for in rounds not yet posted are posted with each section (22C4), above the round menu on Pairings and
// below the table on Standings: by round, or in a month by night, zero-point byes named. A round already posted has them
// under Without a game.
const withByesAsked = (extra) => twoSections().map((t) => ({ ...t, plannedRounds: 4, ...extra,
  players: t.players.map((p) => ({ ...p, ...{ a: { byes: [3, 4] }, f: { byes: [2, 3], zeroByes: [4] } }[p.id] })) }));
let askedTournaments = withByesAsked({});
const askedLines = (tab) => tab.$$eval("main p", (ps) => ps.filter((p) => p.textContent.startsWith("Byes asked for")).map((p) => ({
  text: p.textContent, before: p.previousElementSibling.className || p.previousElementSibling.tagName, after: p.nextElementSibling?.className || "" })));
const askedPairings = await mocked("/pairings/ with byes asked for", () => ({ tournaments: askedTournaments }));
await askedPairings.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const byRound = await askedLines(askedPairings);
askedTournaments = withByesAsked({ roundDates: ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"] });
await askedPairings.reload({ waitUntil: "networkidle0" });
const byNight = await askedLines(askedPairings);
await askedPairings.close();
const askedStandings = await mocked("/standings/ with byes asked for", () => ({ tournaments: askedTournaments }));
await askedStandings.goto(base + "/standings/", { waitUntil: "networkidle0" });
const belowTable = await askedLines(askedStandings);
askedTournaments = withByesAsked({ status: "rated" });
await askedStandings.reload({ waitUntil: "networkidle0" });
const onceRated = await askedLines(askedStandings);
await askedStandings.close();
JSON.stringify(byRound) === JSON.stringify([{ text: "Byes asked for: Ann (2000), rounds 3 and 4.", before: "H3", after: "round-menu" },
  { text: "Byes asked for: Fay (1200), round 3 and round 4 (zero-point).", before: "H3", after: "round-menu" }])
  && JSON.stringify(byNight.map((l) => l.text)) === JSON.stringify(["Byes asked for: Ann (2000), October 19 and 26.",
    "Byes asked for: Fay (1200), October 19 and October 26 (zero-point)."])
  && JSON.stringify(belowTable.map((l) => [l.text, l.before])) === JSON.stringify([["Byes asked for: Ann (2000), October 19 and 26.", "round-shown"],
    ["Byes asked for: Fay (1200), October 19 and October 26 (zero-point).", "round-shown"]]) && !onceRated.length
  ? pass("Pairings and Standings pages post the byes asked for in rounds not yet posted, by round or by night, until the tournament is rated")
  : fail(`Byes asked for: ${JSON.stringify({ byRound, byNight, belowTable, onceRated })}`);

// A quad on the Standings page: Sonneborn-Berger and head-to-head.
const quadStandingsPage = await mocked("/standings/ with quads", () => {
  const players = [["a", "Ann", 1900], ["b", "Ben", 1800], ["c", "Cal", 1700], ["d", "Dee", 1600]]
    .map(([id, name, rating], i) => ({ id, number: i + 1, name, rating, section: "Quad 1", out: null }));
  const rounds = [{ games: [{ board: 1, white: "a", black: "d", result: "1-0", section: "Quad 1" }, { board: 2, white: "b", black: "c", result: "1-0", section: "Quad 1" }], byes: [], out: [], posted: true }];
  return { tournaments: [{ name: "Alley Cat Quad, Saturday, October 10, 2026", format: "quad", plannedRounds: 3, status: "running",
    sections: [{ name: "Quad 1" }], players, rounds }] };
});
await quadStandingsPage.goto(base + "/standings/", { waitUntil: "networkidle0" });
const quadHead = await quadStandingsPage.$$eval(".standings-all th", (cells) => cells.map((c) => c.textContent));
quadHead.join("|") === "Place|Name|Rating|Score|Round 1|Sonneborn-Berger|Head-to-head|Performance|Est. rating ?"
  ? pass("Standings page ranks a quad by score, Sonneborn-Berger, and head-to-head (34F)") : fail(`Standings page quad: ${JSON.stringify(quadHead)}`);
await quadStandingsPage.close();

// Starting a Swiss in two sections on the TD desk, on a phone: the TD adds a section, moves a
// player up, pairs round one in each section, posts it, and enters a result.
let sectioned = null;
const sectionCalls = [];
const sectionDesk = await mocked("/td/ running a Swiss in two sections", (p) => {
  sectionCalls.push(p);
  if (p.action === "choices") return { choices: [{ key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry", first: "2026-11-07" }] };
  if (p.action === "entries") return { entries: [] };
  if (p.action === "incidents") return { incidents: [] };
  if (p.action === "tournament") return { tournament: sectioned };
  if (p.action === "start") {
    const sections = JSON.parse(p.sections);
    const players = [["11111111", "Ann", 1900], ["22222222", "Ben", 1700], ["33333333", "Cal", 1500], ["44444444", "Dee", 1450],
      ["55555555", "Eve", 1300], ["66666666", "Fay", 1200], ["77777777", "Gus", null]]
      .map(([id, name, rating], i) => ({ id, number: i + 1, name, rating, out: null,
        section: rating != null && rating >= 1400 ? "Open" : "Under 1400" }));
    sectioned = { key: "classic/2026-11-07", name: "Classic", format: "swiss", plannedRounds: Number(p.rounds), status: "running",
      coin: p.coin, sections, players, rounds: [], halfByes: { limit: 1, everyRound: true } };
    return { ok: true, message: "Added 7 player(s)." };
  }
  if (p.action === "section") {
    sectioned.players.find((x) => x.id === p.id).section = p.section;
    for (const b of sectioned.rounds.flatMap((r) => r.byes).filter((b) => b.id === p.id)) b.section = p.section;
    return { ok: true, message: "Moved." };
  }
  if (p.action === "sectionNames") {
    const list = JSON.parse(p.sections);
    const renamed = Object.fromEntries(list.map((x) => [x.from, x.name]));
    sectioned.sections = list.map((x) => ({ ...sectioned.sections.find((d) => d.name === x.from), name: x.name }));
    for (const x of [...sectioned.players, ...sectioned.rounds.flatMap((r) => [...r.games, ...r.byes])]) x.section = renamed[x.section] ?? x.section;
    return { ok: true, message: `Sections: ${list.map((x) => x.name).join(", ")}.` };
  }
  if (p.action === "sync") {
    sectioned.players.push({ id: "88888888", number: 8, name: "Hal", rating: 1100, out: null, section: "Under 1400" });
    sectioned.rounds[0].byes.push({ id: "88888888", points: 0.5, kind: "half", section: "Under 1400" });
    return { ok: true, message: "Added 1 player(s)." };
  }
  if (p.action === "round") {
    sectioned.rounds = [{ games: JSON.parse(p.games).map((g) => ({ ...g, result: "" })), byes: JSON.parse(p.byes), out: [], posted: p.post === "yes" }];
    return { ok: true, message: "Round 1 is posted." };
  }
  if (p.action === "result") {
    sectioned.rounds[0].games.find((g) => g.board === Number(p.board) && g.section === p.section).result = p.result;
  }
  return { ok: true };
}, PHONE);
await sectionDesk.goto(base + "/td/", { waitUntil: "networkidle0" });
await sectionDesk.type("#td-password", "secret");
await sectionDesk.click(".td-login button");
await sectionDesk.waitForSelector(".run-start:not([hidden])");
await sectionDesk.type("#run-rounds", "3");
await press(sectionDesk, ".run-start .run-section-add");
await sectionDesk.type(".run-start .run-section-row:last-child .run-section-name", "Under 1400");
await sectionDesk.type(".run-start .run-section-row:last-child .run-section-under", "1400");
await fitsPhone(sectionDesk, "TD desk's start form with two sections");
await press(sectionDesk, ".run-start button[type=submit]");
await sectionDesk.waitForFunction(() => document.querySelectorAll(".run-attendance").length === 2);
const started = sectionCalls.find((c) => c.action === "start") || {};
const checkin = await sectionDesk.evaluate(() => ({
  headings: [...document.querySelectorAll(".run-attendance-all h4")].map((h) => h.textContent),
  // Dee, 1450, can't play down; Fay, 1200, can play up.
  dee: [...document.querySelector('select[aria-label="Dee\'s section"]').options].map((o) => o.value),
  fay: [...document.querySelector('select[aria-label="Fay\'s section"]').options].map((o) => o.value) }));
started.td === "31847334" && started.sections === JSON.stringify([{ name: "Open" }, { name: "Under 1400", under: 1400 }])
  && JSON.stringify(checkin) === JSON.stringify({ headings: ["Open (4)", "Under 1400 (3)"], dee: ["Open"], fay: ["Open", "Under 1400"] })
  ? pass("TD desk starts a Swiss in two sections and checks in each section, offering only sections a player may enter")
  : fail(`TD desk sections at start: ${JSON.stringify({ started, checkin })}`);
await sectionDesk.select('select[aria-label="Fay\'s section"]', "Open");
await sectionDesk.waitForFunction(() => document.querySelector(".run-attendance-all h4")?.textContent === "Open (5)");
const moved = sectionCalls.find((c) => c.action === "section") || {};
moved.id === "66666666" && moved.section === "Open" ? pass("TD desk moves a player up a section before round 1")
  : fail(`TD desk section move: ${JSON.stringify(moved)}`);
await axeBoth(sectionDesk, "TD desk checking in two sections");
await fitsPhone(sectionDesk, "TD desk checking in two sections");
await press(sectionDesk, ".run-pair");
await sectionDesk.waitForSelector(".run-pairings:not([hidden])");
const review = await sectionDesk.$$eval(".run-games-all h4", (h) => h.map((x) => x.textContent));
await press(sectionDesk, ".run-post");
await sectionDesk.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const firstRound = sectionCalls.find((c) => c.action === "round") || {};
const sectionGames = JSON.parse(firstRound.games || "[]").map((g) => [g.section, g.board, g.white, g.black]);
const sectionByes = JSON.parse(firstRound.byes || "[]");
// Open: Ann, Ben, Cal, Dee, and Fay playing up, the lowest rated, with the bye (28L2); Under 1400: Eve and Gus.
JSON.stringify(review) === JSON.stringify(["Open", "Under 1400"])
  && JSON.stringify(sectionGames) === JSON.stringify([["Open", 1, "11111111", "33333333"], ["Open", 2, "44444444", "22222222"],
    ["Under 1400", 1, "55555555", "77777777"]])
  && JSON.stringify(sectionByes) === JSON.stringify([{ id: "66666666", points: 1, kind: "bye", section: "Open" }])
  ? pass("TD desk pairs round one in each section on its own, boards numbered within each")
  : fail(`TD desk two-section round one: ${JSON.stringify({ review, sectionGames, sectionByes })}`);
await sectionDesk.select('select[aria-label="Under 1400 board 1 result"]', "1-0");
await sectionDesk.waitForFunction(() => document.querySelectorAll(".run-standings").length === 2);
const resulted = sectionCalls.find((c) => c.action === "result") || {};
resulted.section === "Under 1400" && resulted.board === "1" && resulted.result === "1-0"
  ? pass("TD desk enters a result by section and board, with each section's standings") : fail(`TD desk result: ${JSON.stringify(resulted)}`);
const deskPerformance = await sectionDesk.$$eval(".run-standings", (tables) => tables.map((t) => {
  const at = [...t.tHead.rows[0].cells].findIndex((c) => c.textContent === "Performance");
  return [t.tHead.rows[0].cells[at]?.textContent, ...[...t.tBodies[0].rows].map((r) => `${r.cells[1].textContent} ${r.cells[at].textContent}`)];
}));
// Eve beat an unrated player, so she has no rated games; Gus lost to a 1300.
JSON.stringify(deskPerformance[1]) === JSON.stringify(["Performance", "Eve ", "Gus 500"])
  ? pass("TD desk shows performance ratings in the standings") : fail(`TD desk performance: ${JSON.stringify(deskPerformance)}`);
// The round without a game can be reclassified afterward; the change saves at once.
await sectionDesk.select('.run-byes-all select[aria-label$="round 1"]', "half");
await sectionDesk.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Half-point bye"));
const reclassified = sectionCalls.find((c) => c.action === "byeKind") || {};
reclassified.id === "66666666" && reclassified.number === "1" && reclassified.kind === "half"
  ? pass("TD desk reclassifies a full-point bye as a half-point bye afterward") : fail(`TD desk reclassify: ${JSON.stringify(reclassified)}`);
await axeBoth(sectionDesk, "TD desk entering results in two sections");
await fitsPhone(sectionDesk, "TD desk entering results in two sections");
// A late entrant, added after round 1 with its half-point bye (28K), can still be moved up until their
// first game; everyone who has played, or had the full-point bye, stays in their section.
await sectionDesk.select('select[aria-label="Open board 1 result"]', "1-0");
await sectionDesk.select('select[aria-label="Open board 2 result"]', "0-1");
await sectionDesk.waitForSelector(".run-checkin:not([hidden])");
await press(sectionDesk, ".run-sync");
await sectionDesk.waitForFunction(() => document.querySelector('select[aria-label="Hal\'s section"]'));
const late = await sectionDesk.evaluate(() => ({
  menus: [...document.querySelectorAll('.run-attendance select[aria-label$="\'s section"]')].map((m) => [m.getAttribute("aria-label"), [...m.options].map((o) => o.value)]),
  bye: document.querySelector('.run-byes-all select[aria-label="Hal (1100), round 1"]')?.value }));
JSON.stringify(late) === JSON.stringify({ menus: [["Hal's section", ["Open", "Under 1400"]]], bye: "half" })
  ? pass("TD desk offers a section only to a late entrant who hasn't played, whose missed round is a half-point bye")
  : fail(`TD desk late entrant: ${JSON.stringify(late)}`);
await sectionDesk.select('select[aria-label="Hal\'s section"]', "Open");
await sectionDesk.waitForFunction(() => document.querySelector(".run-attendance-all h4")?.textContent === "Open (6)");
const lateMove = sectionCalls.filter((c) => c.action === "section").at(-1) || {};
lateMove.id === "88888888" && lateMove.section === "Open" ? pass("TD desk moves a late entrant up a section after round 1")
  : fail(`TD desk late section move: ${JSON.stringify(lateMove)}`);
await axeBoth(sectionDesk, "TD desk checking in a late entrant");
await fitsPhone(sectionDesk, "TD desk checking in a late entrant");
// The TD renames Under 1400 and moves it first; check-in follows the new names and order.
await sectionDesk.click(".run-names-wrap summary");
await press(sectionDesk, '.run-names-list button[data-focus="Under 1400-Up"]');
const focusKept = await sectionDesk.evaluate(() => document.activeElement?.dataset.focus);
const reserve = await sectionDesk.$('input[aria-label="New name for Under 1400"]');
await reserve.click({ clickCount: 3 });
await reserve.type("Reserve");
await fitsPhone(sectionDesk, "TD desk renaming and ordering sections");
await axeBoth(sectionDesk, "TD desk renaming and ordering sections");
if (process.env.SHOTS) {
  for (const width of [390, 1600]) {
    await sectionDesk.setViewport({ width, height: 900 });
    await sectionDesk.screenshot({ path: `${process.env.SHOTS}/late-entrant-and-section-names-${width}.png`, fullPage: true });
  }
  await sectionDesk.setViewport(PHONE);
}
await press(sectionDesk, ".run-names button[type=submit]");
await sectionDesk.waitForFunction(() => document.querySelector(".run-attendance-all h4")?.textContent.startsWith("Reserve"));
const named = sectionCalls.find((c) => c.action === "sectionNames") || {};
const namedHeadings = await sectionDesk.$$eval(".run-attendance-all h4", (h) => h.map((x) => x.textContent));
named.sections === JSON.stringify([{ from: "Under 1400", name: "Reserve", format: "swiss" }, { from: "Open", name: "Open", format: "swiss" }])
  && focusKept === "Under 1400-Up" && JSON.stringify(namedHeadings) === JSON.stringify(["Reserve (2)", "Open (6)"])
  ? pass("TD desk renames and reorders the sections, and checks in under the new names in the new order")
  : fail(`TD desk section names: ${JSON.stringify({ named, focusKept, namedHeadings })}`);
await sectionDesk.close();

// Players reporting results on the Pairings page: Ben is saved on this device by the Register
// form, so his board gets buttons; board 1 already has White's report, which shows as awaiting the TD.
const reportable = () => [{ key: "classic/2026-11-07", name: "Classic, Saturday, November 7, 2026", format: "swiss", plannedRounds: 3,
  status: "running", sections: [], players: fourPlayers(), rounds: [{ games: [
    { board: 1, white: "11111111", black: "33333333", result: "", section: "", reports: { white: "1-0", black: "" } },
    { board: 2, white: "44444444", black: "22222222", result: "", section: "" }], byes: [], out: [], posted: true }] }];
const reports = [];
const reportAnswer = (p) => {
  if (p.action !== "report") return { tournaments: reportable() };
  reports.push(p);
  return { ok: true, message: `Board ${p.board}: 0–1 is reported. The TD will confirm it.` };
};
const reportPage = await mocked("/pairings/ reporting a result", reportAnswer, PHONE);
await reportPage.evaluateOnNewDocument(() => {
  if (!sessionStorage.getItem("seeded")) {
    localStorage.setItem("lccc-register-players", JSON.stringify([{ id: "22222222", last: "Ben", email: "ben@example.com", name: "Ben" }]));
    sessionStorage.setItem("seeded", "1");
  }
});
await reportPage.goto(base + "/pairings/", { waitUntil: "networkidle0" });
const reportShown = () => reportPage.evaluate(() => ({
  results: [...document.querySelectorAll(".pairings-all tbody tr")].map((r) => r.cells[3].textContent),
  boxes: [...document.querySelectorAll(".report")].map((b) => b.querySelector("p").textContent),
  buttons: [...document.querySelectorAll(".report button")].map((b) => `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? " (pressed)" : ""}`),
  status: document.querySelector(".report [role=status]")?.textContent, focused: document.activeElement?.textContent }));
const beforeReport = await reportShown();
const prefilled = await reportPage.evaluate(() => ({ id: document.querySelector("#report-id").value,
  saved: [...document.querySelectorAll(".report-find .register-pick")].map((b) => b.textContent) }));
prefilled.id === "22222222" && JSON.stringify(prefilled.saved) === JSON.stringify(["Ben (22222222)"])
  ? pass("Pairings page fills in the ID the Register form saved, and lists the players saved on this device")
  : fail(`Pairings page saved players: ${JSON.stringify(prefilled)}`);
JSON.stringify(beforeReport.results) === JSON.stringify(["1–0, reported, awaiting the TD", ""])
  && beforeReport.boxes.length === 1 && beforeReport.boxes[0].startsWith("Board 2: Dee (1300) with white, Ben (1700) with black")
  && JSON.stringify(beforeReport.buttons) === JSON.stringify(["1–0, Dee won", "0–1, Ben won", "½–½, a draw"])
  ? pass("Pairings page shows a report awaiting the TD, and report buttons only for the board of a player saved here")
  : fail(`Pairings page reports: ${JSON.stringify(beforeReport)}`);
await axeBoth(reportPage, "Pairings page with a result to report");
await fitsPhone(reportPage, "Pairings page with a result to report");
await press(reportPage, ".report button:nth-child(2)");
await reportPage.waitForFunction(() => document.querySelector(".report [role=status]")?.textContent.includes("reported"));
const afterReport = await reportShown();
const sentReport = reports[0] || {};
JSON.stringify(sentReport) === JSON.stringify({ action: "report", event: "classic", date: "2026-11-07", number: "1", board: "2", section: "",
  id: "22222222", result: "0-1" }) && afterReport.results[1] === "0–1, reported, awaiting the TD"
  && afterReport.buttons[1] === "0–1, Ben won (pressed)" && afterReport.focused === "0–1, Ben won"
  ? pass("a saved player reports their result, which shows as awaiting the TD") : fail(`Pairings page report: ${JSON.stringify({ sentReport, afterReport })}`);
// A player who hasn't saved anyone finds their board by US Chess ID, which saves them the same way.
await reportPage.evaluate(() => localStorage.clear());
await reportPage.reload({ waitUntil: "networkidle0" });
const unsaved = await reportShown();
await reportPage.type("#report-id", "99999999");
await press(reportPage, ".report-find button[type=submit]");
const nobody = await reportPage.$eval(".report-find [role=status]", (p) => p.textContent);
await reportPage.$eval("#report-id", (i) => { i.value = ""; });
await reportPage.type("#report-id", "33333333");
await press(reportPage, ".report-find button[type=submit]");
await reportPage.waitForSelector(".report");
const foundBoard = await reportShown();
const savedNow = await reportPage.evaluate(() => JSON.parse(localStorage.getItem("lccc-register-players")));
unsaved.boxes.length === 0 && nobody.startsWith("Nobody with that US Chess ID") && foundBoard.boxes[0]?.startsWith("Board 1: Ann (1900)")
  && JSON.stringify(savedNow) === JSON.stringify([{ id: "33333333", last: "", email: "", name: "Cal" }]) && foundBoard.focused === "1–0, Ann won"
  ? pass("a player finds their board by US Chess ID on the Pairings page, and is saved on this device")
  : fail(`Pairings page find by ID: ${JSON.stringify({ unsaved, nobody, foundBoard, savedNow })}`);
await axeBoth(reportPage, "Pairings page after finding a board by US Chess ID");
await press(reportPage, ".report-find .register-forget");
const forgotten = await reportPage.evaluate(() => ({ saved: localStorage.getItem("lccc-register-players"), boxes: document.querySelectorAll(".report").length,
  listed: !document.querySelector(".report-find .register-saved").hidden }));
forgotten.saved === null && forgotten.boxes === 0 && !forgotten.listed
  ? pass("Forget on the Pairings page removes the saved player and their report buttons") : fail(`Pairings page forget: ${JSON.stringify(forgotten)}`);
await reportPage.close();

await done();
