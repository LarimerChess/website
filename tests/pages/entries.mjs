// The Entries page, byes asked for on it, and running a tournament and an arena on the TD desk.
import { axeBoth, axeSource, base, browser, done, events, fail, fitsPhone, offline, pass, press } from "./common.mjs";

// The Entries page, against a stand-in for the Apps Script's ?entries=all.
const entriesPage = await browser.newPage();
entriesPage.on("pageerror", (error) => fail(`JavaScript error on /entries/: ${error.message}`));
await entriesPage.setRequestInterception(true);
entriesPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
  } else if (url.host === "registration.test") {
    const events = [
      { key: "club-night/2026-10-12", name: "Club Night", label: "Monday, October 12, 2026", page: "/events/club-night/",
        start: "2026-10-12T18:30:00-06:00", entries: [{ name: "Test Player", id: "12345678", rating: "1500", for: "Whole month" }] },
      { key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", page: "/events/classic/",
        start: "2026-11-07T10:00:00-07:00", entries: [] },
    ];
    request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ events }) });
  } else {
    request.continue();
  }
});
await entriesPage.goto(base + "/entries/", { waitUntil: "networkidle0" });
const entriesShown = () => entriesPage.evaluate(() => ({
  choices: [...document.querySelectorAll("#entries-event option")].map((o) => o.textContent),
  groups: [...document.querySelectorAll("#entries-event optgroup")].map((g) => g.label),
  title: document.querySelector(".entries-all h2")?.textContent, rows: document.querySelectorAll(".entries-all tbody tr").length,
  register: document.querySelector(".entries-all a.button")?.getAttribute("href"), address: location.search,
  page: document.querySelector(".entries-all h2 a")?.getAttribute("href") }));
const entriesOpened = await entriesShown();
JSON.stringify(entriesOpened.groups) === JSON.stringify(["October 2026", "November 2026"]) && entriesOpened.choices.length === 2
  && entriesOpened.title === "Club Night" && entriesOpened.rows === 1 && entriesOpened.register === "/events/club-night/?date=2026-10-12#register"
  && entriesOpened.page === "/events/club-night/"
  ? pass("Entries page opens on the soonest event, with its players, a link to its page, and a Register link")
  : fail(`Entries page on open: ${JSON.stringify(entriesOpened)}`);
await entriesPage.select("#entries-event", "classic/2026-11-07");
const entriesChosen = await entriesShown();
entriesChosen.title === "Classic" && entriesChosen.rows === 0 && entriesChosen.address === "?event=classic%2F2026-11-07"
  ? pass("Entries page shows the event the reader picks, and keeps it in the address") : fail(`Entries page after choosing: ${JSON.stringify(entriesChosen)}`);
await entriesPage.goto(base + "/entries/?event=classic%2F2026-11-07", { waitUntil: "networkidle0" });
(await entriesShown()).title === "Classic" ? pass("Entries page opens on the event in its address") : fail("Entries page ignored ?event=");
await entriesPage.evaluate(axeSource);
const entriesAxe = await entriesPage.evaluate(() => axe.run());
entriesAxe.violations.length ? fail(`Entries page filled: ${entriesAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("Entries page filled has no axe violations");
await entriesPage.close();

// With LIVE_DB set, the Entries page shows the database's copy of the lists, less the days gone since it
// was built, while the script is still answering, and then the script's lists.
const quickPage = await browser.newPage();
quickPage.on("pageerror", (error) => fail(`JavaScript error on /entries/ from the copy: ${error.message}`));
let releaseScript;
const scriptHeld = new Promise((resolve) => { releaseScript = resolve; });
const copyEvent = (name, entrant) => ({ key: `${name.toLowerCase()}/2099-11-07`, name, label: "Saturday, November 7, 2099",
  page: `/events/${name.toLowerCase()}/`, start: "2099-11-07T10:00:00-07:00", entries: [{ name: entrant, id: "12345678", rating: "1500" }] });
const gone = { ...copyEvent("Gone", "Past Player"), key: "gone/2020-01-04", start: "2020-01-04T10:00:00-07:00" };
await quickPage.setRequestInterception(true);
quickPage.on("request", async (request) => {
  const url = new URL(request.url());
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (url.pathname === "/register.js") {
    const source = offline(await (await fetch(base + "/register.js")).text());
    request.respond({ contentType: "text/javascript", body: source.replace(/^const LIVE_DB = ".*";$/m, 'const LIVE_DB = "https://live.test";') });
  } else if (url.host === "live.test" && url.pathname === "/public/entries.json") {
    request.respond({ headers: cors, contentType: "application/json", body: JSON.stringify(JSON.stringify([gone, copyEvent("Classic", "Copy Player")])) });
  } else if (url.host === "registration.test") {
    await scriptHeld;
    request.respond({ headers: cors, contentType: "application/json", body: JSON.stringify({ events: [copyEvent("Classic", "Fresh Player")] }) });
  } else {
    request.continue();
  }
});
await quickPage.goto(base + "/entries/");
const fromCopy = await quickPage.waitForSelector(".entries-all tbody tr", { timeout: 3000 }).then(() => quickPage.evaluate(() => ({
  choices: [...document.querySelectorAll("#entries-event option")].map((o) => o.value),
  rows: [...document.querySelectorAll(".entries-all tbody tr")].map((r) => r.cells[0].textContent) })), () => null);
releaseScript();
const fromScript = await quickPage.waitForFunction(() => document.querySelector(".entries-all tbody tr")?.cells[0].textContent === "Fresh Player",
  { timeout: 3000 }).then(() => true, () => false);
JSON.stringify(fromCopy) === JSON.stringify({ choices: ["classic/2099-11-07"], rows: ["Copy Player"] }) && fromScript
  ? pass("Entries page shows the database's copy, less past days, before the script answers, then the script's lists")
  : fail(`Entries page from the copy: ${JSON.stringify({ fromCopy, fromScript })}`);
await quickPage.close();

// A player saved on this device, registered for one club night, switches to its whole month.
const switchPage = await browser.newPage();
switchPage.on("pageerror", (error) => fail(`JavaScript error on /entries/ switching: ${error.message}`));
const switchSaved = await switchPage.evaluateOnNewDocument(() => localStorage.setItem("lccc-register-players",
  JSON.stringify([{ id: "22345678", last: "Player", email: "night@example.com", name: "Night Player" }])));
switchPage.on("dialog", (d) => d.accept());
const switchCalls = [];
await switchPage.setRequestInterception(true);
switchPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
  } else if (url.pathname === "/events.json") {
    request.respond({ contentType: "application/json", body: JSON.stringify([
      { page: "/events/club-night/", start: "2026-10-12T18:30:00-06:00", tags: ["casual"] },
      { page: "/events/classic/", start: "2026-11-07T10:00:00-07:00", tags: ["tournament"] }]) });
  } else if (url.host === "registration.test") {
    if (request.method() === "POST") switchCalls.push(Object.fromEntries(new URLSearchParams(request.postData())));
    const moved = switchCalls.length === 1;
    const body = request.method() === "POST" ? { ok: true, message: switchCalls.length === 1
      ? "Night Player is registered for all Mondays in October 2026. Due when you arrive: $9.50."
      : "Night Player is registered for Monday, October 12, 2026 only. Due when you arrive: $7.50." }
      : { events: [
        { key: "club-night/2026-10-12", name: "Club Night", label: "Monday, October 12, 2026", page: "/events/club-night/", start: "2026-10-12T18:30:00-06:00",
          entries: [{ name: "Test Player", id: "12345678", rating: "1500", for: "Monday, October 12" },
            { name: "Night Player", id: "22345678", rating: "1400", for: moved ? "Whole month" : "Monday, October 12" }] },
        { key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", page: "/events/classic/", start: "2026-11-07T10:00:00-07:00",
          entries: [{ name: "Night Player", id: "22345678", rating: "1400", for: "Saturday, November 7" }] }] };
    request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
  } else {
    request.continue();
  }
});
await switchPage.goto(base + "/entries/", { waitUntil: "networkidle0" });
const switchers = await switchPage.$$eval(".entries-switch", (b) => b.map((x) => x.closest("tr").cells[0].textContent));
(await switchPage.$$(".entries-all a.button")).length === 0 ? pass("Entries page hides Register when the latest player saved here is registered")
  : fail("Entries page shows Register to a player saved here who is registered");
await switchPage.evaluate(axeSource);
const switchAxe = await switchPage.evaluate(() => axe.run());
switchAxe.violations.length ? fail(`Entries page with a switch: ${switchAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("Entries page with a switch has no axe violations");
await switchPage.click(".entries-switch");
await switchPage.waitForFunction(() => document.querySelector(".entries-all-status").textContent.includes("all Mondays"));
const afterSwitch = await switchPage.evaluate(() => ({ buttons: [...document.querySelectorAll(".entries-switch")].map((b) => b.firstChild.textContent),
  for: [...document.querySelectorAll(".entries-all tbody tr")].map((r) => r.cells[3].firstChild.textContent) }));
JSON.stringify(switchers) === '["Night Player"]' && JSON.stringify(switchCalls) === JSON.stringify([{ event: "club-night", date: "2026-10", id: "22345678",
  last: "Player", email: "night@example.com" }]) && JSON.stringify(afterSwitch.buttons) === '["Just this night"]' && afterSwitch.for.includes("Whole month")
  ? pass("Entries page lets a saved player switch a club night to its whole month")
  : fail(`Entries page switch: ${JSON.stringify({ switchers, switchCalls, afterSwitch })}`);
await switchPage.click(".entries-switch");
await switchPage.waitForFunction(() => document.querySelector(".entries-all-status").textContent.includes("only"));
const backToNight = await switchPage.evaluate(() => ({ buttons: [...document.querySelectorAll(".entries-switch")].map((b) => b.firstChild.textContent),
  for: [...document.querySelectorAll(".entries-all tbody tr")].map((r) => r.cells[3].firstChild.textContent) }));
JSON.stringify(switchCalls[1]) === JSON.stringify({ action: "toNight", event: "club-night", date: "2026-10-12", id: "22345678", last: "Player",
  email: "night@example.com" }) && JSON.stringify(backToNight) === JSON.stringify({ buttons: ["Switch to month"], for: ["This night", "This night"] })
  ? pass("Entries page lets a saved player switch a whole month back to just this night")
  : fail(`Entries page switch to a night: ${JSON.stringify({ call: switchCalls[1], backToNight })}`);
await switchPage.select("#entries-event", "classic/2026-11-07");
(await switchPage.$$(".entries-switch")).length === 0 ? pass("Entries page offers no switch for a tournament")
  : fail("Entries page offers a switch for a tournament");
const siblingSaved = await switchPage.evaluateOnNewDocument(() => localStorage.setItem("lccc-register-players", JSON.stringify([
  { id: "32345678", last: "Sibling", email: "sibling@example.com", name: "Sibling Player" },
  ...JSON.parse(localStorage.getItem("lccc-register-players"))])));
await switchPage.goto(base + "/entries/?event=club-night/2026-10-12", { waitUntil: "networkidle0" });
const nightRegister = await switchPage.evaluate(() => {
  const register = document.querySelector(".entries-all a.button");
  return { href: register?.getAttribute("href"),
    above: Boolean(register?.compareDocumentPosition(document.querySelector(".entries-all table")) & Node.DOCUMENT_POSITION_FOLLOWING) };
});
nightRegister.href === "/events/club-night/?date=2026-10#register" && nightRegister.above
  ? pass("Entries page shows Register above the list when the latest player saved here isn't registered, opening a club night on its whole month")
  : fail(`Entries page Register for a club night: ${JSON.stringify(nightRegister)}`);
await press(switchPage, ".entries-all .register-saved li:nth-child(2) .register-pick");
const pickedNight = await switchPage.evaluate(() => ({ register: Boolean(document.querySelector(".entries-all a.button")),
  first: document.querySelector(".entries-all .register-pick").textContent }));
for (const { identifier } of [switchSaved, siblingSaved]) await switchPage.removeScriptToEvaluateOnNewDocument(identifier);
await switchPage.reload({ waitUntil: "networkidle0" });
const pickedKept = await switchPage.evaluate(() => Boolean(document.querySelector(".entries-all a.button")));
JSON.stringify(pickedNight) === JSON.stringify({ register: false, first: "Night Player (22345678)" }) && !pickedKept
  ? pass("Entries page takes the player picked as the reader, hiding Register for their event, and keeps the choice")
  : fail(`Entries page after a pick: ${JSON.stringify({ pickedNight, pickedKept })}`);
await switchPage.close();

// Byes on the Entries page, against a stand-in that keeps Ann's: a Byes column, and Change byes for a player saved
// on this device, on a whole month, which offers the nights still to come and keeps a bye on one already played, and
// on a Swiss, which offers its rounds, but never on a quad; and a form that saves a player registered on another device.
const byesPage = await browser.newPage();
byesPage.on("pageerror", (error) => fail(`JavaScript error on /entries/ with byes: ${error.message}`));
await byesPage.evaluateOnNewDocument(() => {
  if (!sessionStorage.getItem("seeded")) {
    localStorage.setItem("lccc-register-players", JSON.stringify([{ id: "12345678", last: "Example", email: "ann@example.com", name: "Ann Example" }]));
    sessionStorage.setItem("seeded", "1");
  }
});
const byesCalls = [];
// Ann's byes by event; events.json no longer lists October 5, which has been played.
const annByes = { "club-night": ["2099-10-05", "2099-10-12"], classic: ["3"] };
await byesPage.setRequestInterception(true);
byesPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    request.respond({ contentType: "text/javascript", body: offline(await (await fetch(base + "/register.js")).text()) });
  } else if (url.pathname === "/events.json") {
    request.respond({ contentType: "application/json", body: JSON.stringify([
      ...["12", "19", "26"].map((day) => ({ page: "/events/club-night/", start: `2099-10-${day}T18:30:00-06:00`, tags: ["casual"], pairing: "swiss", rounds: "" })),
      { page: "/events/classic/", start: "2099-11-07T10:00:00-07:00", tags: ["tournament"], pairing: "swiss", rounds: "4" },
      { page: "/events/quads/", start: "2099-11-14T10:00:00-07:00", tags: ["tournament"], pairing: "quad", rounds: "3" }]) });
  } else if (url.host === "registration.test") {
    let body;
    if (request.method() === "POST") {
      const p = Object.fromEntries(new URLSearchParams(request.postData()));
      byesCalls.push(p);
      const byes = p.byes ? p.byes.split(", ") : [];
      if (p.event === "classic" && byes.length > 1) {
        body = { error: "Online, a player can ask for one bye in a one-day tournament." };
      } else {
        annByes[p.event] = byes;
        body = { ok: true, message: "Ann Example's byes are saved." };
      }
    } else {
      const ann = (event, rest) => ({ name: "Ann Example", id: "12345678", rating: "1500", ...rest, ...(annByes[event]?.length ? { byes: annByes[event] } : {}) });
      body = { events: [
        { key: "club-night/2099-10-12", name: "Club Night", label: "Monday, October 12, 2099", page: "/events/club-night/", start: "2099-10-12T18:30:00-06:00",
          entries: [ann("club-night", { for: "Whole month" }), { name: "Ben Example", id: "22345678", rating: "1200", for: "Monday, October 12" }] },
        { key: "club-night/2099-10-26", name: "Club Night", label: "Monday, October 26, 2099", page: "/events/club-night/", start: "2099-10-26T18:30:00-06:00",
          entries: [ann("club-night", { for: "Whole month" })] },
        { key: "classic/2099-11-07", name: "Classic", label: "Saturday, November 7, 2099", page: "/events/classic/", start: "2099-11-07T10:00:00-07:00",
          entries: [ann("classic", { for: "Saturday, November 7" }), { name: "Cal Example", id: "32345678", rating: "1400", for: "Saturday, November 7" }] },
        { key: "quads/2099-11-14", name: "Quads", label: "Saturday, November 14, 2099", page: "/events/quads/", start: "2099-11-14T10:00:00-07:00",
          entries: [ann("quads", { for: "Saturday, November 14" })] }] };
    }
    request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
  } else {
    request.continue();
  }
});
// The Byes column's text, without its button, and whose rows have Change byes.
const byesShown = () => byesPage.evaluate(() => {
  const head = [...document.querySelectorAll(".entries-all thead th")].map((c) => c.textContent);
  return { head, byes: [...document.querySelectorAll(".entries-all tbody tr")].map((r) => [...(r.cells[head.indexOf("Byes")]?.childNodes || [])]
    .filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("").trim()),
  changers: [...document.querySelectorAll(".entries-all .entries-change-byes")].map((b) => b.closest("tr").cells[0].textContent),
  status: document.querySelector(".entries-all-status").textContent, focused: document.activeElement?.textContent };
});
const byesEditor = () => byesPage.evaluate(() => {
  const group = document.querySelector(".entries-all [role=group]");
  return group && { label: group.getAttribute("aria-label"), focused: document.activeElement?.id || document.activeElement?.textContent,
    boxes: [...group.querySelectorAll("input")].map((b) => `${b.labels[0].textContent}${b.checked ? " (checked)" : ""}`) };
});
const saveByes = async (said) => {
  await press(byesPage, ".entries-all [role=group] + p button");
  await byesPage.waitForFunction((s) => document.querySelector(".entries-all-status").textContent.startsWith(s), {}, said);
};
await byesPage.goto(base + "/entries/", { waitUntil: "networkidle0" });
const monthByes = await byesShown();
await press(byesPage, ".entries-change-byes");
const monthEditor = await byesEditor();
await axeBoth(byesPage, "Entries page changing byes");
await byesPage.setViewport({ width: 390, height: 844 });
await fitsPhone(byesPage, "Entries page changing byes");
await byesPage.setViewport({ width: 1100, height: 800 });
await press(byesPage, "#entries-bye-12345678-2099-10-12");
await press(byesPage, "#entries-bye-12345678-2099-10-26");
await saveByes("Ann Example's byes");
const monthSaved = await byesShown();
await byesPage.select("#entries-event", "club-night/2099-10-26");
const otherNight = await byesShown();
await byesPage.select("#entries-event", "club-night/2099-10-12");
JSON.stringify(monthByes.head) === JSON.stringify(["Name", "US Chess ID", "Rating", "For", "Byes"])
  && JSON.stringify(monthByes.byes) === JSON.stringify(["Half-point bye", ""]) && JSON.stringify(monthByes.changers) === '["Ann Example"]'
  && JSON.stringify(monthEditor) === JSON.stringify({ label: "Nights Ann Example will miss", focused: "entries-bye-12345678-2099-10-12",
    boxes: ["October 12 (checked)", "October 19", "October 26"] })
  && JSON.stringify(byesCalls[0]) === JSON.stringify({ action: "byes", event: "club-night", date: "2099-10", id: "12345678", last: "Example",
    email: "ann@example.com", byes: "2099-10-05, 2099-10-26" })
  && monthSaved.byes[0] === "" && JSON.stringify(otherNight.byes) === '["Half-point bye"]' && monthSaved.status === "Ann Example's byes are saved." && monthSaved.focused === "Change byes for Ann Example"
  ? pass("Entries page shows each of a month's byes on its own night's list, and a saved player changes them, keeping the nights already played")
  : fail(`Entries page month's byes: ${JSON.stringify({ monthByes, monthEditor, call: byesCalls[0], monthSaved, otherNight })}`);
await press(byesPage, ".entries-change-byes");
await press(byesPage, ".entries-all [role=group] + p button:last-child");
const cancelled = await byesShown();
cancelled.byes[0] === "" && cancelled.focused === "Change byes for Ann Example" && byesCalls.length === 1
  ? pass("Entries page's Cancel puts the byes back as they were") : fail(`Entries page Cancel: ${JSON.stringify({ cancelled, byesCalls })}`);
await byesPage.select("#entries-event", "classic/2099-11-07");
const swissByes = await byesShown();
await press(byesPage, ".entries-change-byes");
const swissEditor = await byesEditor();
await press(byesPage, "#entries-bye-12345678-4");
await saveByes("Online");
const byesRefused = await byesEditor();
await press(byesPage, "#entries-bye-12345678-3");
await saveByes("Ann Example's byes");
const swissSaved = await byesShown();
await byesPage.select("#entries-event", "quads/2099-11-14");
const quadByes = await byesShown();
JSON.stringify(swissByes.byes) === JSON.stringify(["Round 3", ""]) && JSON.stringify(swissByes.changers) === '["Ann Example"]'
  && JSON.stringify(swissEditor.boxes) === JSON.stringify(["Round 1", "Round 2", "Round 3 (checked)", "Round 4"])
  && swissEditor.label === "Rounds Ann Example will miss"
  && JSON.stringify(byesRefused) === JSON.stringify({ ...swissEditor, focused: "Save", boxes: ["Round 1", "Round 2", "Round 3 (checked)", "Round 4 (checked)"] })
  && JSON.stringify(byesCalls.slice(1).map((c) => [c.event, c.date, c.byes])) === JSON.stringify([["classic", "2099-11-07", "3, 4"], ["classic", "2099-11-07", "4"]])
  && swissSaved.byes[0] === "Round 4" && !quadByes.head.includes("Byes") && !quadByes.changers.length
  ? pass("Entries page changes a Swiss's byes by round, keeps them open after a refusal, and offers none for a quad")
  : fail(`Entries page Swiss's byes: ${JSON.stringify({ swissByes, swissEditor, byesRefused, calls: byesCalls.slice(1), swissSaved, quadByes })}`);
// Saved on another device: the form saves the player here, and their row gets its buttons.
await byesPage.evaluate(() => localStorage.clear());
await byesPage.goto(base + "/entries/?event=club-night%2F2099-10-12", { waitUntil: "networkidle0" });
const byesUnsaved = await byesShown();
await press(byesPage, "#entries-find");
await axeBoth(byesPage, "Entries page with the form for another device");
const findPlayer = async (id) => {
  for (const [field, value] of [["#entries-find-id", id], ["#entries-find-last", "Example"], ["#entries-find-email", "ann@example.com"]]) {
    await byesPage.$eval(field, (input) => { input.value = ""; });
    await byesPage.type(field, value);
  }
  await press(byesPage, ".entries-all form button[type=submit]");
};
await findPlayer("99999999");
const byesNobody = (await byesShown()).status;
await findPlayer("12345678");
const foundHere = await byesShown();
const savedHere = await byesPage.evaluate(() => ({ saved: JSON.parse(localStorage.getItem("lccc-register-players")),
  open: document.querySelector(".entries-all details").open }));
!byesUnsaved.changers.length && JSON.stringify(byesUnsaved.byes) === JSON.stringify(["", ""])
  && byesNobody === "Nobody with that US Chess ID is registered for an upcoming event."
  && JSON.stringify(savedHere) === JSON.stringify({ saved: [{ id: "12345678", last: "Example", email: "ann@example.com", name: "Ann Example" }], open: false })
  && JSON.stringify(foundHere.changers) === '["Ann Example"]' && foundHere.focused === "Just this night for Ann Example"
  && foundHere.status === "Ann Example is saved on this device. Change the entry with the buttons on its row."
  ? pass("Entries page saves a player registered on another device, whose row then has its buttons")
  : fail(`Entries page another device: ${JSON.stringify({ byesUnsaved, byesNobody, foundHere, savedHere })}`);
// The players saved on this device are listed as on the Register form and the Pairings page. Ann was saved by the
// Pairings page, with her ID alone, and Cal by the Register form: picking Cal opens his list, and Ann's row has its
// buttons, which ask for her last name and email once, then work.
await byesPage.evaluate(() => localStorage.setItem("lccc-register-players", JSON.stringify([
  { id: "12345678", last: "", email: "", name: "Ann Example" }, { id: "32345678", last: "Example", email: "cal@example.com", name: "Cal Example" }])));
await byesPage.goto(base + "/entries/?event=club-night%2F2099-10-12", { waitUntil: "networkidle0" });
const savedListed = await byesPage.$$eval(".entries-all .register-saved:not([hidden]) .register-pick", (b) => b.map((x) => x.textContent));
const idOnly = await byesShown();
await press(byesPage, ".entries-all .register-saved li:nth-child(2) .register-pick");
const pickedCal = { ...await byesShown(), event: await byesPage.$eval("#entries-event", (s) => s.value) };
await axeBoth(byesPage, "Entries page with players saved on this device");
await byesPage.select("#entries-event", "club-night/2099-10-12");
const callsBefore = byesCalls.length;
await press(byesPage, `tr[data-id="12345678"] .entries-change-byes`);
const askedOnce = await byesPage.evaluate(() => ({ open: document.querySelector(".entries-all details").open, id: document.querySelector("#entries-find-id").value,
  focused: document.activeElement.id, status: document.querySelector(".entries-all-status").textContent,
  editor: Boolean(document.querySelector(".entries-all [role=group]")) }));
for (const [field, value] of [["#entries-find-last", "Example"], ["#entries-find-email", "ann@example.com"]]) await byesPage.type(field, value);
await press(byesPage, ".entries-all form button[type=submit]");
const annCompleted = { ...await byesShown(), saved: await byesPage.evaluate(() => JSON.parse(localStorage.getItem("lccc-register-players"))[0]) };
await press(byesPage, `tr[data-id="12345678"] .entries-change-byes`);
const editorAfter = await byesEditor();
JSON.stringify(savedListed) === JSON.stringify(["Ann Example (12345678)", "Cal Example (32345678)"])
  && JSON.stringify(idOnly.changers) === '["Ann Example"]'
  && pickedCal.event === "classic/2099-11-07" && pickedCal.focused === "Change byes for Cal Example"
  && pickedCal.status === "Cal Example (32345678): change the entry with the buttons on its row."
  && JSON.stringify(askedOnce) === JSON.stringify({ open: true, id: "12345678", focused: "entries-find-last",
    status: "To change Ann Example's entry, enter the last name and email used to register.", editor: false })
  && byesCalls.length === callsBefore
  && JSON.stringify(annCompleted.saved) === JSON.stringify({ id: "12345678", last: "Example", email: "ann@example.com", name: "Ann Example" })
  && annCompleted.focused === "Change byes for Ann Example" && editorAfter?.label === "Nights Ann Example will miss"
  ? pass("Entries page lists the players saved on this device, and one saved with only an ID gives the last name and email once")
  : fail(`Entries page saved players: ${JSON.stringify({ savedListed, idOnly, pickedCal, askedOnce, annCompleted, editorAfter })}`);
await press(byesPage, ".entries-all [role=group] + p button:last-child");
await press(byesPage, ".entries-all .register-saved li:first-child .register-forget");
const forgotHere = { ...await byesShown(), listed: await byesPage.$$eval(".entries-all .register-pick", (b) => b.map((x) => x.textContent)) };
JSON.stringify(forgotHere.listed) === '["Cal Example (32345678)"]' && !forgotHere.changers.length
  && forgotHere.status === "Ann Example (12345678) is no longer saved on this device." && forgotHere.focused === "Cal Example (32345678)"
  ? pass("Forget on the Entries page removes the saved player and their row's buttons") : fail(`Entries page forget: ${JSON.stringify(forgotHere)}`);
await byesPage.evaluate(() => localStorage.clear());
await byesPage.close();

// Running a tournament on the TD desk, against a stand-in for the Apps Script that keeps the
// tournament in memory: start it, check in, pair round one, post it, and enter a result.
const runPage = await browser.newPage();
runPage.on("pageerror", (error) => fail(`JavaScript error on /td/ running a tournament: ${error.message}`));
const runCalls = [];
let held = null;
await runPage.setRequestInterception(true);
runPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
    return;
  }
  if (url.host !== "registration.test") return request.continue();
  const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
  runCalls.push(p);
  const players = [["11111111", "Ann", 1900], ["22222222", "Ben", 1700], ["33333333", "Cal", 1500], ["44444444", "Dee", 1300]]
    .map(([id, name, rating], i) => ({ id, number: i + 1, name, rating, out: null }));
  let body = { ok: true };
  if (p.action === "login") body = { ok: true };
  else if (p.action === "choices") body = { choices: [{ key: "classic/2026-11-07", name: "Classic", label: "Saturday, November 7, 2026", kind: "entry", first: "2026-11-07" }] };
  else if (p.action === "entries") body = { entries: [] };
  else if (p.action === "incidents") body = { incidents: [] };
  else if (p.action === "tournament") body = { tournament: held };
  else if (p.action === "start") {
    held = { key: "classic/2026-11-07", name: "Classic", format: "swiss", plannedRounds: 3, status: "running", coin: p.coin, players, rounds: [] };
    body = { ok: true, message: "Added 4 player(s)." };
  } else if (p.action === "round") {
    held.rounds = [{ games: JSON.parse(p.games).map((g) => ({ ...g, result: "" })), byes: JSON.parse(p.byes), out: [], posted: p.post === "yes" }];
    body = { ok: true, message: "Round 1 is posted." };
  } else if (p.action === "result") {
    held.rounds[0].games.find((g) => g.board === Number(p.board)).result = p.result;
  }
  request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
});
await runPage.goto(base + "/td/", { waitUntil: "networkidle0" });
await runPage.type("#td-password", "secret");
await runPage.click(".td-login button");
await runPage.waitForSelector(".run-start:not([hidden])");
// Explanations sit behind ? buttons: a tap shows one, Escape hides it. The format menu is on the status line.
const hintShown = () => runPage.$eval("#run-sections-hint", (h) => getComputedStyle(h).display !== "none");
const hiddenAtFirst = !(await hintShown());
await runPage.click('.run-sections .hint-button');
const shownOnTap = await hintShown();
await runPage.keyboard.press("Escape");
await runPage.mouse.move(0, 0);
const hiddenOnEscape = !(await hintShown());
const sameLine = await runPage.evaluate(() => {
  const middle = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return r.top + r.height / 2; };
  return [middle(".run-status") - middle("#run-format"), middle('[for="run-td"]') - middle("#run-td")];
});
hiddenAtFirst && shownOnTap && hiddenOnEscape && sameLine.every((d) => Math.abs(d) < 8) ? pass("TD desk start form puts menus beside their labels and explanations behind ? buttons")
  : fail(`TD desk start form: ${JSON.stringify({ hiddenAtFirst, shownOnTap, hiddenOnEscape, sameLine })}`);
await runPage.type("#run-rounds", "3");
await press(runPage, ".run-start button[type=submit]");
await runPage.waitForSelector(".run-round:not([hidden]) .run-pair");
await runPage.waitForFunction(() => document.querySelectorAll(".run-attendance tbody tr").length === 4);
const startsPresent = await runPage.$$eval(".run-this-round", (s) => s.every((x) => x.value === "play"));
startsPresent ? pass("TD desk check-in starts with everyone present") : fail("TD desk check-in doesn't start everyone as present");
await press(runPage, ".run-pair");
await runPage.waitForSelector(".run-pairings:not([hidden])");
await press(runPage, ".run-post");
await runPage.waitForFunction(() => document.querySelector(".run-round-title").textContent.includes("results"));
const postedRound = runCalls.find((c) => c.action === "round") || {};
const postedGames = JSON.parse(postedRound.games || "[]");
postedGames.length === 2 && postedRound.post === "yes"
  && JSON.stringify(postedGames.map((g) => [g.white, g.black])) === JSON.stringify([["11111111", "33333333"], ["44444444", "22222222"]])
  ? pass("TD desk starts a tournament and posts round one by rule 28J") : fail(`TD desk round one: ${JSON.stringify(postedRound)}`);
await runPage.select(".run-games tbody tr:first-child select", "1-0");
await runPage.waitForFunction(() => document.querySelector(".run-standings tbody tr td:nth-child(2)")?.textContent === "Ann");
pass("TD desk enters a result and updates the standings");
await runPage.evaluate(axeSource);
const runAxe = await runPage.evaluate(() => axe.run());
runAxe.violations.length ? fail(`TD desk running a tournament: ${runAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("TD desk running a tournament has no axe violations");
await runPage.close();

// Running an arena on the TD desk, against a stand-in for the Apps Script that keeps it in
// memory, with the clock at 11:00 AM on the day: start it in the three Knightmare sections, make
// four players available, pair the Classical pair, start a Blood Pact game by hand saying who halves
// their clock, confirm a result the players reported, and rename a section.
const arenaPage = await browser.newPage();
arenaPage.on("pageerror", (error) => fail(`JavaScript error on /td/ running an arena: ${error.message}`));
const arenaCalls = [];
let arena = null;
await arenaPage.evaluateOnNewDocument((fixed) => {
  const RealDate = Date;
  window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
}, new Date("2026-10-31T11:00:00-06:00").getTime());
await arenaPage.setRequestInterception(true);
arenaPage.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
    return;
  }
  if (url.host !== "registration.test") return request.continue();
  const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
  arenaCalls.push(p);
  const since = () => `2026-10-31 11:00:${String(arenaCalls.length).padStart(2, "0")}`;
  let body = { ok: true };
  if (p.action === "choices") {
    body = { choices: [{ key: "knightmare-arena-classical/2026-10-31", name: "Knightmare Arena Classical",
      label: "Saturday, October 31, 2026", kind: "entry", first: "2026-10-31" }] };
  } else if (p.action === "entries") body = { entries: [] };
  else if (p.action === "incidents") body = { incidents: [] };
  else if (p.action === "tournament") body = { tournament: arena };
  else if (p.action === "start") {
    const players = [["11111111", "Ann", 1900], ["22222222", "Ben", 1700], ["33333333", "Cal", 1500], ["44444444", "Dee", null]]
      .map(([id, name, rating], i) => ({ id, number: i + 1, name, rating, out: null }));
    arena = { key: "knightmare-arena-classical/2026-10-31", name: "Knightmare Arena Classical, Saturday, October 31, 2026",
      format: p.format, cutoff: p.cutoff, status: "running", players, rounds: [], games: [], queue: [], sections: JSON.parse(p.sections || "[]") };
    body = { ok: true, message: "Added 4 player(s)." };
  } else if (p.action === "arenaJoin") {
    arena.queue = arena.queue.filter((q) => q.id !== p.id);
    arena.queue.push({ id: p.id, since: since(), sections: JSON.parse(p.sections || "[]") });
    body = { ok: true, message: "Available." };
  } else if (p.action === "arenaLeave") {
    arena.queue = arena.queue.filter((q) => q.id !== p.id);
  } else if (p.action === "arenaPair") {
    for (const g of JSON.parse(p.games)) arena.games.push({ game: arena.games.length + 1, whitePact: false, blackPact: false, ...g, result: "" });
    body = { ok: true, message: "Started." };
  } else if (p.action === "arenaPact") {
    arena.games[p.game - 1].whitePact = p.who === "white";
    arena.games[p.game - 1].blackPact = p.who === "black";
  } else if (p.action === "arenaResult") {
    arena.games[p.game - 1].result = p.result;
    body = { ok: true, message: "Recorded." };
  } else if (p.action === "arenaSections") {
    const list = JSON.parse(p.sections);
    for (const g of arena.games) g.section = list.find((x) => x.from === g.section)?.name ?? g.section;
    arena.sections = list.map(({ from, ...x }) => x);
    body = { ok: true, message: `Sections: ${arena.sections.map((x) => x.name).join(", ")}.` };
  }
  request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
});
await arenaPage.goto(base + "/td/", { waitUntil: "networkidle0" });
await arenaPage.type("#td-password", "secret");
await arenaPage.click(".td-login button");
await arenaPage.waitForSelector(".run-start:not([hidden])");
await arenaPage.select("#run-format", "arena");
const startFields = await arenaPage.evaluate(() => ({ cutoff: document.querySelector("#run-cutoff").checkVisibility(),
  rounds: document.querySelector("#run-rounds").checkVisibility(), value: document.querySelector("#run-cutoff").value,
  sections: [...document.querySelectorAll(".run-start .run-arena-section-row")].map((r) => [r.querySelector(".run-arena-section-name").value,
    r.querySelector(".run-arena-section-control").value, r.querySelector(".run-arena-section-rated-box").checked,
    r.querySelector(".run-arena-section-pact-box").checked, r.querySelector(".run-arena-section-rated-box").disabled]) }));
startFields.cutoff && !startFields.rounds && startFields.value === "17:30"
  && JSON.stringify(startFields.sections) === JSON.stringify([["Classical", "G/30;+30", true, false, false], ["Blood Pact", "G/15;+15 against G/30;+30", false, true, true], ["Rapid", "G/15;+15", true, false, false]])
  ? pass("TD desk asks an arena for its cutoff, 17:30 unless changed, and offers the Knightmare sections, the Blood Pact one never rated")
  : fail(`TD desk arena start form: ${JSON.stringify(startFields)}`);
await press(arenaPage, ".run-start button[type=submit]");
await arenaPage.waitForSelector(".run-arena:not([hidden])");
const startCall = arenaCalls.find((c) => c.action === "start") || {};
const startSections = JSON.parse(startCall.sections || "[]");
startSections.map((x) => x.name).join() === "Classical,Blood Pact,Rapid" && startSections[1].rated === false && startSections[1].pact === true && startSections[0].pact === false
  ? pass("TD desk starts an arena with its sections") : fail(`TD desk arena start: ${JSON.stringify(startCall)}`);
// Players are listed by name; toggle Classical for the first two, Blood Pact for the other two.
const rowsOf = () => arenaPage.$$eval(".run-players tbody tr", (rows) => rows.map((r) => [r.cells[0].textContent, r.cells[3].textContent,
  [...r.cells[2].querySelectorAll("button")].map((b) => b.getAttribute("aria-pressed"))]));
for (const [row, column] of [[1, 1], [2, 1], [3, 2], [4, 2]]) {
  await press(arenaPage, `.run-players tbody tr:nth-child(${row}) td:nth-child(3) button:nth-child(${column})`);
  await arenaPage.waitForFunction((n) => document.querySelectorAll('.run-players tbody tr td:nth-child(3) button[aria-pressed="true"]').length === n, {}, row);
}
const joined = arenaCalls.filter((c) => c.action === "arenaJoin").map((c) => [c.id, c.sections]);
JSON.stringify(joined) === JSON.stringify([["11111111", '["Classical"]'], ["22222222", '["Classical"]'], ["33333333", '["Blood Pact"]'], ["44444444", '["Blood Pact"]']])
  && (await rowsOf()).every((r) => r[1].startsWith("Waiting since 11:00"))
  ? pass("TD desk makes players available in the sections chosen") : fail(`TD desk arena availability: ${JSON.stringify({ joined, rows: await rowsOf() })}`);
// Pairing starts the Classical game and leaves the Blood Pact section to challenges or the by-hand form.
await press(arenaPage, ".run-arena-pair");
await arenaPage.waitForFunction(() => document.querySelectorAll(".run-arena-games tbody tr").length === 1);
const paired = JSON.parse(arenaCalls.find((c) => c.action === "arenaPair")?.games || "[]");
const pairStatus = await arenaPage.$eval(".run-status", (e) => e.textContent);
const sectionCells = await arenaPage.$$eval(".run-arena-games tbody tr td:nth-child(2)", (cells) => cells.map((c) => [c.textContent, c.hidden]));
JSON.stringify(paired) === JSON.stringify([{ white: "11111111", black: "22222222", section: "Classical" }])
  && pairStatus.includes("Blood Pact games start by challenge or by hand") && JSON.stringify(sectionCells) === JSON.stringify([["Classical", false]])
  ? pass("TD desk pairs the players waiting in each section but the Blood Pact one, and says so") : fail(`TD desk arena pairing: ${JSON.stringify({ paired, pairStatus, sectionCells })}`);
// Game 1 ends 1–0; both are waiting again, and don't meet again at once.
await press(arenaPage, ".run-arena-games tbody tr:first-child .td-buttons button:first-child");
await arenaPage.waitForFunction(() => document.querySelectorAll(".run-arena-games tbody tr").length === 0);
const after = await rowsOf();
await press(arenaPage, ".run-arena-pair");
await arenaPage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("just played each other"));
JSON.stringify(after.map((r) => [r[0], r[1].slice(0, 7)])) === JSON.stringify([["Ann", "Waiting"], ["Ben", "Waiting"], ["Cal", "Waiting"], ["Dee", "Waiting"]])
  && arenaCalls.filter((c) => c.action === "arenaPair").length === 1
  ? pass("TD desk shows both players waiting again and doesn't pair a rematch at once")
  : fail(`TD desk arena after a result: ${JSON.stringify(after)}`);
// A Blood Pact game by hand: once that section is chosen, the form asks who halves their clock.
const halvesHidden = await arenaPage.$eval("#run-arena-halves", (e) => e.hidden);
await arenaPage.select("#run-arena-white", "33333333");
await arenaPage.select("#run-arena-black", "44444444");
await arenaPage.select("#run-arena-section", "Blood Pact");
await arenaPage.waitForFunction(() => !document.querySelector("#run-arena-halves").hidden);
await press(arenaPage, ".run-arena-start button[type=submit]");
await arenaPage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Who halves their clock?"));
await arenaPage.select("#run-arena-halves", "white");
await press(arenaPage, ".run-arena-start button[type=submit]");
await arenaPage.waitForFunction(() => document.querySelectorAll(".run-arena-games tbody tr").length === 1);
const byHand = JSON.parse(arenaCalls.filter((c) => c.action === "arenaPair").at(-1)?.games || "[]");
const halved = await arenaPage.$$eval(".run-arena-games tbody tr:first-child input[type=radio]", (rs) => rs.map((r) => r.checked));
halvesHidden && JSON.stringify(byHand) === JSON.stringify([{ white: "33333333", black: "44444444", section: "Blood Pact", whitePact: true, blackPact: false }])
  && JSON.stringify(halved) === JSON.stringify([true, false])
  ? pass("TD desk starts a Blood Pact game by hand once told who halves their clock, and shows who did")
  : fail(`TD desk arena by hand: ${JSON.stringify({ halvesHidden, byHand, halved })}`);
// The desk moves the Blood Pact to Dee, and the players report her win: 2 points and the bonus.
await press(arenaPage, ".run-arena-games tbody tr:first-child td:nth-child(4) input[type=radio]");
await arenaPage.waitForFunction(() => document.querySelector(".run-arena-games tbody tr:first-child td:nth-child(4) input[type=radio]:checked:not(:disabled)"));
const moved = arenaCalls.find((c) => c.action === "arenaPact");
arena.games[1].reports = { white: "0-1", black: "0-1" };
await press(arenaPage, ".run-arena-refresh");
await arenaPage.waitForSelector(".run-arena-confirm:not([hidden])");
const reportedCell = await arenaPage.$eval(".run-arena-games tbody tr:first-child td:nth-child(5)", (c) => c.textContent);
await press(arenaPage, ".run-arena-confirm");
await arenaPage.waitForFunction(() => document.querySelectorAll(".run-arena-done tbody tr").length === 2);
const confirmed = arenaCalls.filter((c) => c.action === "arenaResult").at(-1);
const board = await arenaPage.$$eval(".run-leaderboard tbody tr", (rows) => rows.map((r) => [...r.cells].map((c) => c.textContent)));
const boards = await arenaPage.$$eval(".run-arena-boards h4", (hs) => hs.map((h) => h.textContent));
moved && moved.game === "2" && moved.who === "black" && reportedCell === "0–1 by both" && confirmed.game === "2" && confirmed.result === "0-1"
  && JSON.stringify(board.slice(0, 2)) === JSON.stringify([["1", "Dee", "Unrated", "3", "1", "1"], ["2", "Ann", "1900", "2", "1", "1"]])
  && board.slice(2).every((r) => r[0] === "3 (tied)" && r[3] === "0")
  && JSON.stringify(boards) === JSON.stringify(["Classical, G/30;+30", "Blood Pact, G/15;+15 against G/30;+30 (not US Chess rated)", "Rapid, G/15;+15"])
  ? pass("TD desk moves the Blood Pact, confirms the players' agreed report, and scores the win with its bonus, with ties shared")
  : fail(`TD desk arena reports and leaderboard: ${JSON.stringify({ moved, reportedCell, confirmed, board, boards })}`);
const doneRows = await arenaPage.$$eval(".run-arena-done tbody tr", (rows) => rows.map((r) => [r.cells[0].textContent, r.cells[1].textContent, r.cells[3].textContent]));
JSON.stringify(doneRows) === JSON.stringify([["2 (not rated: section not US Chess rated)", "Blood Pact", "Dee (unrated) Blood Pact, game 2, black"], ["1", "Classical", "Ben (1700)"]])
  ? pass("TD desk marks a Blood Pact section's games as ones US Chess won't rate") : fail(`TD desk finished games: ${JSON.stringify(doneRows)}`);
// Rename Rapid.
await arenaPage.$eval(".run-arena-sections-wrap", (d) => { d.open = true; });
await arenaPage.$eval(".run-arena-sections-form .run-arena-section-row:nth-child(3) .run-arena-section-name", (input) => { input.value = "Bullet"; });
await press(arenaPage, ".run-arena-sections-form button[type=submit]");
await arenaPage.waitForFunction(() => document.querySelector(".run-status").textContent.includes("Sections: Classical, Blood Pact, Bullet"));
const renamed = JSON.parse(arenaCalls.find((c) => c.action === "arenaSections")?.sections || "[]");
renamed.length === 3 && renamed[2].from === "Rapid" && renamed[2].name === "Bullet" && renamed[1].rated === false && renamed[1].pact === true && renamed[0].timeControl === "G/30;+30"
  ? pass("TD desk renames an arena section") : fail(`TD desk arena sections: ${JSON.stringify(renamed)}`);
for (const scheme of ["light", "dark"]) {
  await arenaPage.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await arenaPage.evaluate(axeSource);
  const result = await arenaPage.evaluate(() => axe.run());
  result.violations.length ? fail(`TD desk running an arena (${scheme}): ${result.violations.map((v) => `${v.id} at ${v.nodes[0].target}`).join(", ")}`)
    : pass(`TD desk running an arena has no axe violations (${scheme})`);
}
await arenaPage.setViewport({ width: 390, height: 844 });
await fitsPhone(arenaPage, "TD desk running an arena");
await arenaPage.close();

await done();
