import { PHONE, axeBoth, base, clubEvents, deskState, done, fail, fitsPhone, mocked, pass, signIn } from "./common.mjs";

const event = clubEvents.find((e) => e.capacity === 50);
let capacity = 50, count = 50;
const players = () => Array.from({ length: count }, (_, i) => ({ id: String(90000000 + i), name: `Player ${i}`, rating: "1500" }));
const publicPage = await mocked("public registration capacity", () => ({ entries: players(), capacity }));
async function loadPublic() {
  await publicPage.goto(base + event.page, { waitUntil: "networkidle0" });
  await publicPage.waitForFunction(() => !document.querySelector(".entries-status").textContent.includes("Loading"));
  return publicPage.$eval('form.register-form button[type="submit"]', (b) => b.disabled);
}
await loadPublic() ? pass("public registration is disabled at 50 players") : fail("a full date still offers registration");
capacity = 60;
!(await loadPublic()) ? pass("the TD's raised limit overrides the page's default of 50") : fail("the raised limit is ignored");
capacity = 0;
count = 0;
await loadPublic() ? pass("a TD limit of zero closes an empty event") : fail("zero does not close registration");
capacity = null;
count = 50;
!(await loadPublic()) ? pass("an unlimited date remains open") : fail("the page default overrides the server's unlimited value");
await publicPage.close();

capacity = 50;
const state = deskState(null);
const saved = [];
const desk = await mocked("TD registration limit", (p) => {
  if (p.action === "entries") return { entries: [], capacity };
  if (p.action === "registrationLimit") {
    saved.push(p);
    capacity = p.limit === "" ? 50 : Number(p.limit);
    return { ok: true, capacity, message: `Saved limit: ${capacity}` };
  }
  return state.answer(p);
});
await signIn(desk);
await desk.waitForSelector(".td-registration-limit:not([hidden])");
await desk.$eval("#td-registration-limit", (input) => { input.value = "60"; });
await desk.click('.td-registration-limit button[type="submit"]');
await desk.waitForFunction(() => document.querySelector(".td-limit-status").textContent === "Saved limit: 60");
saved[0]?.limit === "60" && saved[0].event === "classic" && saved[0].date === "2026-11-07"
  ? pass("the TD saves the selected date's new limit") : fail("the TD limit request has the wrong date or limit");
await desk.reload({ waitUntil: "networkidle0" });
await desk.waitForSelector(".td-registration-limit:not([hidden])");
(await desk.$eval("#td-registration-limit", (input) => input.value)) === "60"
  ? pass("the saved TD limit appears after reloading") : fail("the saved limit disappears on reload");
await desk.$eval("#td-registration-limit", (input) => { input.value = ""; });
await desk.click('.td-registration-limit button[type="submit"]');
await desk.waitForFunction(() => document.querySelector(".td-limit-status").textContent === "Saved limit: 50");
saved.at(-1)?.limit === "" ? pass("blank restores the calendar default") : fail("the TD cannot restore the default");
await axeBoth(desk, "TD registration limit");
await desk.setViewport(PHONE);
await fitsPhone(desk, "TD registration limit");
await desk.close();
await done();
