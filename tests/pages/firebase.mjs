// Signing in to the TD desk with Firebase Authentication, against stand-ins for the SDK and the script.
import { axeBoth, base, browser, done, fail, fitsPhone, offline, pass } from "./common.mjs";

// With FIREBASE set, TDs sign in with Firebase Authentication. The SDK's modules are served by
// stand-ins with the same functions: an account signs in by the provider or emailed link that
// fake.accounts names, and stays signed in across reloads, as the SDK keeps it. The script's
// stand-in answers each account's ID token as the real script would: a listed TD, an unlisted
// one, or one whose provider hasn't confirmed the email.
const FAKE_CONFIG = { apiKey: "test-key", authDomain: "lccc-test.firebaseapp.com", projectId: "lccc-test", appId: "1:2:web:3" };
const fakeAuthModule = (fake) => `
const fake = ${JSON.stringify(fake)};
const log = (...call) => sessionStorage.setItem("fakeCalls", JSON.stringify([...JSON.parse(sessionStorage.getItem("fakeCalls") || "[]"), call]));
const listeners = [];
const asUser = (data) => data && { ...data, getIdToken: async () => data.token };
// Each tab's own key, since they share localStorage.
const KEY = "fakeUser " + fake.label;
export const auth = { currentUser: asUser(JSON.parse(localStorage.getItem(KEY))) };
function setUser(data) {
  if (data) localStorage.setItem(KEY, JSON.stringify(data));
  else localStorage.removeItem(KEY);
  auth.currentUser = asUser(data);
  for (const listener of listeners) setTimeout(() => listener(auth.currentUser));
}
export function getAuth(app) { log("getAuth", app.options); return auth; }
export class GoogleAuthProvider { providerId = "google.com"; setCustomParameters(p) { this.parameters = p; } }
export class OAuthProvider { constructor(id) { this.providerId = id; } setCustomParameters(p) { this.parameters = p; } }
export async function signInWithPopup(a, provider) {
  log("signInWithPopup", provider.providerId, provider.parameters);
  if (fake.popupBlocked) throw Object.assign(new Error("blocked"), { code: "auth/popup-blocked" });
  setUser(fake.accounts[provider.providerId]);
}
export async function signInWithRedirect(a, provider) {
  log("signInWithRedirect", provider.providerId);
  sessionStorage.setItem("fakeRedirect", provider.providerId);
  setTimeout(() => location.reload());
  return new Promise(() => {});
}
export async function getRedirectResult() {
  const id = sessionStorage.getItem("fakeRedirect");
  if (!id) return null;
  sessionStorage.removeItem("fakeRedirect");
  setUser(fake.accounts[id]);
  return { user: auth.currentUser };
}
export async function sendSignInLinkToEmail(a, email, settings) { log("sendSignInLinkToEmail", email, settings); }
export function isSignInWithEmailLink(a, href) { return new URL(href).searchParams.get("mode") === "signIn"; }
export async function signInWithEmailLink(a, email, href) {
  log("signInWithEmailLink", email, new URL(href).searchParams.get("oobCode"));
  if (new URL(href).searchParams.get("oobCode") === "spent") throw Object.assign(new Error("spent"), { code: "auth/invalid-action-code" });
  setUser({ ...fake.accounts.email, email });
}
export function onAuthStateChanged(a, listener) {
  listeners.push(listener);
  if (!fake.stalled) setTimeout(() => listener(auth.currentUser));
  return () => listeners.splice(listeners.indexOf(listener), 1);
}
export async function sendEmailVerification(user, settings) { log("sendEmailVerification", user.email, settings); }
export async function signOut() { log("signOut"); setUser(null); }
`;
const deskTDs = {
  "token-ada": { ok: true, td: { email: "ada@example.com", name: "Ada Director", usChessId: "12345678" } },
  "token-link": { ok: true, td: { email: "link@example.com", name: "Lin Kemail", usChessId: "" } },
  "token-unlisted": { login: true, error: "outsider@example.com isn't one of the club's TDs." },
  "token-unverified": { verify: true },
};
async function firebaseDesk(label, fake, viewport) {
  // held: a promise by action that its answer waits for.
  const state = { calls: [], gstatic: [], held: {} };
  const tab = await browser.newPage();
  tab.on("pageerror", (error) => fail(`JavaScript error on ${label}: ${error.message}`));
  if (viewport) await tab.setViewport(viewport);
  // Whether a sign-in button has shown since the page loaded, checked whenever something is shown or hidden.
  await tab.evaluateOnNewDocument(() => {
    window.sawSignIn = false;
    new MutationObserver(() => {
      if (document.querySelector(".td-google")?.checkVisibility()) window.sawSignIn = true;
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
  });
  await tab.setRequestInterception(true);
  tab.on("request", async (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/register.js") {
      const source = offline(await (await fetch(base + "/register.js")).text());
      request.respond({ contentType: "text/javascript", body: source.replace(/^const FIREBASE = null;$/m, `const FIREBASE = ${JSON.stringify(FAKE_CONFIG)};`) });
    } else if (url.host === "www.gstatic.com") {
      state.gstatic.push(url.pathname);
      const name = url.pathname.match(/^\/firebasejs\/[\d.]+\/(firebase-app|firebase-auth)\.js$/)?.[1];
      request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "text/javascript",
        body: name === "firebase-app" ? "export const initializeApp = (options) => ({ options });" : name ? fakeAuthModule({ ...fake, label }) : "" });
    } else if (url.host === "registration.test") {
      const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
      state.calls.push(p);
      await state.held[p.action];
      const who = deskTDs[p.idToken] || { login: true, error: "Sign in first." };
      const body = !who.ok ? who : {
        login: { ...who, changes: null },
        choices: { choices: [{ key: "club-night/2026-10", name: "Club Night", label: "all Mondays in October 2026", kind: "month", first: "2026-10-12" }] },
        people: { players: [] }, contacts: { headings: ["Name"], contacts: [] },
        entries: { entries: [{ name: "Test Player", id: "12345678", rating: "1500", for: "Whole month", category: "Adult", amount: "16.50", due: "16.50", card: "17.42", email: "", expires: "2027-01-31", token: "t1", date: "2026-10" }] },
        ledger: { ledger: { received: { cash: "0", check: "0", card: "0", other: "0" }, entry: "0", rating: "0", card: "0", games: null, uschess: "0" } },
        incidents: { incidents: [] }, tournament: { tournament: null } }[p.action] || { ok: true };
      request.respond({ headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(body) });
    } else if (url.host === "127.0.0.1" || url.host === new URL(base).host) {
      request.continue();
    } else {
      request.abort();
    }
  });
  state.tab = tab;
  state.fakeCalls = () => tab.evaluate(() => JSON.parse(sessionStorage.getItem("fakeCalls") || "[]"));
  state.status = () => tab.$eval(".td-login-status", (s) => s.textContent);
  state.sawSignIn = () => tab.evaluate(() => window.sawSignIn);
  state.signedIn = () => tab.waitForSelector(".td-desk:not([hidden])", { timeout: 3000 }).then(() => true, () => false);
  state.signedOut = (text) => tab.waitForFunction((t) => !document.querySelector(".td-login").hidden
    && document.querySelector(".td-desk").hidden && document.querySelector(".td-login-status").textContent.includes(t), { timeout: 3000 }, text)
    .then(() => true, () => false);
  return state;
}

const google = await firebaseDesk("/td/ with Firebase", { accounts: { "google.com": { uid: "ada", email: "ada@example.com", token: "token-ada" } } });
await google.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
const accountForm = await google.tab.evaluate(() => ({
  password: Boolean(document.querySelector(".td-login input[type=password]")),
  buttons: [...document.querySelectorAll(".td-login button")].filter((b) => b.checkVisibility()).map((b) => b.textContent),
  email: document.querySelector(".td-login input[type=email]")?.checkVisibility(),
}));
!accountForm.password && accountForm.email
  && JSON.stringify(accountForm.buttons) === JSON.stringify(["Sign in with Google", "Email me a sign-in link"])
  ? pass("TD desk with Firebase offers Google and an emailed link, and no password")
  : fail(`TD desk Firebase sign-in form: ${JSON.stringify(accountForm)}`);
await axeBoth(google.tab, "TD desk Firebase sign-in form");
await google.tab.setViewport({ width: 390, height: 844 });
await fitsPhone(google.tab, "TD desk Firebase sign-in form");
await google.tab.setViewport({ width: 1100, height: 800 });
await google.tab.click(".td-google");
const googleIn = await google.signedIn();
const googleCalls = google.calls.filter((c) => c.action === "login");
const shownAs = await google.tab.$eval(".td-who", (w) => (w.checkVisibility() ? w.textContent : ""));
const popup = (await google.fakeCalls()).find((c) => c[0] === "signInWithPopup");
googleIn && googleCalls.length === 1 && google.calls.every((c) => c.idToken === "token-ada" && !("password" in c) && !("device" in c))
  && shownAs === "Signed in as Ada Director" && popup?.[2]?.prompt === "select_account"
  ? pass("TD desk signs in with Google, sends the ID token and no password, and shows the TD's name")
  : fail(`TD desk Google sign-in: ${JSON.stringify({ googleIn, googleCalls, shownAs, popup })}`);
const initialized = (await google.fakeCalls()).find((c) => c[0] === "getAuth")?.[1];
JSON.stringify(initialized) === JSON.stringify(FAKE_CONFIG) ? pass("TD desk starts Firebase with FIREBASE from register.js")
  : fail(`TD desk Firebase config: ${JSON.stringify(initialized)}`);
await google.tab.click(".td-entries tbody tr td:nth-last-child(2) button");
await google.tab.waitForSelector("dialog.td-incident[open]");
const incidentTd = await google.tab.$eval("#td-name", (i) => i.value);
incidentTd === "Ada Director" ? pass("TD desk fills in the incident's TD from the sign-in")
  : fail(`TD desk incident TD name: "${incidentTd}"`);
await google.tab.click('dialog.td-incident [value="cancel"]');
await google.tab.reload({ waitUntil: "networkidle0" });
const keptIn = await google.signedIn();
const keptQuietly = !(await google.sawSignIn());
keptIn && keptQuietly && google.calls.filter((c) => c.action === "login").length === 2
  ? pass("TD desk stays signed in with Firebase across a reload, without showing the sign-in buttons")
  : fail(`TD desk with Firebase on reload: ${JSON.stringify({ keptIn, keptQuietly })}`);
await google.tab.click(".td-sign-out");
const outAfter = await google.signedOut("Signed out.");
const outFake = (await google.fakeCalls()).some((c) => c[0] === "signOut");
await google.tab.reload({ waitUntil: "networkidle0" });
const stillOut = !(await google.signedIn());
outAfter && outFake && stillOut ? pass("TD desk's Sign out signs out of Firebase too")
  : fail(`TD desk Firebase sign-out: ${JSON.stringify({ outAfter, outFake, stillOut })}`);
await google.tab.click(".td-google");
await google.signedIn();
await google.tab.evaluate(() => import(performance.getEntriesByType("resource").find((r) => r.name.endsWith("/firebase-auth.js")).name)
  .then((sdk) => sdk.signOut()));
(await google.signedOut("Your sign-in has ended.")) ? pass("TD desk signs out when Firebase ends the session, as when another tab signs out")
  : fail(`TD desk kept the desk open after Firebase ended the session: "${await google.status()}"`);
await google.tab.close();

// The desk asks for the event list while the sign-in is being checked, and for the ledger, incidents,
// and tournament while the entries are, since each call to the script takes a second or more.
const eager = await firebaseDesk("/td/ loading at once", { accounts: { "google.com": { uid: "ada", email: "ada@example.com", token: "token-ada" } } });
const hold = (action) => new Promise((resolve) => { eager.held[action] = new Promise((release) => resolve(release)); });
const releaseLogin = await hold("login");
const releaseEntries = await hold("entries");
const askedFor = async (actions) => {
  for (let i = 0; i < 60 && !actions.every((a) => eager.calls.some((c) => c.action === a)); i++) await new Promise((r) => setTimeout(r, 50));
  return actions.every((a) => eager.calls.some((c) => c.action === a));
};
await eager.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
await eager.tab.click(".td-google");
const choicesEarly = await askedFor(["login", "choices"]);
releaseLogin();
const restEarly = await askedFor(["entries", "ledger", "incidents", "tournament"]);
releaseEntries();
const eagerIn = await eager.signedIn();
const eagerRows = await eager.tab.waitForSelector(".td-entries tbody tr", { timeout: 3000 }).then(() => true, () => false);
choicesEarly && restEarly && eagerIn && eagerRows
  ? pass("TD desk asks for the events with the sign-in, and for the ledger, incidents, and tournament with the entries")
  : fail(`TD desk loading at once: ${JSON.stringify({ choicesEarly, restEarly, eagerIn, eagerRows, calls: eager.calls.map((c) => c.action) })}`);
await eager.tab.close();

// On a phone, Firebase can hang looking for a saved sign-in and never report one; the desk says so,
// without the buttons, since the TD may well be signed in.
const stalled = await firebaseDesk("/td/ with Firebase stalled", { stalled: true, accounts: {} }, { width: 390, height: 844 });
await stalled.tab.goto(base + "/td/", { waitUntil: "load" });
const stalledForm = await stalled.tab.waitForFunction(() => !document.querySelector(".td-login").hidden
  && !document.querySelector(".td-google").checkVisibility()
  && document.querySelector(".td-login-status").textContent.includes("taking too long"), { timeout: 9000 }).then(() => true, () => false);
stalledForm ? pass("TD desk says so, without sign-in buttons, when Firebase never reports a saved sign-in")
  : fail(`TD desk while Firebase stalled: "${await stalled.status()}"`);
await stalled.tab.close();

// A popup the browser blocks falls back to a redirect.
const blocked = await firebaseDesk("/td/ with a blocked popup", { popupBlocked: true,
  accounts: { "google.com": { uid: "ada", email: "ada@example.com", token: "token-ada" } } });
await blocked.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
await blocked.tab.click(".td-google");
const redirected = await blocked.signedIn();
const redirectQuiet = !(await blocked.sawSignIn());
const redirectCalls = (await blocked.fakeCalls()).map((c) => c.slice(0, 2).join(" "));
redirected && redirectQuiet && redirectCalls.includes("signInWithRedirect google.com")
  ? pass("TD desk signs in with Google by redirect when the popup is blocked")
  : fail(`TD desk redirect: ${JSON.stringify({ redirected, redirectQuiet, redirectCalls })}`);
await blocked.tab.close();

const unlisted = await firebaseDesk("/td/ with an unlisted TD", { accounts: {
  "google.com": { uid: "x", email: "outsider@example.com", token: "token-unlisted" } } });
await unlisted.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
await unlisted.tab.click(".td-google");
const refusedOut = await unlisted.signedOut("isn't one of the club's TDs");
const refusedFake = (await unlisted.fakeCalls()).filter((c) => c[0] === "signOut").length;
refusedOut && refusedFake === 1
  ? pass("TD desk signs an unlisted account out of Firebase with the script's message")
  : fail(`TD desk unlisted: ${JSON.stringify({ refusedOut, refusedFake, status: await unlisted.status() })}`);
await unlisted.tab.close();
const unconfirmed = await firebaseDesk("/td/ with an unconfirmed address", { accounts: {
  "google.com": { uid: "u", email: "unverified@example.com", token: "token-unverified" } } });
await unconfirmed.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
await unconfirmed.tab.click(".td-google");
const verifyOut = await unconfirmed.signedOut("Check your email for a link to confirm your address, then sign in again.");
const verifySent = (await unconfirmed.fakeCalls()).find((c) => c[0] === "sendEmailVerification");
verifyOut && verifySent?.[1] === "unverified@example.com" && verifySent[2]?.url === base + "/td/"
  ? pass("TD desk asks the provider to confirm an unconfirmed email and says so")
  : fail(`TD desk verify: ${JSON.stringify({ verifyOut, verifySent, status: await unconfirmed.status() })}`);
await unconfirmed.tab.close();

// The emailed link: asked for here, and opened on this device, and on another, which asks for the address.
const emailed = await firebaseDesk("/td/ by an emailed link", { accounts: { email: { uid: "lin", token: "token-link" } } });
await emailed.tab.goto(base + "/td/", { waitUntil: "networkidle0" });
await emailed.tab.type("#td-login-email", "link@example.com");
await emailed.tab.click(".td-email-link");
await emailed.tab.waitForFunction(() => document.querySelector(".td-login-status").textContent.includes("link@example.com"));
const linkSent = (await emailed.fakeCalls()).find((c) => c[0] === "sendSignInLinkToEmail");
const linkKept = await emailed.tab.evaluate(() => localStorage.getItem("lccc-td-email"));
await emailed.tab.goto(base + "/td/?apiKey=test-key&mode=signIn&oobCode=abc", { waitUntil: "networkidle0" });
const linkedIn = await emailed.signedIn();
const linkQuiet = !(await emailed.sawSignIn());
const completed = (await emailed.fakeCalls()).find((c) => c[0] === "signInWithEmailLink");
const cleaned = await emailed.tab.evaluate(() => ({ search: location.search, kept: localStorage.getItem("lccc-td-email") }));
linkSent?.[1] === "link@example.com" && linkSent[2]?.url === base + "/td/" && linkSent[2]?.handleCodeInApp === true && linkKept === "link@example.com"
  && linkedIn && linkQuiet && JSON.stringify(completed) === JSON.stringify(["signInWithEmailLink", "link@example.com", "abc"])
  && cleaned.search === "" && cleaned.kept === null
  && (await emailed.tab.$eval(".td-who", (w) => w.textContent)) === "Signed in as Lin Kemail"
  ? pass("TD desk sends a sign-in link and signs in when it's opened")
  : fail(`TD desk email link: ${JSON.stringify({ linkSent, linkKept, linkedIn, linkQuiet, completed, cleaned })}`);
await emailed.tab.click(".td-sign-out");
await emailed.signedOut("Signed out.");
await emailed.tab.goto(base + "/td/?apiKey=test-key&mode=signIn&oobCode=def", { waitUntil: "networkidle0" });
const asked = await emailed.status();
const finishLabel = await emailed.tab.$eval(".td-email-link", (b) => b.textContent);
await emailed.tab.type("#td-login-email", "link@example.com");
await emailed.tab.click(".td-email-link");
const otherDevice = await emailed.signedIn();
const completedHere = (await emailed.fakeCalls()).filter((c) => c[0] === "signInWithEmailLink").at(-1);
asked.includes("Enter the email address") && finishLabel === "Finish signing in" && otherDevice && completedHere?.[2] === "def"
  ? pass("TD desk asks for the address when a sign-in link is opened on another device")
  : fail(`TD desk email link elsewhere: ${JSON.stringify({ asked, finishLabel, otherDevice, completedHere })}`);
await emailed.tab.click(".td-sign-out");
await emailed.signedOut("Signed out.");
await emailed.tab.evaluate(() => localStorage.setItem("lccc-td-email", "link@example.com"));
await emailed.tab.goto(base + "/td/?apiKey=test-key&mode=signIn&oobCode=spent", { waitUntil: "networkidle0" });
const spent = await emailed.status();
const spentLeft = await emailed.tab.evaluate(() => location.search);
spent.includes("expired or was already used") && spentLeft === "" && !(await emailed.signedIn())
  ? pass("TD desk says when a sign-in link was already used, and offers a new one")
  : fail(`TD desk spent link: ${JSON.stringify({ spent, spentLeft })}`);
await emailed.tab.close();

await done();
