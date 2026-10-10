// The Register form and entry list on each tournament page, which scripts/build_pages.py
// writes. Entries are kept by the Apps Script in scripts/registration.gs; see README.md.

const ENDPOINT = "https://script.google.com/macros/s/AKfycbxEtmbXBQdxAKf5iKpCuHquO3CRadC44VvlEZyUlfGno6E5mEBlLrh1G3dH-MoxrJ6Z/exec";

const form = document.querySelector(".register-form");
const status = document.querySelector(".register-status");
const entriesStatus = document.querySelector(".entries-status");
const table = document.querySelector(".entries");
const dateField = form.elements.date;

const wanted = new URLSearchParams(location.search).get("date");
if (dateField.tagName === "SELECT" && [...dateField.options].some((o) => o.value === wanted)) dateField.value = wanted;

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
      return row;
    }));
    table.hidden = !entries.length;
  } catch {
    entriesStatus.textContent = "The entry list couldn't be loaded. Try again later.";
  }
}

if (ENDPOINT) {
  form.hidden = false;
  if (dateField.tagName === "SELECT") dateField.addEventListener("change", showEntries);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    status.textContent = "Registering…";
    try {
      const response = await fetch(ENDPOINT, { method: "POST", body: new URLSearchParams(new FormData(form)) });
      const result = await response.json();
      status.textContent = result.message || result.error;
      if (result.ok) {
        form.elements.id.value = "";
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
