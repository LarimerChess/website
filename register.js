// The Register form and entry list on each club event's page, which scripts/build_pages.py
// writes. Entries are kept by the Apps Script in scripts/registration.gs; see README.md.
// The TD desk (td/) loads this too, for ENDPOINT.

const ENDPOINT = "https://script.google.com/macros/s/AKfycbxEtmbXBQdxAKf5iKpCuHquO3CRadC44VvlEZyUlfGno6E5mEBlLrh1G3dH-MoxrJ6Z/exec";

const form = document.querySelector(".register-form:not(.td-login)");
const status = document.querySelector(".register-status");
const entriesStatus = document.querySelector(".entries-status");
const table = document.querySelector(".entries");
const dateField = form?.elements.date;

const wanted = new URLSearchParams(location.search).get("date");
if (dateField?.tagName === "SELECT" && [...dateField.options].some((o) => o.value === wanted)) dateField.value = wanted;

// Players registered from this browser, most recent first. Storage can throw (a private
// window, blocked site data); then the form works as if nothing were saved.
const SAVED = "lccc-register-players";
const KEEP = 6;
const savedBox = form?.querySelector(".register-saved");
const rememberChoice = form?.querySelector("#register-remember");

function savedPlayers() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED));
    return Array.isArray(list) ? list.filter((p) => /^\d{8}$/.test(p?.id) && typeof p.last === "string" && typeof p.email === "string") : [];
  } catch {
    return [];
  }
}

function storePlayers(list) {
  try {
    if (list.length) localStorage.setItem(SAVED, JSON.stringify(list.slice(0, KEEP)));
    else localStorage.removeItem(SAVED);
    return true;
  } catch {
    return false;
  }
}

function canStore() {
  try {
    localStorage.setItem(`${SAVED}-test`, "1");
    localStorage.removeItem(`${SAVED}-test`);
    return true;
  } catch {
    return false;
  }
}

const playerName = (p) => `${p.name || p.last} (${p.id})`;

function showSaved() {
  const list = savedPlayers();
  savedBox.hidden = !list.length;
  savedBox.querySelector("ul").replaceChildren(...list.map((p) => {
    const item = document.createElement("li");
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "register-pick";
    pick.textContent = playerName(p);
    pick.addEventListener("click", () => {
      form.elements["uschess-id"].value = p.id;
      form.elements.last.value = p.last;
      form.elements.email.value = p.email;
      const menu = dateField.tagName === "SELECT";
      status.textContent = `${playerName(p)} is filled in. ${menu ? "Choose the date, then press" : "Press"} Register.`;
      (menu ? dateField : form.querySelector("button[type=submit]")).focus();
    });
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "register-forget";
    forget.textContent = "Forget";
    const hint = document.createElement("span");
    hint.className = "visually-hidden";
    hint.textContent = ` ${playerName(p)}`;
    forget.append(hint);
    forget.addEventListener("click", () => {
      const rest = savedPlayers().filter((q) => q.id !== p.id);
      const at = list.findIndex((q) => q.id === p.id);
      if (!storePlayers(rest)) return;
      showSaved();
      status.textContent = `${playerName(p)} is no longer saved on this device.`;
      const picks = savedBox.querySelectorAll(".register-pick");
      (picks[Math.min(at, picks.length - 1)] || form.elements["uschess-id"]).focus();
    });
    item.append(pick, " ", forget);
    return item;
  }));
}

function savePlayer(player) {
  storePlayers([player, ...savedPlayers().filter((p) => p.id !== player.id)]);
  showSaved();
}

function selected() {
  return dateField.tagName === "SELECT" ? dateField.selectedOptions[0] : dateField;
}

async function showEntries() {
  const key = `${form.elements.event.value}/${dateField.value}`;
  const day = selected().dataset.day;
  entriesStatus.textContent = "Loading entries…";
  table.hidden = true;
  try {
    const response = await fetch(`${ENDPOINT}?entries=${encodeURIComponent(key)}`);
    const { entries } = await response.json();
    if (key !== `${form.elements.event.value}/${dateField.value}`) return;
    const players = entries.length === 1 ? "1 player" : `${entries.length} players`;
    entriesStatus.textContent = entries.length
      ? `${players} registered for ${day}.` : `No one has registered for ${day} yet.`;
    table.tBodies[0].replaceChildren(...entries.map((e) => {
      const row = document.createElement("tr");
      row.insertCell().textContent = e.name;
      const link = document.createElement("a");
      link.href = `https://ratings.uschess.org/player/${encodeURIComponent(e.id)}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = e.id;
      const hint = document.createElement("span");
      hint.className = "visually-hidden";
      hint.textContent = " (opens in a new tab)";
      link.append(hint);
      row.insertCell().append(link);
      row.insertCell().textContent = e.rating || "Unrated";
      if (table.tHead.rows[0].cells.length > 3) row.insertCell().textContent = e.for || "";
      return row;
    }));
    table.hidden = !entries.length;
  } catch {
    entriesStatus.textContent = "The entry list couldn't be loaded. Try again later.";
  }
}

if (!dateField) {
  // The TD desk, which has its own code in td.js.
} else if (ENDPOINT) {
  form.hidden = false;
  if (canStore()) {
    rememberChoice.parentElement.hidden = false;
    showSaved();
  }
  if (dateField.tagName === "SELECT") dateField.addEventListener("change", showEntries);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    status.textContent = "Registering…";
    try {
      // The field is named uschess-id for the browser's autofill; see README.md.
      const body = new URLSearchParams(new FormData(form));
      body.set("id", body.get("uschess-id"));
      body.delete("uschess-id");
      const response = await fetch(ENDPOINT, { method: "POST", body });
      const result = await response.json();
      status.textContent = result.message || result.error;
      // The official name leads the success message; the trap's reply ("Thanks.") has none.
      const name = result.ok && (result.name || result.message?.match(/^(.+?) is registered for /)?.[1]);
      if (name && rememberChoice.checked) {
        savePlayer({ id: body.get("id").trim(), last: body.get("last").trim(), email: body.get("email").trim(), name });
      }
      if (result.ok) {
        form.elements["uschess-id"].value = "";
        form.elements.last.value = "";
        showEntries();
      }
    } catch {
      status.textContent = "Registration didn't go through. Try again, or email president@larimerchess.org.";
    }
    button.disabled = false;
  });
  showEntries();
} else {
  document.querySelector(".register-closed").hidden = false;
  entriesStatus.textContent = "Entries will be listed here once registration opens.";
}
