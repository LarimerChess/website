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
  const returned = document.querySelector("#pay-returned");
  const returnParams = new URLSearchParams(location.search);
  const balances = document.querySelector("#pay-balances");
  const playerList = document.querySelector("#pay-players");
  const summary = document.querySelector("#pay-summary");
  const checkout = document.querySelector("#pay-checkout");
  const inputs = [...document.querySelectorAll("[data-fund]")];
  const overflow = document.querySelector("#overflow");
  const gifts = () => inputs.filter(i => !i.disabled && i.valueAsNumber > 0).map(i => ({
    fund:i.dataset.fund, amount:Math.round(i.valueAsNumber * 100),
    ...(i.dataset.fund === "filing" ? {overflow:overflow.checked} : {})
  }));
  const giftTotal = () => gifts().reduce((n,g) => n + g.amount, 0);
  for (const input of [...inputs,overflow]) input.addEventListener("input", () => { resetCheckout(); updateTotal(); });
  const fundChoices = [...document.querySelectorAll("[data-select-fund]")];
  function showFund(choice) {
    const panel = document.getElementById(choice.getAttribute("aria-controls"));
    const amount = panel.querySelector("[data-fund]");
    panel.hidden = amount.disabled = !choice.checked;
    if (!choice.checked) {
      amount.value = "";
      if (amount.dataset.fund === "filing") overflow.checked = false;
    }
    document.querySelector("#gift-fees").hidden = !fundChoices.some(box => box.checked);
  }
  for (const choice of fundChoices) {
    choice.checked = choice.dataset.selectFund === returnParams.get("fund");
    showFund(choice);
    choice.addEventListener("change", () => { showFund(choice); resetCheckout(); updateTotal(); });
  }
  inputs.find(i => !i.disabled)?.focus();
  const selectedTotal = document.querySelector("#pay-selected-total");
  const review = document.querySelector("#pay-review");
  const saved = newSavedBox();
  const remember = newRemember("pay-remember");
  form.prepend(saved);
  form.append(remember);
  let config = { enabled: false };
  let revision = 0;
  let checkoutPending = false;
  let checkoutRequestId = crypto.randomUUID();
  let defaultSelected = !inputs.some(i => i.dataset.fund === returnParams.get("fund"));
  if (!defaultSelected) document.querySelector("#selection-hint").textContent = "Select any entry fees to add to your donation.";
  const people = new Map();
  const selected = new Set();
  const requests = new Map();
  let searchSequence = 0;
  let searchTimer;
  let activePlayer = -1;
  let refreshTimer;
  const money = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
  const entryKey = (playerId, entry) => JSON.stringify([playerId, entry.event, entry.date]);
  const eligible = (entry) => Number.isSafeInteger(entry.balanceCents) && entry.balanceCents > 0 && !entry.review && !entry.pending && !entry.testPending;
  const resetCheckout = () => {
    revision++;
    checkoutRequestId = crypto.randomUUID();
    checkout.hidden = true;
    checkout.removeAttribute("href");
    summary.textContent = "";
  };
  async function readPublishedBalances(fields) {
    if (!LIVE_DB || fields.action !== "paymentBalances") return null;
    const ids = fields.ids ? [...new Set(fields.ids.split(","))] : [fields.id];
    if (ids.length > 50 || ids.some(id => !/^\d{8}$/.test(id))) return null;
    try {
      const signal = AbortSignal.timeout(1200);
      const balances = await Promise.all(ids.map(async id => {
        const response = await fetch(`${LIVE_DB}/paymentBalances/p${id}.json`, { cache: "no-store", signal });
        if (!response.ok) throw Error("Published balance unavailable");
        const record = await response.json();
        if (typeof record !== "string") throw Error("Published balance missing");
        const { revision, ...data } = JSON.parse(record);
        if (typeof revision !== "string" || data.ok !== true || data.id !== id || !Array.isArray(data.entries)) {
          throw Error("Published balance could not be verified");
        }
        if (!config.enabled || config.livemode !== false) {
          data.entries = data.entries.map(entry => ({ ...entry, testPending: false }));
        }
        return { revision, data };
      }));
      if (balances.some(balance => balance.revision !== balances[0].revision)) return null;
      return fields.ids ? { ok: true, balances: balances.map(balance => balance.data) } : balances[0].data;
    } catch {
      return null;
    }
  }
  const post = async (fields, quiet = false) => networkActivity(quiet || fields.action === "paymentPlayers" ? null
    : fields.action === "createPaymentCheckout" ? "Opening Stripe checkout"
    : "Loading entry balances", async () => {
    const published = await readPublishedBalances(fields);
    if (published) return published;
    const response = await fetch(ENDPOINT, { method: "POST", body: new URLSearchParams(fields) });
    if (!response.ok) throw new Error("The payment service could not be reached. Please try again.");
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "The request could not be completed. Please ask the tournament director.");
    return data;
  });
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
      option.textContent = `${player.name} (${player.id})`;
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
    status.textContent = "Searching club records...";
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
    const entries = selectedEntries(), amount = entries.reduce((total, entry) => total + entry.balanceCents, giftTotal());
    selectedTotal.textContent = giftTotal() ? `Checkout total: ${money(amount)} including ${money(giftTotal())} in designated gifts before fees.` : `${entries.length} selected ${entries.length === 1 ? "entry" : "entries"}: ${money(amount)}.`;
    const available = config.enabled && config.dynamicCheckout?.enabled;
    review.disabled = checkoutPending || !available || !amount || inputs.some(i => !i.disabled && !i.validity.valid);
    review.setAttribute("aria-busy", String(checkoutPending));
    review.textContent = checkoutPending ? "Opening secure checkout..." : amount
      ? `${config.livemode ? "Pay" : "Test pay"} ${money(amount)} on Stripe` : "Select entries to pay";
    const allEntries = [...people.values()].flatMap(person => person.entries);
    document.querySelector("#pay-cart-status").textContent = !available
      ? "Online checkout is unavailable. You can still view balances; please arrange payment with the tournament director."
      : giftTotal() ? "" : !people.size ? "Find a player above to load unpaid entries."
      : entries.length ? ""
      : allEntries.some(eligible) ? "Select at least one entry to pay."
      : allEntries.some(entry => entry.pending || entry.testPending) ? "Payment pending verification. Do not pay again; contact the tournament director if it remains pending."
      : allEntries.some(entry => entry.review) ? "Ask the tournament director to review these entries."
      : allEntries.some(entry => entry.balanceCents === null) ? "Fees are not set yet. Ask the tournament director."
      : "Nothing to pay for these players.";
  }
  review.addEventListener("click", async () => {
    const entries = selectedEntries();
    if (checkoutPending || !config.enabled || !config.dynamicCheckout?.enabled || (!entries.length && !giftTotal()) || inputs.some(i => !i.disabled && !i.validity.valid)) return;
    const amount = entries.reduce((n, entry) => n + entry.balanceCents, giftTotal());
    checkout.hidden = true;
    checkout.removeAttribute("href");
    const version = revision;
    checkoutPending = true;
    updateTotal();
    summary.textContent = `Preparing secure ${config.livemode ? "payment" : "test checkout"} for ${money(amount)}...`;
    status.textContent = "Checking the selected entry balance…";
    try {
      const result = await post({ action: "createPaymentCheckout", requestId: checkoutRequestId, ...(giftTotal() ? {donations:JSON.stringify(gifts())} : {}), entries: JSON.stringify(entries.map(({ id, event, date }) => ({ id, event, date }))) });
      const url = ClubPayments.verifiedCheckout(result, config, amount, entries.length + gifts().length);
      if (version !== revision) return;
      summary.textContent = `Opening ${config.livemode ? "secure" : "test"} checkout for ${money(amount)}.`;
      checkout.href = url;
      checkout.textContent = `Open ${config.livemode ? "secure" : "test"} Stripe checkout: ${money(amount)}`;
      checkout.hidden = false;
      status.textContent = "Opening Stripe checkout. If it does not open, use the checkout link below. Enter your own receipt email on Stripe.";
      checkout.click();
    } catch (error) {
      if (version === revision) {
        status.textContent = error.message;
        summary.textContent = error.message;
        summary.scrollIntoView({ block: "center" });
        summary.focus({ preventScroll: true });
      }
    } finally { checkoutPending = false; updateTotal(); }
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
    for (const data of people.values()) {
      const group = document.createElement("section");
      group.dataset.player = data.id;
      if (data.id === requestedId) group.setAttribute("aria-label", "Player from payment link");
      group.append(Object.assign(document.createElement("h3"), { textContent: `${data.id === requestedId ? "Player from your payment link: " : ""}${data.name || data.id} (${data.id})` }));
      if (!data.entries.some(entry => entry.balanceCents !== 0)) group.append(Object.assign(document.createElement("p"), { textContent: "No unpaid entries for this player." }));
      const visible = data.entries.filter(entry => entry.balanceCents !== 0);
      if (visible.length) {
        const table = Object.assign(document.createElement("table"), { className: "pay-entries" });
        table.append(Object.assign(document.createElement("caption"), { className: "visually-hidden", textContent: `Unpaid entries for ${data.name || data.id}` }));
        const header = table.createTHead().insertRow();
        for (const text of ["Pay", "Event", "Date", "Amount"]) {
          const th = Object.assign(document.createElement("th"), { textContent: text });
          th.scope = "col";
          header.append(th);
        }
        const body = table.createTBody();
        for (const entry of visible) {
          const row = body.insertRow();
          row.className = "pay-entry";
          const selection = row.insertCell();
          if (eligible(entry)) {
            const key = entryKey(data.id, entry);
            const checkbox = Object.assign(document.createElement("input"), { type: "checkbox", checked: selected.has(key) });
            checkbox.dataset.entry = key;
            checkbox.setAttribute("aria-label", `Pay ${entry.name}, ${entry.date}, for ${data.name || data.id}`);
            checkbox.addEventListener("change", () => {
              if (checkbox.checked) selected.add(key); else selected.delete(key);
              resetCheckout();
              updateTotal();
            });
            selection.append(checkbox);
          }
          const event = document.createElement("th");
          event.scope = "row";
          event.textContent = entry.name;
          if (entry.pending || entry.testPending) event.append(Object.assign(document.createElement("small"), { textContent: entry.testPending ? "Test payment pending verification" : "Payment pending verification" }));
          if (entry.review) event.append(Object.assign(document.createElement("small"), { textContent: "Needs review" }));
          row.append(event);
          row.insertCell().textContent = entry.date;
          row.insertCell().textContent = entry.balanceCents === null ? "Not set" : money(entry.balanceCents);
        }
        group.append(table);
      }
      balances.append(group);
    }
    updateTotal();
    schedulePendingRefresh();
  }
  function schedulePendingRefresh() {
    clearTimeout(refreshTimer);
    const pending = [...people.values()].filter(person => person.entries.some(entry =>
      entry.balanceCents !== 0 && (entry.pending || entry.testPending)));
    if (!pending.length) return;
    refreshTimer = setTimeout(async () => {
      if (!document.hidden && !checkoutPending) await loadBalanceBatch(pending.map(person => person.id), true);
      schedulePendingRefresh();
    }, 30000);
  }
  function applyBalances(data, playerId) {
    if (data?.id !== playerId || data.currency !== "usd" || !Array.isArray(data.entries)
        || !Number.isSafeInteger(data.totalCents) || !Number.isSafeInteger(data.unknownCount)) {
      throw new Error("Balances could not be verified. Please ask the tournament director.");
    }
    const previous = people.get(playerId);
    if (JSON.stringify(data) === JSON.stringify(previous)) return false;
    const previousKeys = new Set(previous?.entries.map(entry => entryKey(playerId, entry)) || []);
    const awaiting = new Set(previous?.entries.filter(entry => entry.pending).map(entry => entryKey(playerId, entry)) || []);
    for (const entry of data.entries) {
      const key = entryKey(playerId, entry);
      if (!eligible(entry)) selected.delete(key);
      else if (!previousKeys.has(key) && defaultSelected) selected.add(key);
      if (awaiting.has(key) && entry.balanceCents === 0 && !entry.review) {
        returned.hidden = false;
        returned.textContent = "Payment confirmed.";
      }
    }
    people.set(playerId, data);
    return true;
  }
  async function loadBalanceBatch(ids, quiet = false, errorStatus = returned) {
    if (!quiet) for (const id of ids) requests.set(id, Symbol());
    const tokens = ids.map(id => requests.get(id));
    let changed = false;
    try {
      const result = await post({ action: "paymentBalances", ids: ids.join(",") }, quiet);
      if (quiet && checkoutPending) return false;
      if (!Array.isArray(result.balances) || result.balances.length !== ids.length) throw new Error("Balances could not be verified.");
      ids.forEach((id, index) => {
        if (requests.get(id) === tokens[index]) changed = applyBalances(result.balances[index], id) || changed;
      });
      return true;
    } catch (error) {
      if (!quiet && ids.some((id, index) => requests.get(id) === tokens[index])) errorStatus.textContent = error.message;
      return false;
    } finally {
      if (changed) { resetCheckout(); renderBalances(); }
    }
  }
  async function startTdPayments() {
    let panel;
    let session;

    async function open(getCredentials) {
      const current = Symbol();
      session = current;
      panel?.remove();
      if (!getCredentials) return;
      const ask = async (operation, fields = {}) => {
        if (session !== current) return { login: true };
        const credentials = await getCredentials();
        if (!credentials || session !== current) return { login: true };
        return postRegistration(new URLSearchParams({
          action: "tdPlayerPayments", operation, id: requestedId, ...fields, ...credentials,
        }), null);
      };
      const data = await ask("list");
      if (!data.ok || !data.name || session !== current) return;

      const box = document.createElement("section");
      box.setAttribute("aria-labelledby", "pay-td-heading");
      const title = Object.assign(document.createElement("h3"), { id: "pay-td-heading", textContent: `TD payments for ${data.name}` });
      const feedback = document.createElement("p");
      feedback.setAttribute("role", "status");
      feedback.tabIndex = -1;
      const list = document.createElement("ul");
      const method = document.createElement("select");
      method.id = "pay-td-method";
      method.add(new Option("Cash", "cash"));
      method.add(new Option("Check", "check"));
      const label = Object.assign(document.createElement("label"), { htmlFor: method.id, textContent: "Payment method" });
      const tools = Object.assign(document.createElement("div"), { className: "field-row" });
      let giftDraft;
      const button = (text, handle, entry = "") => {
        const control = Object.assign(document.createElement("button"), { type: "button", className: "td-action", textContent: text });
        if (entry) control.setAttribute("aria-label", `${text} for ${entry}`);
        control.addEventListener("click", handle);
        return control;
      };
      const mutate = async (operation, fields) => {
        for (const input of box.querySelectorAll("button, select")) input.disabled = true;
        feedback.textContent = "Saving…";
        let savedMessage = "";
        try {
          const result = await ask(operation, fields);
          if (session !== current) return;
          if (result.login) { box.remove(); return; }
          if (!result.ok) {
            feedback.textContent = result.error || "Could not save the change.";
          } else {
            if (operation === "donate") giftDraft = null;
            feedback.textContent = savedMessage = result.message;
            if (operation !== "donate") {
              resetCheckout();
              if (!await loadBalanceBatch([requestedId], true)) feedback.textContent += " Reload the page to see the updated balance.";
            }
          }
          if (operation !== "donate") {
            const latest = await ask("list");
            if (latest.login) { box.remove(); return; }
            if (latest.ok) showEntries(latest.entries);
            else feedback.textContent += " Reload the page to refresh the TD balances.";
          }
        } catch {
          feedback.textContent = savedMessage ? `${savedMessage} Reload the page to refresh the TD balances.`
            : operation === "donate" ? "Could not confirm the donation. Retry with the same amount, method and note."
              : "Could not confirm the change. Reload the page to check the balance.";
        } finally {
          for (const input of box.querySelectorAll("button, select")) input.disabled = false;
          if (box.isConnected && (document.activeElement === document.body || box.contains(document.activeElement))) feedback.focus();
        }
      };
      const donation = button("Record donation", () => {
        const by = method.value;
        const amount = prompt(`Amount ${data.name} donated by ${by}`, "")?.trim();
        if (!amount) return;
        const note = prompt("Donation note (optional)", "");
        if (note === null) return;
        const key = JSON.stringify([amount, by, note]);
        if (giftDraft?.key !== key) giftDraft = { key, id: crypto.randomUUID() };
        mutate("donate", { amount, by, note, requestId: giftDraft.id });
      });
      tools.append(label, method, donation);
      const empty = Object.assign(document.createElement("p"), { textContent: "No balances or discounts to manage." });
      function showEntries(entries) {
        list.replaceChildren();
        list.hidden = entries.length === 0;
        empty.hidden = entries.length > 0;
        for (const entry of entries) {
          const forEntry = `${entry.name}, ${entry.date}`;
          const details = Object.assign(document.createElement("li"), { textContent: `${forEntry} · ${entry.balanceCents === null
            ? "Fee needs review" : `${money(entry.balanceCents)} due`}${entry.discountCents ? ` · ${money(entry.discountCents)} discount` : ""}` });
          list.append(details);
          if (entry.pending) {
            details.append(" · Online payment pending verification");
            continue;
          }
          const fields = { token: entry.token, event: entry.event, date: entry.date };
          const actions = Object.assign(document.createElement("div"), { className: "field-row" });
          if (entry.balanceCents > 0) actions.append(button("Mark paid", () => {
            const by = method.value;
            if (confirm(`Record ${money(entry.balanceCents)} paid by ${by} for ${data.name}'s ${forEntry} entry?`)) {
              mutate("settle", { ...fields, by, expected: entry.balanceCents });
            }
          }, forEntry));
          actions.append(button("Discount", () => {
            const suggested = entry.discountCents || entry.balanceCents;
            const amount = prompt(`Discount for ${forEntry} in dollars (0 removes it)`, suggested == null ? "" : (suggested / 100).toFixed(2))?.trim();
            if (!amount) return;
            const note = Number(amount) ? prompt("Reason for the discount (optional)", "") : "";
            if (note !== null) mutate("discount", { ...fields, amount, note, expected: entry.discountCents });
          }, forEntry));
          details.append(actions);
        }
      }
      showEntries(data.entries);
      box.append(title, tools, feedback, empty, list);
      panel = box;
      balances.after(box);
    }

    if (FIREBASE) {
      const sdk = "https://www.gstatic.com/firebasejs/12.19.0";
      const [app, authSdk] = await Promise.all([import(`${sdk}/firebase-app.js`), import(`${sdk}/firebase-auth.js`)]);
      const auth = authSdk.getAuth(app.initializeApp(FIREBASE));
      authSdk.onAuthStateChanged(auth, user => {
        open(user && (async () => auth.currentUser === user ? { idToken: await user.getIdToken() } : null)).catch(() => {});
      });
    } else {
      await open(() => {
        const password = sessionStorage.getItem("tdPassword");
        return password ? { password, device: localStorage.getItem("lccc-td-device") || "" } : null;
      });
    }
  }
  function followPaymentChanges() {
    if (!LIVE_DB || typeof listenLive !== "function") return;
    let stamp, timer, refreshing = false, changed = false, retries = 0;
    const refresh = async () => {
      if (!changed || document.hidden || refreshing) return;
      if (checkoutPending) { timer = setTimeout(refresh, 250); return; }
      changed = false;
      refreshing = true;
      let succeeded = true;
      try {
        const ids = [...people.keys()];
        for (let start = 0; start < ids.length; start += 50) {
          succeeded = await loadBalanceBatch(ids.slice(start, start + 50), true) && succeeded;
        }
      } finally {
        refreshing = false;
        if (changed) timer = setTimeout(refresh, 250);
        else if (!succeeded && retries++ < 2) {
          changed = true;
          timer = setTimeout(refresh, 2000);
        }
      }
    };
    listenLive("/changes/paymentBalances", value => {
      if (typeof value !== "string" || value === stamp) return;
      stamp = value;
      retries = 0;
      changed = true;
      clearTimeout(timer);
      timer = setTimeout(refresh, 250);
    }, () => { stamp = undefined; });
    document.addEventListener("visibilitychange", refresh);
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
      applyBalances(data, playerId);
      if (keep) {
        const known = savedPlayers().find((player) => player.id === playerId);
        storePlayers([{ last: "", email: "", ...known, id: playerId, name: data.name || known?.name || playerId },
          ...savedPlayers().filter((player) => player.id !== playerId)]);
        showSavedPlayers();
      }
      resetCheckout();
      renderBalances();
      status.textContent = "";
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
  if (returnParams.has("returned")) returned.hidden = false;
  try {
    const response = await fetch("/stripe-payment-links.json", { cache: "no-store" });
    if (!response.ok) throw new Error();
    config = await response.json();
    if (config.enabled && !config.livemode) document.querySelector("#pay-test").hidden = false;
  } catch { config = { enabled: false }; }
  form.hidden = false;
  showSavedPlayers();
  const ids = savedPlayers().map((player) => player.id);
  if (/^\d{8}$/.test(requestedId || "") && !ids.includes(requestedId)) ids.unshift(requestedId);
  const reference = returnParams.get("checkout");
  let returnedIds = [];
  if (returnParams.has("returned") && /^[a-zA-Z0-9_-]{16,100}$/.test(reference || "")) {
    const instructions = returned.textContent;
    returned.textContent = "Checking your Stripe checkout…";
    try {
      const result = await post({ action: "returnPaymentCheckout", reference }, true);
      if (!Array.isArray(result.ids) || result.ids.length > 50 || result.ids.some(id => !/^\d{8}$/.test(id))) {
        throw new Error("Checkout entries could not be verified. Refresh the page to try again.");
      }
      returnedIds = [...new Set(result.ids)];
      returned.textContent = instructions;
    } catch (error) { returned.textContent = error.message; }
  }
  if (ids.length || returnedIds.length) {
    const initialIds = [...new Set([...ids, ...returnedIds])];
    if (initialIds.length === 1 && !returnedIds.length) await loadBalances(initialIds[0], false);
    else {
      const loading = "Loading balances for all registered events…";
      status.textContent = loading;
      const batches = [];
      for (let start = 0; start < initialIds.length; start += 50) {
        batches.push(loadBalanceBatch(initialIds.slice(start, start + 50), false, status));
      }
      await Promise.all(batches);
      if (status.textContent === loading) status.textContent = "";
    }
    id.value = requestedId || returnedIds[0] || ids[0];
  } else { renderBalances(); status.textContent = "Find a player by name or US Chess ID to start."; }
  if (requestedId && ENDPOINT) startTdPayments().catch(() => {});
  followPaymentChanges();
})();
