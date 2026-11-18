/* Guest payments use a separate reference minted by the registration service. */
const ClubPayments = (() => {
  function stripeURL(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "buy.stripe.com" && !url.username && !url.password && !url.port ? url : null;
    } catch { return null; }
  }
  function verifiedLink(result, config) {
    if (!result?.ok) throw new Error(result?.error || "Payment is unavailable. Please ask the tournament director.");
    const url = stripeURL(result.url);
    const configured = stripeURL(config.entry?.url);
    if (!config.enabled || !url || !configured || url.pathname !== configured.pathname
        || !/^[a-zA-Z0-9_-]{16,200}$/.test(url.searchParams.get("client_reference_id") || "")
        || result.amount !== 1750 || result.currency !== "usd" || result.livemode !== config.livemode) {
      throw new Error("Payment configuration could not be verified. Please ask the tournament director.");
    }
    return url.href;
  }
  function verifiedCheckout(result, config, amount, count) {
    if (!result?.ok) throw new Error(result?.error || "Checkout is unavailable.");
    let url;
    try { url = new URL(result.checkoutUrl); } catch { throw new Error("Checkout could not be verified."); }
    if (!config.enabled || !config.dynamicCheckout?.enabled || url.protocol !== "https:" || url.hostname !== "checkout.stripe.com"
        || url.username || url.password || url.port || result.amount !== amount || result.count !== count
        || result.currency !== "usd" || result.livemode !== config.livemode) throw new Error("Balances changed or checkout could not be verified. Reload balances and try again.");
    return url.href;
  }
  function requestedPlayerId(search) {
    const params = new URLSearchParams(search);
    const value = params.get("id") ?? params.get("uscfid");
    return /^\d{8}$/.test(value || "") ? value : null;
  }
  function requestFor(event, player) {
    const [name, date] = event.key.split("/");
    return new URLSearchParams({ action: "paymentLink", event: name,
      date: player.for === "Whole month" ? date.slice(0, 7) : date, id: player.id });
  }
  return { stripeURL, verifiedLink, verifiedCheckout, requestedPlayerId, requestFor };
})();
if (typeof module !== "undefined") module.exports = ClubPayments;

if (typeof document !== "undefined") (async () => {
  const status = document.querySelector("#pay-status");
  const form = document.querySelector("#pay-form");
  const id = document.querySelector("#pay-id");
  const requestedId = ClubPayments.requestedPlayerId(location.search);
  const balances = document.querySelector("#pay-balances");
  const playerList = document.querySelector("#pay-players");
  const summary = document.querySelector("#pay-summary");
  const checkout = document.querySelector("#pay-checkout");
  const donation = document.querySelector("#donation-link");
  const selectedTotal = document.querySelector("#pay-selected-total");
  const review = document.querySelector("#pay-review");
  const saved = newSavedBox();
  const remember = newRemember("pay-remember");
  form.prepend(saved);
  form.querySelector("button[type=submit]").before(remember);
  let config = { enabled: false };
  let revision = 0;
  let checkoutRequestId = crypto.randomUUID();
  let defaultSelected = true;
  const people = new Map();
  const selected = new Set();
  const requests = new Map();
  let searchSequence = 0;
  let searchTimer;
  let activePlayer = -1;
  const money = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
  const entryKey = (playerId, entry) => JSON.stringify([playerId, entry.event, entry.date]);
  const eligible = (entry) => Number.isSafeInteger(entry.balanceCents) && entry.balanceCents > 0 && !entry.review;
  const resetCheckout = () => {
    revision++;
    checkoutRequestId = crypto.randomUUID();
    checkout.hidden = true;
    checkout.removeAttribute("href");
    summary.textContent = "";
  };
  const post = async (fields) => {
    const response = await fetch(ENDPOINT, { method: "POST", body: new URLSearchParams(fields) });
    if (!response.ok) throw new Error("The payment service could not be reached. Please try again.");
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "The request could not be completed. Please ask the tournament director.");
    return data;
  };
  function setActivePlayer(index) {
    const options = [...playerList.querySelectorAll("[role=option]")];
    activePlayer = Math.max(-1, Math.min(index, options.length - 1));
    options.forEach((option, i) => option.setAttribute("aria-selected", String(i === activePlayer)));
    if (activePlayer >= 0) {
      id.setAttribute("aria-activedescendant", options[activePlayer].id);
      options[activePlayer].scrollIntoView({ block: "nearest" });
    } else id.removeAttribute("aria-activedescendant");
  }
  function closePlayerSearch() {
    clearTimeout(searchTimer);
    searchSequence++;
    playerList.hidden = true;
    id.setAttribute("aria-expanded", "false");
    setActivePlayer(-1);
  }
  function showPlayerMatches(players, empty) {
    playerList.replaceChildren(...players.map((player, index) => {
      const option = document.createElement("li");
      option.id = `pay-player-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.textContent = `${player.name} ? ${player.id}`;
      option.player = player;
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        loadBalances(player.id, remember.querySelector("input").checked);
      });
      return option;
    }));
    if (!players.length) playerList.append(Object.assign(document.createElement("li"), { className: "td-none", textContent: empty }));
    playerList.hidden = false;
    id.setAttribute("aria-expanded", "true");
    setActivePlayer(-1);
  }
  async function searchPlayers() {
    clearTimeout(searchTimer);
    const q = id.value.trim(), version = ++searchSequence;
    if (q.length < 2) { closePlayerSearch(); status.textContent = "Type at least two characters to search club records."; return; }
    if (q.length > 80 || /^\d{9,}$/.test(q)) { closePlayerSearch(); status.textContent = "Enter a name or an eight-digit US Chess ID."; return; }
    status.textContent = "Searching club registration records?";
    try {
      const data = await post({ action: "paymentPlayers", q });
      if (version !== searchSequence) return;
      if (!Array.isArray(data.players) || data.players.length > 12 || data.players.some((p) => !/^\d{8}$/.test(p.id || "") || typeof p.name !== "string")) throw new Error("Player search is unavailable. Enter a full US Chess ID to show balances.");
      showPlayerMatches(data.players, "No matching players in club registration records.");
      status.textContent = data.players.length ? "Choose a player to show their balances." : "No matching players in club registration records. You can enter a full eight-digit ID.";
    } catch (error) {
      if (version === searchSequence) { closePlayerSearch(); status.textContent = "Player search is unavailable. Enter a full US Chess ID to show balances."; }
    }
  }
  function selectedEntries() {
    return [...people.values()].flatMap((person) => person.entries.filter((entry) => eligible(entry) && selected.has(entryKey(person.id, entry)))
      .map((entry) => ({ ...entry, id: person.id, playerName: person.name })));
  }
  function updateTotal() {
    const entries = selectedEntries();
    selectedTotal.textContent = `${entries.length} selected ${entries.length === 1 ? "entry" : "entries"} — ${money(entries.reduce((total, entry) => total + entry.balanceCents, 0))}.`;
    review.disabled = !config.enabled || !config.dynamicCheckout?.enabled || !entries.length;
    document.querySelector("#pay-cart-status").textContent = !config.enabled
      ? "Online payments are not available yet. Your balances are shown above; please pay the tournament director."
      : !config.dynamicCheckout?.enabled ? "Online checkout is not available yet. Please pay the tournament director." : "";
  }
  review.addEventListener("click", async () => {
    const entries = selectedEntries();
    if (!config.enabled || !config.dynamicCheckout?.enabled || !entries.length) return;
    const amount = entries.reduce((n, entry) => n + entry.balanceCents, 0);
    checkout.hidden = true;
    checkout.removeAttribute("href");
    const version = revision;
    review.disabled = true;
    status.textContent = "Checking the selected entry balance…";
    try {
      const result = await post({ action: "createPaymentCheckout", requestId: checkoutRequestId, entries: JSON.stringify(entries.map(({ id, event, date }) => ({ id, event, date }))) });
      const url = ClubPayments.verifiedCheckout(result, config, amount, entries.length);
      if (version !== revision) return;
      summary.textContent = `${config.livemode ? "You are paying" : "Test payment"}: ${money(amount)} for ${entries.length} selected entries. ${entries.map((entry) => `${entry.playerName}: ${entry.name}, ${entry.date}`).join("; ")}`;
      checkout.href = url;
      checkout.textContent = config.livemode ? `Confirm and pay ${money(amount)} on Stripe` : "Continue to test checkout";
      checkout.hidden = false;
      status.textContent = "Check the player and event below before continuing. Enter your own receipt email at checkout.";
      checkout.focus();
    } catch (error) {
      if (version === revision) status.textContent = error.message;
    } finally { updateTotal(); }
  });
  function showSavedPlayers() {
    showSavedIn(saved, (player) => loadBalances(player.id, false), (player) => {
      requests.set(player.id, Symbol());
      people.delete(player.id);
      for (const key of selected) if (JSON.parse(key)[0] === player.id) selected.delete(key);
      resetCheckout();
      if (id.value.trim() === player.id) id.value = "";
      status.textContent = `${playerName(player)} is no longer saved on this device or included in this payment.`;
      showSavedPlayers();
      renderBalances();
    }, id);
  }
  function renderBalances() {
    balances.replaceChildren();
    let total = 0;
    let unknown = 0;
    for (const data of people.values()) { total += data.totalCents; unknown += data.unknownCount; }
    balances.append(Object.assign(document.createElement("p"), { id: "pay-total",
      textContent: `${unknown ? "Known balance subtotal" : "Total owed"}: ${money(total)}.` }));
    if (unknown) balances.append(Object.assign(document.createElement("p"), {
      textContent: `${unknown} entry fee(s) are not set yet and are excluded from the subtotal. Please ask the tournament director.` }));
    for (const data of people.values()) {
      const group = document.createElement("section");
      group.dataset.player = data.id;
      if (data.id === requestedId) group.setAttribute("aria-label", "Player from payment link");
      group.append(Object.assign(document.createElement("h3"), { textContent: `${data.id === requestedId ? "Player from your payment link: " : ""}${data.name || data.id} (${data.id}) — all registered events` }));
      if (!data.entries.length) group.append(Object.assign(document.createElement("p"), { textContent: "No active registrations found for this player." }));
      for (const entry of data.entries) {
        const card = Object.assign(document.createElement("div"), { className: "pay-entry" });
        const amount = entry.balanceCents;
        const title = `${entry.name} — ${entry.date}`;
        if (eligible(entry)) {
          const key = entryKey(data.id, entry);
          const label = document.createElement("label");
          const checkbox = Object.assign(document.createElement("input"), { type: "checkbox", checked: selected.has(key) });
          checkbox.dataset.entry = key;
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) selected.add(key); else selected.delete(key);
            resetCheckout();
            updateTotal();
          });
          label.append(checkbox, ` ${title}: ${money(amount)} owed`);
          card.append(label);
        } else {
          card.append(Object.assign(document.createElement("p"), { textContent: `${title}: ${amount === null ? "Fee not set yet."
            : amount === 0 ? "Nothing owed — balance $0.00." : amount < 0 ? `Credit: ${money(-amount)}.` : `${money(amount)} owed.`}` }));
        }
        if (entry.review) card.append(Object.assign(document.createElement("p"), {
          textContent: "A payment needs review. Contact the tournament director before paying again." }));
        group.append(card);
      }
      balances.append(group);
    }
    updateTotal();
  }
  async function loadBalances(playerId, keep) {
    closePlayerSearch();
    resetCheckout();
    id.value = playerId;
    const token = Symbol();
    requests.set(playerId, token);
    status.textContent = "Loading balances for all registered events…";
    try {
      const data = await post({ action: "paymentBalances", id: playerId });
      if (requests.get(playerId) !== token) return;
      if (data.id !== playerId || data.currency !== "usd" || !Array.isArray(data.entries)
          || !Number.isSafeInteger(data.totalCents) || !Number.isSafeInteger(data.unknownCount)) throw new Error("Balances could not be verified. Please ask the tournament director.");
      const previous = people.get(playerId);
      const previousKeys = new Set(previous?.entries.map((entry) => entryKey(playerId, entry)) || []);
      for (const entry of data.entries) {
        const key = entryKey(playerId, entry);
        if (!eligible(entry)) selected.delete(key);
        else if (!previousKeys.has(key) && defaultSelected) selected.add(key);
      }
      people.set(playerId, data);
      if (keep) {
        const known = savedPlayers().find((player) => player.id === playerId);
        storePlayers([{ last: "", email: "", ...known, id: playerId, name: data.name || known?.name || playerId },
          ...savedPlayers().filter((player) => player.id !== playerId)]);
        showSavedPlayers();
      }
      resetCheckout();
      renderBalances();
      status.textContent = "Balances include past and upcoming active registrations. Select the entries you want to pay. Updates after checkout may take longer than 15 minutes.";
    } catch (error) {
      if (requests.get(playerId) === token) status.textContent = error.message;
    }
  }
  for (const [selector, checked] of [["#pay-select-all", true], ["#pay-deselect-all", false]]) {
    document.querySelector(selector).addEventListener("click", () => {
      defaultSelected = checked;
      for (const person of people.values()) for (const entry of person.entries) {
        const key = entryKey(person.id, entry);
        if (checked && eligible(entry)) selected.add(key); else selected.delete(key);
      }
      resetCheckout();
      renderBalances();
    });
  }
  id.addEventListener("input", () => {
    resetCheckout();
    closePlayerSearch();
    if (id.value.trim().length < 2) { status.textContent = "Type at least two characters to search club records."; return; }
    searchTimer = setTimeout(searchPlayers, 250);
  });
  id.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closePlayerSearch(); return; }
    if (playerList.hidden) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActivePlayer(activePlayer + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActivePlayer(activePlayer - 1); }
    else if (event.key === "Enter" && activePlayer >= 0) {
      event.preventDefault();
      loadBalances(playerList.querySelectorAll("[role=option]")[activePlayer].player.id, remember.querySelector("input").checked);
    }
  });
  id.addEventListener("blur", closePlayerSearch);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const playerId = id.value.trim();
    if (/^\d{8}$/.test(playerId)) loadBalances(playerId, remember.querySelector("input").checked);
    else searchPlayers();
  });
  if (new URLSearchParams(location.search).has("returned")) document.querySelector("#pay-returned").hidden = false;
  try {
    const response = await fetch("/stripe-payment-links.json", { cache: "no-store" });
    if (!response.ok) throw new Error();
    config = await response.json();
    if (config.enabled && !config.livemode) document.querySelector("#pay-test").hidden = false;
    const donationURL = config.enabled && ClubPayments.stripeURL(config.donation?.url);
    if (donationURL) {
      donation.href = donationURL.href;
      donation.textContent = config.livemode ? "Donate through Stripe" : "Try a test donation";
      donation.hidden = false;
      document.querySelector("#donation-status").textContent = "";
    }
  } catch { config = { enabled: false }; }
  form.hidden = false;
  showSavedPlayers();
  const ids = savedPlayers().map((player) => player.id);
  if (/^\d{8}$/.test(requestedId || "") && !ids.includes(requestedId)) ids.unshift(requestedId);
  if (ids.length) {
    await Promise.all(ids.map((playerId) => loadBalances(playerId, false)));
    id.value = /^\d{8}$/.test(requestedId || "") ? requestedId : ids[0];
  } else { renderBalances(); status.textContent = "Enter a player's name or US Chess ID to search club registration records. No login is needed."; }
})();

