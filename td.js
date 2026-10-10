// The TD desk (td/): register players by US Chess ID or name, and remove entries. Every call
// carries the password, which the Apps Script (scripts/registration.gs) checks against its
// TD_PASSWORD property. ENDPOINT comes from register.js.

const login = document.querySelector(".td-login");
const desk = document.querySelector(".td-desk");
const registerForm = document.querySelector(".td-register");
const choice = document.getElementById("td-event");
const playerInput = document.getElementById("td-player");
const playerList = document.getElementById("td-players");
const chosen = document.querySelector(".td-chosen");
const deskStatus = document.querySelector(".td-register-status");
const tdEntriesStatus = document.querySelector(".td-entries-status");
const tdTable = document.querySelector(".td-entries");
let password = "";
let player = null;
let choices = [];

function remembered() {
  try { return sessionStorage.getItem("tdPassword") || ""; } catch { return ""; }
}

function remember(value) {
  try { value ? sessionStorage.setItem("tdPassword", value) : sessionStorage.removeItem("tdPassword"); } catch {}
}

async function call(action, fields = {}) {
  const response = await fetch(ENDPOINT, {
    method: "POST", body: new URLSearchParams({ action, password, ...fields }),
  });
  const result = await response.json();
  if (result.login) signOut(result.error);
  return result;
}

function signOut(message = "") {
  password = "";
  remember("");
  desk.hidden = true;
  login.hidden = false;
  login.querySelector(".td-login-status").textContent = message;
}

async function signIn(value) {
  password = value;
  const result = await call("login");
  if (!result.ok) return false;
  remember(value);
  login.hidden = true;
  desk.hidden = false;
  const { choices: list } = await call("choices");
  choices = list || [];
  const groups = new Map();
  for (const c of choices) {
    if (!groups.has(c.name)) groups.set(c.name, []);
    groups.get(c.name).push(c);
  }
  choice.replaceChildren(...[...groups].map(([name, items]) => {
    const group = document.createElement("optgroup");
    group.label = name;
    for (const c of items) group.append(new Option(c.label[0].toUpperCase() + c.label.slice(1), c.key));
    return group;
  }));
  showDeskEntries();
  return true;
}

login.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = login.querySelector(".td-login-status");
  status.textContent = "Signing in…";
  try {
    if (await signIn(login.elements.password.value)) login.reset();
  } catch {
    status.textContent = "Couldn't reach the registration service. Try again.";
  }
});

document.querySelector(".td-sign-out").addEventListener("click", () => signOut("Signed out."));

// The player search: a combobox whose list fills as you type, by ID or name.
let searchTimer;
let searchCount = 0;
let active = -1;

function setActive(index) {
  const options = [...playerList.children];
  active = Math.max(-1, Math.min(index, options.length - 1));
  options.forEach((o, i) => o.setAttribute("aria-selected", String(i === active)));
  if (active >= 0) {
    playerInput.setAttribute("aria-activedescendant", options[active].id);
    options[active].scrollIntoView({ block: "nearest" });
  } else {
    playerInput.removeAttribute("aria-activedescendant");
  }
}

function closeList() {
  playerList.hidden = true;
  playerInput.setAttribute("aria-expanded", "false");
  setActive(-1);
}

function choose(p) {
  player = p;
  playerInput.value = `${p.name} (${p.id})`;
  const current = choices.find((c) => c.key === choice.value);
  const lapsed = p.expires && current && p.expires < current.first;
  chosen.textContent = `${p.name}, US Chess ID ${p.id}, ${p.state || "no state"}, rating ${p.rating || "unrated"}, `
    + (p.expires ? `membership ${lapsed ? "expires before the event: " : "until "}${p.expires}.` : "no membership on record.");
  closeList();
}

playerInput.addEventListener("input", () => {
  player = null;
  chosen.textContent = "";
  clearTimeout(searchTimer);
  const q = playerInput.value.trim();
  if (q.length < 2) return closeList();
  searchTimer = setTimeout(async () => {
    const mine = ++searchCount;
    const { players = [] } = await call("search", { q });
    if (mine !== searchCount) return;
    playerList.replaceChildren(...players.map((p, i) => {
      const option = document.createElement("li");
      option.id = `td-player-${i}`;
      option.setAttribute("role", "option");
      option.textContent = `${p.name} · ${p.id} · ${p.state || "–"} · ${p.rating || "unrated"}`;
      option.addEventListener("mousedown", (e) => { e.preventDefault(); choose(p); });
      option.player = p;
      return option;
    }));
    if (!players.length) {
      const none = document.createElement("li");
      none.className = "td-none";
      none.textContent = "No players found.";
      playerList.replaceChildren(none);
    }
    playerList.hidden = false;
    playerInput.setAttribute("aria-expanded", "true");
    setActive(-1);
  }, 300);
});

playerInput.addEventListener("keydown", (event) => {
  if (playerList.hidden) return;
  if (event.key === "ArrowDown") { event.preventDefault(); setActive(active + 1); }
  else if (event.key === "ArrowUp") { event.preventDefault(); setActive(active - 1); }
  else if (event.key === "Enter" && active >= 0) { event.preventDefault(); choose(playerList.children[active].player); }
  else if (event.key === "Escape") closeList();
});
playerInput.addEventListener("blur", closeList);

choice.addEventListener("change", () => {
  if (player) choose(player);
  showDeskEntries();
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!player) {
    deskStatus.textContent = "Pick a player from the list first.";
    return playerInput.focus();
  }
  const [eventName, date] = choice.value.split("/");
  const button = registerForm.querySelector("button");
  button.disabled = true;
  deskStatus.textContent = "Registering…";
  try {
    const result = await call("register", {
      event: eventName, date, id: player.id, category: registerForm.elements.category.value,
      email: registerForm.elements.email.value,
    });
    deskStatus.textContent = result.message || result.error;
    if (result.ok) {
      player = null;
      playerInput.value = "";
      chosen.textContent = "";
      registerForm.elements.email.value = "";
      registerForm.elements.category.value = "";
      playerInput.focus();
      showDeskEntries();
    }
  } catch {
    deskStatus.textContent = "Registration didn't go through. Try again.";
  }
  button.disabled = false;
});

async function showDeskEntries() {
  const key = choice.value;
  if (!key) {
    tdEntriesStatus.textContent = "No club events are open.";
    return;
  }
  const [eventName, date] = key.split("/");
  tdEntriesStatus.textContent = "Loading entries…";
  const { entries = [] } = await call("entries", { event: eventName, date });
  if (key !== choice.value) return;
  const total = (field) => entries.reduce((sum, e) => sum + (Number(e[field]) || 0), 0);
  const owed = entries.filter((e) => !e.paid).reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  tdEntriesStatus.textContent = entries.length
    ? `${entries.length} ${entries.length === 1 ? "player" : "players"}. Collected: $${total("paid")}. Still owed: $${owed}.`
    : "No entries yet.";
  const current = choices.find((c) => c.key === key);
  tdTable.tBodies[0].replaceChildren(...entries.map((e) => {
    const row = document.createElement("tr");
    const lapsed = e.expires && current && e.expires < current.first;
    for (const text of [e.name, e.id, e.rating || "Unrated", e.for, e.category || "?",
      e.amount === "" ? "?" : `$${e.amount}`]) {
      row.insertCell().textContent = text;
    }
    // Marking paid asks for the amount, which can differ from the fee under the hardship waiver.
    const paid = document.createElement("button");
    paid.type = "button";
    paid.className = "td-action";
    paid.textContent = e.paid ? `$${e.paid} ✓` : "Mark paid";
    paid.setAttribute("aria-label", e.paid ? `${e.name} paid $${e.paid}; mark unpaid` : `Mark ${e.name} paid`);
    paid.addEventListener("click", async () => {
      let amount = "";
      if (!e.paid) {
        amount = prompt(`Amount ${e.name} paid`, e.amount || "");
        if (amount === null) return;
      } else if (!confirm(`Mark ${e.name} unpaid?`)) {
        return;
      }
      paid.disabled = true;
      const result = await call("paid", { token: e.token, amount });
      deskStatus.textContent = result.message || result.error;
      showDeskEntries();
    });
    row.insertCell().append(paid);
    for (const text of [lapsed ? `Expires ${e.expires}` : e.expires ? "Current" : "None", e.email || ""]) {
      row.insertCell().textContent = text;
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "td-action";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${e.name}`);
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove ${e.name}?`)) return;
      remove.disabled = true;
      const result = await call("remove", { token: e.token });
      deskStatus.textContent = result.message || result.error;
      showDeskEntries();
    });
    row.insertCell().append(remove);
    return row;
  }));
  tdTable.hidden = !entries.length;
}

(async () => {
  const saved = remembered();
  if (!saved || !(await signIn(saved).catch(() => false))) {
    login.hidden = false;
    if (!saved) login.querySelector(".td-login-status").textContent = "";
  }
})();
