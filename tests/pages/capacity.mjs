import { base, clubEvents, done, fail, mocked, pass } from "./common.mjs";

const event = clubEvents.find((e) => e.page && e.tags.includes("rated") && !e.tags.includes("invitational"));
let capacity = 50;
let entries = Array.from({ length: capacity }, (_, i) =>
  ({ id: String(90000000 + i), name: `Player ${i}`, rating: "1500" }));
const page = await mocked("public registration", () => ({ entries, capacity }));

async function checkRegistration(message) {
  await page.goto(base + event.page, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !document.querySelector(".entries-status").textContent.includes("Loading"));
  const enabled = await page.$eval('form.register-form button[type="submit"]', (button) =>
    !button.form.hidden && !button.disabled);
  enabled ? pass(message) : fail(message);
}

await checkRegistration("registration is available with 50 players and a legacy limit of 50");
capacity = 0;
entries = [];
await checkRegistration("registration is available with a legacy limit of zero");
await page.close();
await done();
