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
  function cardEnabled(config) {
    const c = config.cardProcessing;
    return Boolean(config.enabled && c?.enabled && (config.livemode === false || c.complianceReady === true)
      && new RegExp(`^pk_${config.livemode ? "live" : "test"}_[A-Za-z0-9]+$`).test(c.publishableKey || ""));
  }
  function verifiedQuote(result, config, subtotal, count) {
    if (!result?.ok) throw new Error(result?.error || "Card fee could not be reviewed.");
    if (!cardEnabled(config) || typeof result.quoteId !== "string" || !/^[A-Za-z0-9_-]{16,200}$/.test(result.quoteId)
      || result.subtotal !== subtotal || result.count !== count || result.currency !== "usd" || result.livemode !== config.livemode
      || !Number.isSafeInteger(result.cardFee) || result.cardFee < 0 || result.cardFee > Math.floor(subtotal * 3 / 100)
      || !Number.isSafeInteger(result.amount) || result.amount !== subtotal + result.cardFee || result.amount > 99999999) {
      throw new Error("Card total could not be verified. Review your card fee again.");
    }
    return result;
  }
  function verifiedCardPayment(result, config, amount) {
    if (!result?.ok) throw new Error(result?.error || "Card payment could not be submitted.");
    if (!cardEnabled(config) || !/^pi_[A-Za-z0-9]+$/.test(result.paymentIntentId || "")
      || (result.status === "requires_action" && (typeof result.clientSecret !== "string"
        || !result.clientSecret.startsWith(result.paymentIntentId + "_secret_")))
      || result.amount !== amount || result.currency !== "usd" || result.livemode !== config.livemode
      || !["succeeded", "processing", "requires_action", "requires_payment_method", "canceled"].includes(result.status)) {
      throw new Error("Payment response could not be verified. Check your receipt before trying again.");
    }
    return result;
  }
  function requestFor(event, player) {
    const [name, date] = event.key.split("/");
    return new URLSearchParams({ action: "paymentLink", event: name,
      date: player.for === "Whole month" ? date.slice(0, 7) : date, id: player.id });
  }
  return { stripeURL, verifiedLink, verifiedCheckout, requestedPlayerId, requestFor, cardEnabled, verifiedQuote, verifiedCardPayment };
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
  const cardForm = document.querySelector("#pay-card");
  const cardReview = document.querySelector("#pay-card-review");
  const cardConfirm = document.querySelector("#pay-card-confirm");
  const coverCosts = document.querySelector("#pay-cover-costs");
  const cardTotals = document.querySelector("#pay-card-totals");
  const saved = newSavedBox();
  const remember = newRemember("pay-remember");
  form.prepend(saved);
  form.append(remember);
  let config = { enabled: false };
  let revision = 0;
  let checkoutPending = false;
  let stripe, elements, cardElement, cardToken, cardQuote, stripeScript;
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
    cardToken = cardQuote = null;
    cardForm.hidden = cardTotals.hidden = cardConfirm.hidden = true;
    if (cardElement) cardElement.destroy();
    cardElement = elements = null;
  };
  const post = async (fields) => networkActivity(fields.action === "paymentPlayers" ? null
    : fields.action === "createPaymentCheckout" ? "Opening Stripe checkout"
    : fields.action === "quoteCardPayment" ? "Reviewing card fee"
    : fields.action === "confirmCardPayment" ? "Submitting card payment" : "Loading entry balances", async () => {
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
  const cardError = (error) => {
    status.textContent = summary.textContent = error.message;
    summary.scrollIntoView({ block: "center" });
    summary.focus({ preventScroll: true });
  };
  function invalidateCardQuote() {
    revision++;
    checkoutRequestId = crypto.randomUUID();
    cardQuote = null;
    cardTotals.hidden = cardConfirm.hidden = true;
    summary.textContent = "Review the card fee before paying.";
  }
  async function openCardForm() {
    const version = revision;
    checkoutPending = true;
    updateTotal();
    try {
      if (!stripeScript) stripeScript = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://js.stripe.com/endive/stripe.js";
        script.onload = resolve;
        script.onerror = () => { stripeScript = null; reject(new Error("Secure card form could not load. Please try again.")); };
        document.head.append(script);
      });
      await stripeScript;
      if (version !== revision) return;
      stripe ||= Stripe(config.cardProcessing.publishableKey);
      if (!elements) {
        const amount = selectedEntries().reduce((n, entry) => n + entry.balanceCents, 0);
        elements = stripe.elements({ mode: "payment", currency: "usd", amount,
          paymentMethodCreation: "manual", allowedPaymentMethodTypes: ["card"] });
        cardElement = elements.create("payment");
        cardElement.on("change", () => {
          cardToken = null;
          invalidateCardQuote();
        });
        cardElement.mount("#pay-card-element");
      }
      cardForm.hidden = false;
      summary.textContent = "Enter card details, then review the fee. You will confirm the total before paying.";
      cardForm.scrollIntoView({ block: "center" });
    } catch (error) { if (version === revision) cardError(error); }
    finally { checkoutPending = false; updateTotal(); }
  }
  coverCosts.addEventListener("change", () => {
    invalidateCardQuote();
    updateTotal();
  });
  cardReview.addEventListener("click", async () => {
    if (checkoutPending || !elements || !ClubPayments.cardEnabled(config)) return;
    const entries = selectedEntries(), subtotal = entries.reduce((n, entry) => n + entry.balanceCents, 0);
    if (!entries.length) return;
    const version = revision;
    cardQuote = null;
    cardTotals.hidden = cardConfirm.hidden = true;
    checkoutPending = true;
    updateTotal();
    try {
      if (!cardToken) {
        const submitted = await elements.submit();
        if (submitted.error) throw new Error(submitted.error.message || "Check your card details.");
        const created = await stripe.createConfirmationToken({ elements,
          params: { return_url: location.origin + "/pay/?returned=1" } });
        if (created.error) throw new Error(created.error.message || "Check your card details.");
        if (version !== revision) return;
        if (!/^ctoken_[A-Za-z0-9]+$/.test(created.confirmationToken?.id || "")) throw new Error("Card details could not be verified.");
        cardToken = created.confirmationToken.id;
      }
      const result = await post({ action: "quoteCardPayment", requestId: checkoutRequestId,
        entries: JSON.stringify(entries.map(({ id, event, date }) => ({ id, event, date }))),
        confirmationToken: cardToken, coverCosts: String(coverCosts.checked) });
      const quote = ClubPayments.verifiedQuote(result, config, subtotal, entries.length);
      if (version !== revision) return;
      cardQuote = quote;
      document.querySelector("#pay-card-subtotal").textContent = money(quote.subtotal);
      document.querySelector("#pay-card-fee").textContent = money(quote.cardFee);
      document.querySelector("#pay-card-total").textContent = money(quote.amount);
      cardTotals.hidden = cardConfirm.hidden = false;
      cardConfirm.textContent = `${config.livemode ? "Pay" : "Test pay"} ${money(quote.amount)}`;
      summary.textContent = "Review the total, then confirm your payment.";
      cardConfirm.focus();
    } catch (error) { if (version === revision) cardError(error); }
    finally { checkoutPending = false; updateTotal(); }
  });
  cardConfirm.addEventListener("click", async () => {
    if (checkoutPending || !cardQuote || !ClubPayments.cardEnabled(config)) return;
    const quote = cardQuote, version = revision;
    checkoutPending = true;
    updateTotal();
    try {
      const payment = ClubPayments.verifiedCardPayment(await post({ action: "confirmCardPayment", quoteId: quote.quoteId }), config, quote.amount);
      // A retry must collect/review card details; never submit a second confirmation automatically.
      cardQuote = cardToken = null;
      cardConfirm.hidden = cardTotals.hidden = true;
      if (payment.status === "requires_payment_method" || payment.status === "canceled") {
        throw new Error("Enter new card details and review the fee before trying again.");
      }
      if (payment.status === "requires_action") {
        const action = await stripe.handleNextAction({ clientSecret: payment.clientSecret });
        if (action.error) throw new Error("Card authentication was not completed. Check your payment status before trying again.");
        const intent = action.paymentIntent;
        if (intent?.id !== payment.paymentIntentId || intent.amount !== quote.amount || intent.currency !== "usd"
          || !["succeeded", "processing"].includes(intent.status)) throw new Error("Payment status could not be verified. Check your receipt before trying again.");
      }
      if (version !== revision) return;
      resetCheckout();
      status.textContent = summary.textContent = "Payment submitted. Check your Stripe receipt. Entry balances update after payment verification.";
      summary.focus();
    } catch (error) { if (version === revision) cardError(error); }
    finally { checkoutPending = false; updateTotal(); }
  });
  function updateTotal() {
    const entries = selectedEntries(), amount = entries.reduce((total, entry) => total + entry.balanceCents, 0);
    selectedTotal.textContent = `${entries.length} selected ${entries.length === 1 ? "entry" : "entries"}: ${money(amount)}.`;
    const card = ClubPayments.cardEnabled(config);
    const available = card || (!config.cardProcessing?.enabled && config.enabled && config.dynamicCheckout?.enabled);
    review.disabled = checkoutPending || !available || !entries.length;
    cardReview.disabled = cardConfirm.disabled = coverCosts.disabled = checkoutPending;
    cardReview.setAttribute("aria-busy", String(checkoutPending));
    review.setAttribute("aria-busy", String(checkoutPending));
    review.textContent = checkoutPending ? "Opening secure checkout..." : entries.length
      ? card ? "Enter card details" : `${config.livemode ? "Pay" : "Test pay"} ${money(amount)} on Stripe` : "Select entries to pay";
    const allEntries = [...people.values()].flatMap(person => person.entries);
    document.querySelector("#pay-cart-status").textContent = !available
      ? "Online checkout is unavailable. You can still view balances; please arrange payment with the tournament director."
      : !people.size ? "Find a player above to load unpaid entries."
      : entries.length ? ""
      : allEntries.some(eligible) ? "Select at least one entry to pay."
      : allEntries.some(entry => entry.review) ? "Ask the tournament director to review these entries."
      : allEntries.some(entry => entry.balanceCents === null) ? "Fees are not set yet. Ask the tournament director."
      : "Nothing to pay for these players.";
  }
  review.addEventListener("click", async () => {
    const entries = selectedEntries();
    if (ClubPayments.cardEnabled(config)) {
      if (!checkoutPending && entries.length) await openCardForm();
      return;
    }
    if (config.cardProcessing?.enabled) return;
    if (checkoutPending || !config.enabled || !config.dynamicCheckout?.enabled || !entries.length) return;
    const amount = entries.reduce((n, entry) => n + entry.balanceCents, 0);
    checkout.hidden = true;
    checkout.removeAttribute("href");
    const version = revision;
    checkoutPending = true;
    updateTotal();
    summary.textContent = `Preparing secure ${config.livemode ? "payment" : "test checkout"} for ${money(amount)}...`;
    status.textContent = "Checking the selected entry balance…";
    try {
      const result = await post({ action: "createPaymentCheckout", requestId: checkoutRequestId, entries: JSON.stringify(entries.map(({ id, event, date }) => ({ id, event, date }))) });
      const url = ClubPayments.verifiedCheckout(result, config, amount, entries.length);
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
  } else { renderBalances(); status.textContent = "Find a player by name or US Chess ID to start."; }
})();
