// The Register form, the home page's register cards, and the TD desk's entries, against a stand-in for the script.
import { axeSource, base, browser, clubEvents, done, fail, mocked, offline, pass, press, seriesPages } from "./common.mjs";

// Registration, against a stand-in for the Apps Script: register.js is served with its
// ENDPOINT pointed at it, whatever the real one is.
const registration = await browser.newPage();
registration.on("pageerror", (error) => fail(`JavaScript error on ${registration.url()}: ${error.message}`));
const posted = [];
await registration.setRequestInterception(true);
registration.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
  } else if (url.host === "registration.test") {
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (request.method() === "POST") {
      const sent = Object.fromEntries(new URLSearchParams(request.postData()));
      posted.push(sent);
      // Kid's answer is in the wording of the script deployed before 2026-10-10, which has no " for …".
      const message = sent.last === "Kid" ? `Test ${sent.last} is registered. A confirmation is on its way to ${sent.email}.`
        : `Test ${sent.last} is registered for Saturday, November 7, 2026. Due when you arrive: $15 (adult).`;
      const answer = sent.last === "Twin" ? { error: "Test Twin is already registered for Saturday, November 7, 2026." } : { ok: true, message };
      request.respond({ headers, contentType: "application/json", body: JSON.stringify(answer) });
    } else {
      const entries = [{ name: "Test Player", id: "12345678", rating: "1500" }, { name: "New Player", id: "87654321", rating: "" }];
      request.respond({ headers, contentType: "application/json", body: JSON.stringify({ entries }) });
    }
  } else {
    request.continue();
  }
});
// Free events have no Register form.
const registerPath = seriesPages.find((p) => clubEvents.filter((e) => e.page === p && !e.tags?.includes("free")).length > 1) || seriesPages[0];
if (registerPath) {
  await registration.goto(base + registerPath, { waitUntil: "networkidle0" });
  const rows = await registration.$$eval(".entries tbody tr", (r) => r.map((x) => x.textContent));
  rows.length === 2 && rows[1].includes("Unrated") ? pass(`${registerPath} lists the entries`)
    : fail(`${registerPath} entries: ${JSON.stringify(rows)}`);
  await registration.type("#register-id", "12345678");
  await registration.type("#register-last", "Player");
  await registration.type("#register-email", "test@example.com");
  await registration.type("#register-phone", "970 555 0123");
  await registration.click(".register-form button[type=submit]");
  await registration.waitForFunction(() => document.querySelector(".register-status").textContent.includes("registered"));
  const sent = posted[0] || {};
  sent.event === registerPath.split("/").filter(Boolean).pop() && /^\d{4}-\d\d(-\d\d)?$/.test(sent.date)
    && sent.id === "12345678" && sent.last === "Player" && sent.email === "test@example.com" && sent.phone === "970 555 0123" && !sent.website
    && !("uschess-id" in sent) ? pass(`${registerPath} sends the registration`) : fail(`${registerPath} sent ${JSON.stringify(sent)}`);

  // Remembered players: a second registration goes first in the list, and after a reload
  // each fills the form in one tap and can be forgotten.
  await registration.type("#register-id", "87654321");
  await registration.type("#register-last", "Kid");
  await registration.$eval("#register-phone", (p) => { p.value = ""; });
  await registration.click(".register-form button[type=submit]");
  await registration.waitForFunction(() => document.querySelector(".register-status").textContent.startsWith("Test Kid"));
  await registration.reload({ waitUntil: "networkidle0" });
  const saved = () => registration.$$eval(".register-saved:not([hidden]) .register-pick", (b) => b.map((x) => x.textContent));
  const shown = await saved();
  JSON.stringify(shown) === JSON.stringify(["Test Kid (87654321)", "Test Player (12345678)"])
    ? pass(`${registerPath} offers the players registered here, most recent first`) : fail(`${registerPath} saved players: ${JSON.stringify(shown)}`);
  const onLoad = await registration.evaluate(() => [document.querySelector("#register-id").value, document.querySelector("#register-last").value]);
  JSON.stringify(onLoad) === JSON.stringify(["87654321", "Kid"])
    ? pass(`${registerPath} fills in the most recent saved player when it opens`) : fail(`${registerPath} on load: ${JSON.stringify(onLoad)}`);
  await registration.click(".register-saved li:nth-child(2) .register-pick");
  const filled = await registration.evaluate(() => ({ id: document.querySelector("#register-id").value,
    last: document.querySelector("#register-last").value, email: document.querySelector("#register-email").value,
    phone: document.querySelector("#register-phone").value, website: document.querySelector("#register-website").value, focus: document.activeElement.matches("#register-date, button[type=submit]") }));
  filled.id === "12345678" && filled.last === "Player" && filled.email === "test@example.com" && filled.phone === "970 555 0123"
    && !filled.website && filled.focus
    && posted.length === 2 ? pass(`${registerPath} fills in a saved player without registering`) : fail(`${registerPath} filled ${JSON.stringify(filled)}`);
  const reordered = await saved();
  JSON.stringify(reordered) === JSON.stringify(["Test Player (12345678)", "Test Kid (87654321)"])
    ? pass(`${registerPath} moves the player picked to the front of the saved list`) : fail(`${registerPath} after a pick: ${JSON.stringify(reordered)}`);
  for (const scheme of ["light", "dark"]) {
    await registration.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await registration.evaluate(axeSource);
    const result = await registration.evaluate(() => axe.run({ include: ["#register", "#entries"] }));
    result.violations.length ? fail(`${registerPath} form (${scheme}): ${result.violations.map((v) => v.id).join(", ")}`)
      : pass(`${registerPath} form with saved players has no axe violations (${scheme})`);
  }
  await registration.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await registration.click(".register-saved li:nth-child(2) .register-forget");
  const afterForget = await registration.evaluate(() => ({ stored: localStorage.getItem("lccc-register-players"),
    focus: document.activeElement.textContent, said: document.querySelector(".register-status").textContent }));
  JSON.stringify(await saved()) === JSON.stringify(["Test Player (12345678)"]) && !afterForget.stored.includes("87654321")
    && afterForget.focus === "Test Player (12345678)" && afterForget.said.includes("no longer saved")
    ? pass(`${registerPath} forgets a saved player`) : fail(`${registerPath} after Forget: ${JSON.stringify(afterForget)}`);
  await registration.click(".register-saved li:first-child .register-forget");
  const empty = await registration.evaluate(() => ({ hidden: document.querySelector(".register-saved").hidden,
    stored: localStorage.getItem("lccc-register-players"), focus: document.activeElement.id }));
  empty.hidden && empty.stored === null && empty.focus === "register-id"
    ? pass(`${registerPath} hides the list when the last saved player is forgotten`) : fail(`${registerPath} after the last Forget: ${JSON.stringify(empty)}`);
  // The fields still hold the player filled in above.
  await registration.click("#register-remember");
  await registration.click(".register-form button[type=submit]");
  await registration.waitForFunction(() => document.querySelector(".register-status").textContent.startsWith("Test Player is registered"));
  await registration.reload({ waitUntil: "networkidle0" });
  const unremembered = await registration.evaluate(() => ({ hidden: document.querySelector(".register-saved").hidden,
    stored: localStorage.getItem("lccc-register-players"), checked: document.querySelector("#register-remember").checked }));
  posted.length === 3 && unremembered.hidden && unremembered.stored === null && unremembered.checked
    ? pass(`${registerPath} doesn't save a player when Remember is unchecked`) : fail(`${registerPath} unchecked Remember: ${JSON.stringify(unremembered)}`);
  // A player already registered is saved too: the script has accepted their ID and last name.
  for (const [field, value] of [["#register-id", "11223344"], ["#register-last", "Twin"], ["#register-email", "twin@example.com"]]) {
    await registration.$eval(field, (input) => { input.value = ""; });
    await registration.type(field, value);
  }
  await registration.click(".register-form button[type=submit]");
  await registration.waitForFunction(() => document.querySelector(".register-status").textContent.includes("already registered"));
  const twin = await registration.evaluate(() => JSON.parse(localStorage.getItem("lccc-register-players") || "[]"));
  twin.length === 1 && twin[0].id === "11223344" && twin[0].name === "Test Twin"
    ? pass(`${registerPath} saves a player who is already registered`) : fail(`${registerPath} already registered: ${JSON.stringify(twin)}`);
  await registration.evaluate(() => localStorage.clear());
}

// Byes asked for when registering, each a half-point bye. A Swiss's Register form offers its rounds, with the times
// its description gives, and sends those checked as one value; its entry list shows each player's byes. A club
// night's offers a month's nights only while that month is chosen, and sends their dates.
const fillPlayer = async (tab) => {
  for (const [field, value] of [["#register-id", "12345678"], ["#register-last", "Player"], ["#register-email", "test@example.com"]]) {
    await tab.$eval(field, (input) => { input.value = ""; });
    await tab.type(field, value);
  }
};
const datesByPage = seriesPages.map((p) => clubEvents.filter((e) => e.page === p));
const swissDates = datesByPage.find(([e]) => e?.tags.includes("tournament") && Number(e.rounds) && !["quad", "arena"].includes(e.pairing));
if (swissDates) {
  const [swiss] = swissDates;
  const sentSwiss = [];
  const swissPage = await mocked(`${swiss.page} with byes`, (p) => {
    if (p.entries) return { entries: [{ name: "Ann Example", id: "12345678", rating: "1500", byes: ["2", "4"] }, { name: "Ben Example", id: "22345678", rating: "1200" }] };
    sentSwiss.push(p);
    return { ok: true, name: "Test Player", message: "Test Player is registered for Saturday, November 7, 2026, with a half-point bye." };
  });
  await swissPage.goto(base + swiss.page, { waitUntil: "networkidle0" });
  const times = Object.fromEntries([...swiss.description.matchAll(/^\s*[•*-]\s+Round (\d+): (\d{1,2}:\d\d [AP]M)/gm)].map((m) => [m[1], m[2]]));
  const rounds = [...Array(Number(swiss.rounds))].map((_, i) => `Round ${i + 1}${times[i + 1] ? `, ${times[i + 1]}` : ""}`);
  const offered = await swissPage.$$eval("[name=byes] + label", (labels) => labels.map((l) => l.textContent));
  const listed = await swissPage.$$eval("#entries tr", (rows) => rows.map((r) => r.lastElementChild.textContent));
  const picked = [...new Set(["1", swiss.rounds])];
  await fillPlayer(swissPage);
  for (const round of picked) await press(swissPage, `#register-bye-${round}`);
  await press(swissPage, ".register-form button[type=submit]");
  await swissPage.waitForFunction(() => document.querySelector(".register-status").textContent.includes("registered"));
  const left = await swissPage.$$eval("[name=byes]:checked", (boxes) => boxes.length);
  JSON.stringify(offered) === JSON.stringify(rounds) && JSON.stringify(listed) === JSON.stringify(["Byes", "Rounds 2 and 4", ""])
    && sentSwiss.length === 1 && sentSwiss[0].byes === picked.join(", ") && left === 0
    ? pass(`${swiss.page} offers the rounds to miss (${offered.join("; ")}), sends those checked, and lists each player's byes`)
    : fail(`${swiss.page} byes: ${JSON.stringify({ offered, rounds, listed, sent: sentSwiss, left })}`);
  await swissPage.evaluate(() => localStorage.clear());
  await swissPage.close();
}
const nightDates = datesByPage.find(([e]) => e?.tags.includes("rated") && !e.tags.includes("tournament"));
if (nightDates) {
  const { page: nightPath, start } = nightDates[0];
  const month = start.slice(0, 7);
  const nights = nightDates.filter((e) => e.start.startsWith(month)).map((e) => e.start.slice(0, 10));
  const sentNights = [];
  const nightPage = await mocked(`${nightPath} with byes`, (p) => {
    if (p.entries) return { entries: [] };
    sentNights.push(p);
    return { ok: true, name: "Test Player", message: "Test Player is registered." };
  });
  await nightPage.goto(`${base}${nightPath}?date=${month}`, { waitUntil: "networkidle0" });
  const offeredNights = () => nightPage.$$eval("fieldset[data-month]", (sets) => sets.filter((s) => !s.hidden && !s.disabled)
    .map((s) => [...s.querySelectorAll("[name=byes]")].map((b) => b.value)));
  const checkNights = async () => {
    for (const night of nights) await press(nightPage, `#register-bye-${night}`);
    await fillPlayer(nightPage);
    await nightPage.$eval(".register-status", (s) => { s.textContent = ""; });
  };
  const forMonth = await offeredNights();
  await checkNights();
  // Checked for the month, then a night chosen instead: the night is registered without them.
  await nightPage.select("#register-date", nights[0]);
  const forNight = await offeredNights();
  await press(nightPage, ".register-form button[type=submit]");
  await nightPage.waitForFunction(() => document.querySelector(".register-status").textContent.includes("registered"));
  await nightPage.select("#register-date", month);
  await checkNights();
  await press(nightPage, ".register-form button[type=submit]");
  await nightPage.waitForFunction(() => document.querySelector(".register-status").textContent.includes("registered"));
  JSON.stringify(forMonth) === JSON.stringify([nights]) && JSON.stringify(forNight) === "[]" && sentNights.length === 2
    && sentNights[0].date === nights[0] && !("byes" in sentNights[0]) && sentNights[1].date === month && sentNights[1].byes === nights.join(", ")
    ? pass(`${nightPath} offers the nights to miss only for a whole month, and sends their dates (${sentNights[1].byes})`)
    : fail(`${nightPath} byes: ${JSON.stringify({ forMonth, forNight, nights, sent: sentNights })}`);
  await nightPage.evaluate(() => localStorage.clear());
  await nightPage.close();
}

// The home page's register cards. Through a month's second Monday the club night card asks
// players to register for the month, then to drop in; the clock is set an hour before each case.
const clubNights = clubEvents.filter((e) => !e.tags.includes("tournament") && e.tags.includes("rated"));
const ordinal = (e) => Math.ceil(Number(e.start.slice(8, 10)) / 7);
for (const [night, expected] of [[clubNights.find((e) => ordinal(e) <= 2), /^Register for /],
                                 [clubNights.find((e) => ordinal(e) > 2), /^Drop in /]]) {
  if (!night) continue;
  const home = await browser.newPage();
  const clock = new Date(night.start).getTime() - 3600000;
  await home.evaluateOnNewDocument((fixed) => {
    const RealDate = Date;
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    };
  }, clock);
  await home.goto(base + "/", { waitUntil: "networkidle0" });
  const cards = await home.evaluate(() => [...document.querySelectorAll(".next-card")]
    .map((c) => ({ hidden: c.hidden, title: c.querySelector(".next-title").textContent, href: c.getAttribute("href") })));
  const saturday = clubEvents.find((e) => e.tags.includes("tournament") && new Date(e.start) > clock);
  expected.test(cards[0].title) && cards[0].href.startsWith(night.page)
    && (!saturday || cards[1].href === `${saturday.page}?date=${saturday.start.slice(0, 10)}#register`)
    ? pass(`home page before ${night.start.slice(0, 10)}: "${cards[0].title}", "${cards[1].title}"`)
    : fail(`home page before ${night.start.slice(0, 10)}: ${JSON.stringify(cards)}`);
  await home.close();
}

// The TD desk, against a stand-in for the Apps Script: sign in, find a player by name,
// register them, mark them paid, log an incident, and remove an entry.
const desk = await browser.newPage();
// A stand-in for the browser's password manager, to see what the desk offers it.
await desk.evaluateOnNewDocument(() => {
  window.stored = [];
  window.PasswordCredential = class { constructor(data) { Object.assign(this, data); } };
  Object.defineProperty(navigator, "credentials", { value: { store: async (c) => { window.stored.push(c); } } });
});
desk.on("pageerror", (error) => fail(`JavaScript error on /td/: ${error.message}`));
const deskCalls = [];
const deskHosts = new Set();
await desk.setRequestInterception(true);
desk.on("request", async (request) => {
  const url = new URL(request.url());
  deskHosts.add(url.host);
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
  } else if (url.host === "registration.test") {
    const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
    deskCalls.push(p);
    const body = p.password !== "secret" ? { error: "Wrong password.", login: true }
      : { login: { ok: true },
          choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" }] },
          people: { players: [{ id: "12345678", name: "Test Player", state: "", rating: "1500", expires: "2027-01-31", known: true,
            email: "test@example.com", phone: "970-555-0100" }] },
          contacts: { headings: ["Name", "Email", "Phone", "Status", "Notes", "US Chess ID"],
            contacts: [{ id: "c1", Name: "Cora Contact", Email: "cora@example.com", Phone: "970-555-0103", Status: "Player", Notes: "", "US Chess ID": "" }] },
          contactSave: { ok: true, id: "c1", message: "Cora Contact is saved." },
          contactDelete: { ok: true, message: "Cora Contact is deleted." },
          refresh: { ok: true, message: "Refreshed 3 entry lists and 1 tournament." },
          search: { players: [{ id: "87654321", name: "Zed Newcomer", state: "CO", rating: "1100", expires: "2027-01-31" }] },
          register: { ok: true, message: "Test Player is registered." },
          entries: { entries: [{ name: "Test Player", id: "12345678", rating: "1500", for: "Whole month", category: "Adult", amount: "16.50", due: "16.50", card: "17.42", email: "", expires: "2027-01-31", token: "t1", date: "2026-10" },
            { name: "Night Player", id: "22345678", rating: "1400", for: "Monday, October 12", category: "Senior (65+)", amount: "5.50", due: "5.50", card: "6.14", email: "night@example.com", phone: "970-555-0102", expires: "2027-01-31", token: "t2", date: "2026-10-12" }] },
          remove: { message: "Test Player is withdrawn." },
          paid: { ok: true, message: "Test Player paid $15." },
          ledger: { ledger: { received: { cash: "15", check: "0", card: "0", other: "0" }, entry: "13", rating: "2", card: "0", games: 6, uschess: "3" } },
          incident: { ok: true, message: "Logged: Game loss, Test Player." },
          incidents: { incidents: [] },
          tournament: { tournament: null } }[p.action];
    // Registering answers slowly, like the real script, so a second player can be entered meanwhile.
    if (p.action === "register") await new Promise((resolve) => setTimeout(resolve, 1500));
    request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
  } else {
    request.continue();
  }
});
desk.on("dialog", (d) => d.accept(d.type() === "prompt" ? d.defaultValue() : undefined));
await desk.goto(base + "/td/", { waitUntil: "networkidle0" });
await desk.type("#td-password", "secret");
await desk.click(".td-login button");
await desk.waitForSelector(".td-desk:not([hidden])");
const offered = await desk.evaluate(() => window.stored.map((c) => [c.id, c.password]));
const usernameField = await desk.$eval('.td-login input[autocomplete="username"]', (i) => i.value).catch(() => null);
JSON.stringify(offered) === JSON.stringify([["TD desk", "secret"]]) && usernameField === "TD desk"
  ? pass("TD desk offers the password to the browser's password manager after signing in")
  : fail(`TD desk password saving: ${JSON.stringify({ offered, usernameField })}`);
const accountButtons = await desk.$$(".td-google, #td-login-email");
!deskHosts.has("www.gstatic.com") && !accountButtons.length
  ? pass("TD desk without FIREBASE signs in by password and loads nothing from Google")
  : fail(`TD desk without FIREBASE: ${JSON.stringify({ hosts: [...deskHosts], accountButtons: accountButtons.length })}`);
await desk.waitForFunction(() => document.querySelector(".td-entries-status").textContent.includes("Still owed: $22"));
await desk.type("#td-player", "test pl");
await desk.waitForSelector("#td-players:not([hidden]) [role=option]");
await desk.keyboard.press("ArrowDown");
await desk.keyboard.press("Enter");
await desk.click(".td-register button[type=submit]");
// While the first saves, the form is clear and takes the next player.
const whileSaving = await desk.evaluate(() => ({ field: document.querySelector("#td-player").value,
  pending: document.querySelectorAll(".td-saving .td-save-pending").length }));
await desk.type("#td-player", "test pl");
await desk.waitForSelector("#td-players:not([hidden]) [role=option]");
await desk.keyboard.press("ArrowDown");
await desk.keyboard.press("Enter");
await desk.click(".td-register button[type=submit]");
await desk.waitForFunction(() => document.querySelectorAll(".td-saving .td-save-done").length === 2);
// A name nobody has registered with offers to ask US Chess, and only asks when pressed; a full
// ID nobody has registered with goes to US Chess on its own.
const searchesBefore = deskCalls.filter((c) => c.action === "search").length;
await desk.type("#td-player", "zed");
await desk.waitForSelector(".td-uschess:not([hidden])");
const askedWhileTyping = deskCalls.filter((c) => c.action === "search").length - searchesBefore;
await desk.click(".td-search-uschess");
await desk.waitForFunction(() => [...document.querySelectorAll("#td-players [role=option]")].some((o) => o.textContent.includes("Zed")));
const askedOnPress = deskCalls.filter((c) => c.action === "search").length - searchesBefore;
await desk.$eval("#td-player", (i) => { i.value = ""; });
await desk.type("#td-player", "87654321");
for (let waited = 0; waited < 5000 && deskCalls.filter((c) => c.action === "search").length - searchesBefore < 2; waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const askedForId = deskCalls.filter((c) => c.action === "search").length - searchesBefore;
askedWhileTyping === 0 && askedOnPress === 1 && askedForId === 2
  ? pass("TD desk searches past registrations first, and US Chess only for a new ID or when asked")
  : fail(`TD desk US Chess searches: while typing ${askedWhileTyping}, on press ${askedOnPress}, for an ID ${askedForId}`);
// Typing searches what loaded at sign-in, never the script; a contact who hasn't registered is looked up at US Chess.
await desk.$eval("#td-player", (i) => { i.value = ""; });
await desk.type("#td-player", "cora");
await desk.waitForFunction(() => [...document.querySelectorAll("#td-players [role=option]")].some((o) => o.textContent.includes("Cora Contact")));
const contactOption = await desk.$eval("#td-players [role=option]", (o) => o.textContent);
await desk.keyboard.press("ArrowDown");
await desk.keyboard.press("Enter");
for (let waited = 0; waited < 5000 && !deskCalls.some((c) => c.action === "search" && c.q === "Cora Contact"); waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
!deskCalls.some((c) => c.action === "history") && deskCalls.some((c) => c.action === "people") && contactOption.includes("contact")
  && deskCalls.some((c) => c.action === "search" && c.q === "Cora Contact")
  ? pass("TD desk searches its loaded players and contacts as you type, and looks a contact up at US Chess")
  : fail(`TD desk local search: ${JSON.stringify({ contactOption, calls: deskCalls.map((c) => c.action) })}`);
// The Contacts section: search, edit, add, and delete.
await desk.click(".td-contacts-panel summary");
await desk.type("#td-contacts-search", "cora");
const contactRows = await desk.$$eval(".td-contacts tbody tr", (rows) => rows.map((r) => r.cells[0].textContent));
await desk.click(".td-contacts tbody tr td:last-child button");
await desk.waitForSelector("dialog.td-contact[open]");
const phoneField = await desk.$('dialog.td-contact [name="Phone"]');
await phoneField.click({ clickCount: 3 });
await phoneField.type("970-555-0199");
await desk.click('dialog.td-contact [value="save"]');
await desk.waitForFunction(() => document.querySelector(".td-contacts-status").textContent.includes("saved"));
const saved = deskCalls.filter((c) => c.action === "contactSave").at(-1) || {};
const savedFields = JSON.parse(saved.fields || "{}");
await desk.click(".td-contacts-add");
await desk.waitForSelector("dialog.td-contact[open]");
const addDeleteHidden = await desk.$eval(".td-contact-delete", (b) => b.hidden);
await desk.type('dialog.td-contact [name="Name"]', "New Person");
await desk.click('dialog.td-contact [value="save"]');
for (let waited = 0; waited < 5000 && deskCalls.filter((c) => c.action === "contactSave").length < 2; waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const addedContact = deskCalls.filter((c) => c.action === "contactSave").at(-1) || {};
await desk.waitForFunction(() => !document.querySelector("dialog.td-contact").open);
await desk.click(".td-contacts tbody tr td:last-child button");
await desk.waitForSelector("dialog.td-contact[open]");
await desk.click(".td-contact-delete");
for (let waited = 0; waited < 5000 && !deskCalls.some((c) => c.action === "contactDelete"); waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
JSON.stringify(contactRows) === '["Cora Contact"]' && saved.id === "c1" && savedFields.Phone === "970-555-0199" && savedFields.Name === "Cora Contact"
  && addDeleteHidden && addedContact.id === "" && JSON.parse(addedContact.fields || "{}").Name === "New Person"
  && deskCalls.some((c) => c.action === "contactDelete" && c.id === "c1")
  ? pass("TD desk searches, edits, adds, and deletes contacts")
  : fail(`TD desk contacts: ${JSON.stringify({ contactRows, saved, addedContact, addDeleteHidden })}`);
await desk.waitForFunction(() => !document.querySelector("dialog.td-contact").open);
await desk.click(".td-contacts-panel summary");
await desk.click(".td-refresh");
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.startsWith("Refreshed"));
deskCalls.some((c) => c.action === "refresh") ? pass("TD desk refreshes the public pages' copies") : fail("TD desk didn't ask to refresh");
await desk.$eval("#td-player", (i) => { i.value = ""; i.dispatchEvent(new Event("input")); });
const sentByDesk = deskCalls.find((c) => c.action === "register") || {};
sentByDesk.email === "test@example.com" && sentByDesk.phone === "970-555-0100"
  ? pass("TD desk fills in a known player's email and phone") : fail(`TD desk contact: ${JSON.stringify(sentByDesk)}`);
sentByDesk.event === "club-night" && sentByDesk.date === "2026-10" && sentByDesk.id === "12345678"
  ? pass("TD desk finds a player and registers them") : fail(`TD desk sent ${JSON.stringify(sentByDesk)}`);
whileSaving.field === "" && whileSaving.pending === 1 && deskCalls.filter((c) => c.action === "register").length === 2
  ? pass("TD desk takes the next player while the last one saves") : fail(`TD desk while saving: ${JSON.stringify(whileSaving)}`);
await desk.click(".td-entries tbody tr td:nth-child(9) button");
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.includes("paid $15"));
deskCalls.some((c) => c.action === "paid" && c.token === "t1" && c.amount === "16.50" && c.by === "cash") ? pass("TD desk marks a player paid in cash")
  : fail(`TD desk paid call: ${JSON.stringify(deskCalls.filter((c) => c.action === "paid"))}`);
await desk.waitForSelector(".td-entries tbody tr td:nth-child(9) select:enabled");
await desk.select(".td-entries tbody tr td:nth-child(9) select", "card");
// Paying redraws the entries, and then asks for the Money list; the next click waits for that.
const ledgerCalls = deskCalls.filter((c) => c.action === "ledger").length;
await desk.click(".td-entries tbody tr td:nth-child(9) button");
for (let waited = 0; waited < 5000 && deskCalls.filter((c) => c.action === "ledger").length === ledgerCalls; waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
deskCalls.some((c) => c.action === "paid" && c.token === "t1" && c.amount === "17.42" && c.by === "card")
  ? pass("TD desk takes a card payment, starting from the fee with the card fee")
  : fail(`TD desk card payment: ${JSON.stringify(deskCalls.filter((c) => c.action === "paid"))}`);
const monthButtons = await desk.$$eval(".td-month", (b) => b.map((x) => x.closest("tr").cells[0].textContent));
const registersBefore = deskCalls.filter((c) => c.action === "register").length;
await desk.click(".td-month");
for (let waited = 0; waited < 5000 && deskCalls.filter((c) => c.action === "register").length === registersBefore; waited += 100) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const toMonth = deskCalls.filter((c) => c.action === "register").at(-1);
JSON.stringify(monthButtons) === '["Night Player"]' && toMonth.date === "2026-10" && toMonth.id === "22345678"
  && toMonth.category === "Senior (65+)" && toMonth.email === "night@example.com" && toMonth.phone === "970-555-0102"
  ? pass("TD desk changes a night's entry to the whole month") : fail(`TD desk to month: ${JSON.stringify({ monthButtons, toMonth })}`);
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.includes("registered"));
await desk.waitForSelector(".td-month:enabled");
const money = await desk.$$eval(".td-ledger li", (items) => items.map((i) => i.textContent));
money.length === 4 && money[0].includes("cash $15") && money[2].includes("$3 for the 6 rated games")
  ? pass("TD desk shows the money received by method and how it splits") : fail(`TD desk Money: ${JSON.stringify(money)}`);
await desk.click(".td-entries tbody tr td:nth-last-child(2) button");
await desk.waitForSelector("dialog.td-incident[open]");
await desk.select("#td-action", "Game loss");
await desk.type("#td-round", "2");
await desk.type("#td-reason", "Test reason");
await desk.type("#td-name", "Test TD");
await desk.click('dialog.td-incident [value="log"]');
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.includes("Logged"));
const logged = deskCalls.find((c) => c.action === "incident") || {};
logged.action_taken === "Game loss" && logged.round === "2" && logged.id === "12345678" && logged.td === "Test TD"
  ? pass("TD desk logs an incident") : fail(`TD desk incident: ${JSON.stringify(logged)}`);
await desk.evaluate(axeSource);
const deskAxe = await desk.evaluate(() => axe.run());
deskAxe.violations.length ? fail(`TD desk signed in: ${deskAxe.violations.map((v) => v.id).join(", ")}`)
  : pass("TD desk signed in has no axe violations");
await desk.click(".td-entries tbody tr td:last-child button");
await desk.waitForFunction(() => document.querySelector(".td-register-status").textContent.includes("withdrawn"));
deskCalls.some((c) => c.action === "remove" && c.token === "t1") ? pass("TD desk removes an entry")
  : fail("TD desk didn't remove the entry");
await desk.close();

// Changes from another desk or the website, against a stand-in whose change stamps move: the desk
// reloads what changed, but not while the TD is using a menu in the entries or filling in the start.
const live = await browser.newPage();
live.on("pageerror", (error) => fail(`JavaScript error on /td/ following changes: ${error.message}`));
// The desk checks every ten seconds; here, every tenth of a second.
await live.evaluateOnNewDocument(() => {
  const every = window.setInterval;
  window.setInterval = (f, ms, ...rest) => every(f, ms === 10000 ? 100 : ms, ...rest);
});
const liveCalls = [];
const stamps = { entries: "a", tournaments: "a", contacts: "a" };
const liveEntries = [{ name: "First Player", id: "11111111", rating: "1500", for: "Whole month", category: "Adult", amount: "16.50",
  due: "16.50", card: "17.42", email: "", expires: "2027-01-31", token: "t1", date: "2026-10" }];
await live.setRequestInterception(true);
live.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/register.js") {
    const source = await (await fetch(base + "/register.js")).text();
    request.respond({ contentType: "text/javascript",
      body: offline(source) });
    return;
  }
  if (url.host !== "registration.test") return request.continue();
  const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
  liveCalls.push(p);
  const body = { login: { ok: true, changes: { ...stamps } }, changes: { changes: { ...stamps } },
    choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" }] },
    people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: liveEntries },
    ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
    incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true };
  request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
});
const callsOf = (action) => liveCalls.filter((c) => c.action === action).length;
const rowNames = () => live.$$eval(".td-entries tbody tr", (rows) => rows.map((r) => r.cells[0].textContent));
await live.goto(base + "/td/", { waitUntil: "networkidle0" });
await live.type("#td-password", "secret");
await live.click(".td-login button");
await live.waitForFunction(() => document.querySelectorAll(".td-entries tbody tr").length === 1);
await live.waitForFunction(() => !document.querySelector(".run-start").hidden);
await new Promise((resolve) => setTimeout(resolve, 500));
const quiet = { entries: callsOf("entries"), tournament: callsOf("tournament"), people: callsOf("people") };
quiet.entries === 1 && quiet.tournament === 1 && quiet.people === 1 && callsOf("changes") > 2
  ? pass("TD desk checks for changes and reloads nothing while nothing changes")
  : fail(`TD desk reloaded with nothing changed: ${JSON.stringify(quiet)}`);

liveEntries.push({ ...liveEntries[0], name: "Web Registrant", id: "22222222", token: "t2" });
stamps.entries = "b";
const shown = await live.waitForFunction(() => [...document.querySelectorAll(".td-entries tbody tr")]
  .some((r) => r.cells[0].textContent === "Web Registrant"), { timeout: 3000 }).then(() => true, () => false);
shown && callsOf("people") === 2 ? pass("TD desk shows a registration made elsewhere without a reload")
  : fail(`TD desk didn't show the new registration: ${JSON.stringify(await rowNames())}`);

await live.focus(".td-entries .td-method");
liveEntries.push({ ...liveEntries[0], name: "Held Back", id: "33333333", token: "t3" });
stamps.entries = "c";
await new Promise((resolve) => setTimeout(resolve, 600));
const whileChoosing = await rowNames();
await live.$eval(".td-entries .td-method", (m) => m.blur());
const afterLeaving = await live.waitForFunction(() => [...document.querySelectorAll(".td-entries tbody tr")]
  .some((r) => r.cells[0].textContent === "Held Back"), { timeout: 3000 }).then(() => true, () => false);
!whileChoosing.includes("Held Back") && afterLeaving
  ? pass("TD desk holds a change back while the TD is choosing how someone paid, and shows it after")
  : fail(`TD desk changed the entries under the TD: ${JSON.stringify({ whileChoosing, afterLeaving })}`);

const runLoads = callsOf("tournament");
stamps.tournaments = "b";
const reloaded = await new Promise((resolve) => {
  const started = Date.now();
  const check = () => (callsOf("tournament") > runLoads ? resolve(true) : Date.now() - started > 3000 ? resolve(false) : setTimeout(check, 50));
  check();
});
await live.type("#run-rounds", "5");
await live.$eval("#run-rounds", (i) => i.blur());
const whileStarting = callsOf("tournament");
stamps.tournaments = "c";
await new Promise((resolve) => setTimeout(resolve, 600));
reloaded && callsOf("tournament") === whileStarting && (await live.$eval("#run-rounds", (i) => i.value)) === "5"
  ? pass("TD desk reloads a tournament changed elsewhere, but not over a start being filled in")
  : fail(`TD desk tournament reloads: ${JSON.stringify({ reloaded, before: whileStarting, after: callsOf("tournament") })}`);
await live.close();

// With LIVE_DB set, the desk follows the change stamps in the database instead of asking the script
// every ten seconds (here a tenth of a second), and asks again only while the stream is down.
const followDesk = async (stream) => {
  const state = { calls: [], stamps: { entries: "a", tournaments: "a", contacts: "a" },
    entries: [{ ...liveEntries[0], name: "First Player" }] };
  const tab = await mocked("/td/ following the live database", (p) => {
    state.calls.push(p);
    return { login: { ok: true, changes: { ...state.stamps } }, changes: { changes: { ...state.stamps } },
      choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" }] },
      people: { players: [] }, contacts: { headings: ["Name"], contacts: [] }, entries: { entries: state.entries },
      ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
      incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true };
  }, null, (path) => (path === "/changes" ? stream(state) : null));
  await tab.evaluateOnNewDocument(() => {
    const every = window.setInterval;
    window.setInterval = (f, ms, ...rest) => every(f, ms === 10000 ? 100 : ms, ...rest);
  });
  await tab.goto(base + "/td/", { waitUntil: "domcontentloaded" });
  await tab.type("#td-password", "secret");
  await tab.click(".td-login button");
  await tab.waitForFunction(() => document.querySelectorAll(".td-entries tbody tr").length === 1);
  state.tab = tab;
  state.callsOf = (action) => state.calls.filter((c) => c.action === action).length;
  state.registers = async (name) => {
    state.entries = [...state.entries, { ...state.entries[0], name, token: name }];
    state.stamps = { ...state.stamps, entries: name };
    return tab.waitForFunction((n) => [...document.querySelectorAll(".td-entries tbody tr")].some((r) => r.cells[0].textContent === n),
      { timeout: 3000 }, name).then(() => true, () => false);
  };
  return state;
};
const streamed = await followDesk((state) => [["put", { path: "/", data: state.stamps }], ["keep-alive", null]]);
await new Promise((resolve) => setTimeout(resolve, 1000));
const polledWhileStreaming = streamed.callsOf("changes");
const streamedShown = await streamed.registers("Streamed Registrant");
streamedShown && polledWhileStreaming === 0 && streamed.callsOf("changes") === 0 && streamed.callsOf("people") === 2
  ? pass("TD desk follows the live database's change stamps, reloads the entries on a new one, and doesn't ask the script every ten seconds")
  : fail(`TD desk following the database: ${JSON.stringify({ streamedShown, polledWhileStreaming, people: streamed.callsOf("people") })}`);
await streamed.tab.close();
const unstreamed = await followDesk(() => null);
await new Promise((resolve) => setTimeout(resolve, 600));
const polledWhileDown = unstreamed.callsOf("changes");
const polledShown = await unstreamed.registers("Polled Registrant");
polledWhileDown > 2 && polledShown
  ? pass("TD desk asks the script for changes while the live database refuses the stream")
  : fail(`TD desk without the stream: ${JSON.stringify({ polledWhileDown, polledShown })}`);
await unstreamed.tab.close();

await done();
