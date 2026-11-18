// Hold real button requests open so the busy state cannot disappear before it is checked.
import { PHONE, axeBoth, base, clubEvents, deskState, done, fail, fitsPhone, mocked, pass, press, signIn } from "./common.mjs";

const check = (ok, message) => ok ? pass(message) : fail(message);
const waitForRequest = async (requests, action) => {
  const until = Date.now() + 5000;
  while (typeof requests.get(action) !== "function") {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${action}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
let release;
const registration = await mocked("registration busy overlay", (fields) => {
  if (fields.entries) return { entries: [] };
  return new Promise((resolve) => { release = resolve; });
}, PHONE);
const path = clubEvents.find((event) => event.page && !event.tags?.includes("free") && event.tags?.includes("rated")).page;
await registration.goto(base + path, { waitUntil: "networkidle0" });
await registration.type("#register-id", "12345678");
await registration.type("#register-last", "Player");
await registration.type("#register-email", "player@example.com");
await press(registration, ".register-form button[type=submit]");
await registration.waitForSelector(".network-activity[open]");
check(await registration.$eval(".network-activity", (dialog) => dialog.textContent.includes("Registering player")
  && dialog.matches(":modal") && !!dialog.querySelector(".network-spinner")), "registration shows a modal spinner and explains the pending action");
await registration.keyboard.press("Escape");
check(await registration.$eval(".network-activity", (dialog) => dialog.open), "Escape cannot dismiss an unfinished request");
await registration.keyboard.press("Tab");
check(await registration.evaluate(() => !document.activeElement?.closest("form.register-form")), "keyboard cannot reach the form while a request is pending");
await axeBoth(registration, "busy overlay");
await fitsPhone(registration, "busy overlay");
await registration.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
check(await registration.$eval(".network-spinner", (spinner) => getComputedStyle(spinner).animationName === "none"), "busy overlay respects reduced motion");
release({ error: "Registration was refused." });
await registration.waitForSelector(".network-activity:not([open])", { hidden: true });
check(await registration.$eval(".register-status", (status) => status.textContent === "Registration was refused."), "a refused request closes the overlay and leaves its error visible");
await registration.close();

const state = deskState();
const held = new Map();
const desk = await mocked("TD busy overlay", (fields) => {
  if (held.has(fields.action)) return new Promise((resolve) => held.set(fields.action, resolve));
  return state.answer(fields);
});
await signIn(desk);
await desk.waitForSelector(".td-desk:not([hidden])");
await desk.waitForSelector(".network-activity:not([open])", { hidden: true });
held.set("refresh", null);
await press(desk, ".td-refresh");
await desk.waitForSelector(".network-activity[open]");
check(await desk.$eval(".network-activity", (dialog) => dialog.textContent.includes("Refreshing club data")), "TD Refresh shows its network activity");
held.get("refresh")({ ok: true, message: "Refreshed." });
held.delete("refresh");
await desk.waitForSelector(".network-activity:not([open])", { hidden: true });

// Overlapping actions must keep the page blocked until both replies have been read.
held.set("result", null);
held.set("paid", null);
await desk.evaluate(() => {
  window.pendingResults = [call("result"), call("paid")];
});
await desk.waitForFunction(() => document.querySelector(".network-activity").textContent.includes("Saving payment"));
await waitForRequest(held, "result");
await waitForRequest(held, "paid");
held.get("paid")({ ok: true });
held.delete("paid");
await desk.waitForFunction(() => document.querySelector(".network-activity").textContent.includes("Saving result"));
check(await desk.$eval(".network-activity", (dialog) => dialog.open), "finishing one request keeps the overlay up for the other pending request");
held.get("result")({ ok: true });
held.delete("result");
await desk.evaluate(() => Promise.all(window.pendingResults));
await desk.waitForSelector(".network-activity:not([open])", { hidden: true });

// A network error while submitting an open dialog must unblock that dialog too.
await desk.evaluate(() => {
  document.querySelector(".td-contact").showModal();
  const fetchNormally = window.fetch;
  window.fetch = () => Promise.reject(new TypeError("Connection lost"));
  window.failedRequest = call("contactSave").catch(() => {}).finally(() => { window.fetch = fetchNormally; });
});
await desk.evaluate(() => window.failedRequest);
check(await desk.$eval(".network-activity", (dialog) => !dialog.open)
  && await desk.$eval(".td-contact", (dialog) => dialog.matches(":modal")), "a failed request removes the overlay and restores the underlying dialog");
await desk.evaluate(() => document.querySelector(".td-contact").close());

held.set("changes", null);
await desk.evaluate(() => { window.backgroundRequest = call("changes"); });
await waitForRequest(held, "changes");
check(await desk.$eval(".network-activity", (dialog) => !dialog.open), "background polling does not open a blocking overlay");
held.get("changes")({ changes: {} });
held.delete("changes");
await desk.evaluate(() => window.backgroundRequest);
await desk.close();
await done();
