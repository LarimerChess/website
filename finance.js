(async () => {
  const view = document.querySelector("main").dataset.view;
  if (view === "admin") {
    const form = document.querySelector("#finance-entry");
    const status = document.querySelector("#result");
    let requestId = crypto.randomUUID();
    form.addEventListener("input", () => { requestId = crypto.randomUUID(); });
    form.elements.date.valueAsDate = new Date();
    form.elements.kind.addEventListener("change", () => {
      document.querySelector("#destination").hidden = !["transfer","allocateGift"].includes(form.elements.kind.value);
    });
    let auth;
    let sdk;
    async function loadAuth() {
      if (!auth) {
        const base = "https://www.gstatic.com/firebasejs/12.19.0/";
        const [app,authSdk] = await Promise.all([import(base+"firebase-app.js"), import(base+"firebase-auth.js")]);
        sdk = authSdk;
        auth = sdk.getAuth(app.initializeApp(FIREBASE));
      }
      await auth.authStateReady();
    }
    const login = document.querySelector("#finance-login");
    login.hidden = !FIREBASE;
    login.addEventListener("click", async () => {
      try {
        await loadAuth();
        await sdk.signInWithPopup(auth,new sdk.GoogleAuthProvider());
        await send("financeAccess",{});
        status.textContent = "Signed in to club finance.";
      } catch (error) { status.textContent = error.message; }
    });
    async function credentials() {
      if (!FIREBASE) return {password:sessionStorage.getItem("tdPassword") || "",device:localStorage.getItem("lccc-td-device") || ""};
      await loadAuth();
      if (!auth.currentUser) throw Error("Sign in to record club finances.");
      return {idToken:await auth.currentUser.getIdToken()};
    }
    async function send(action, fields) {
      const result = await postRegistration(new URLSearchParams({action,...fields,...await credentials()}));
      if (!result.ok) throw Error(result.error || "Finance request failed.");
      return result;
    }
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(form));
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        await send("financePost",{...fields,cents:Math.round(Number(fields.amount)*100),requestId});
        requestId = crypto.randomUUID();
        form.elements.amount.value = form.elements.purpose.value = "";
        status.textContent = "Transaction recorded.";
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
    document.querySelector("#import").addEventListener("click", async () => {
      try { const result = await send("financeHistory",{}); status.textContent = result.count + " historical entries synchronized."; }
      catch (error) { status.textContent = error.message; }
    });
    return;
  }
  const totals = document.querySelector("#totals");
  const money = n => (n/100).toLocaleString("en-US",{style:"currency",currency:"USD"});
  const cashChange = line => (line.gross || 0) - (line.fee || 0) - (line.spent || 0) + (line.transfer || 0);

  function showBalanceSheet(entries, names) {
    const today = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Denver", year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
    const funds = new Map();
    let cash = 0, liabilities = 0, pending = 0;
    for (const entry of entries) {
      if (entry.date > today) continue;
      for (const line of entry.lines) {
        const fund = funds.get(line.fund) || {cash:0, owed:0};
        const change = cashChange(line), owed = line.owed || 0;
        fund.cash += change;
        fund.owed += owed;
        funds.set(line.fund, fund);
        cash += change;
        liabilities += owed;
        pending += line.pending || 0;
      }
    }
    if (!funds.size) {
      totals.textContent = "No financial records have been posted through " + today + ".";
      return;
    }
    const sheet = document.querySelector("#balance-sheet");
    sheet.caption.textContent = "Statement of financial position as of " + today;
    function group(title) {
      const body = sheet.createTBody();
      const heading = document.createElement("th");
      heading.scope = "rowgroup";
      heading.colSpan = 2;
      heading.textContent = title;
      body.insertRow().append(heading);
      return body;
    }
    function account(body, label, cents) {
      const row = body.insertRow();
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = label;
      row.append(heading);
      row.insertCell().textContent = money(cents);
    }
    const assets = group("Assets");
    account(assets,"Cash and settled processor funds",cash);
    account(assets,"Total assets",cash);
    const debts = group("Liabilities");
    for (const [key,label] of Object.entries(names)) {
      const fund = funds.get(key);
      if (fund?.owed) account(debts,label + " payables",fund.owed);
    }
    account(debts,"Total liabilities",liabilities);
    const equity = group("Net assets by fund");
    for (const [key,label] of Object.entries(names)) {
      const fund = funds.get(key);
      if (fund) account(equity,label,fund.cash - fund.owed);
    }
    const netAssets = cash - liabilities;
    account(equity,"Total net assets",netAssets);
    account(sheet.createTFoot(),"Total liabilities and net assets",liabilities + netAssets);
    const note = document.querySelector("#statement-note");
    note.textContent = "Based on the public club ledger." + (pending ? " Payments awaiting fee confirmation are excluded (" + money(pending) + ")." : "");
    note.hidden = sheet.hidden = false;
    totals.textContent = "";
  }
  try {
    const response = await fetch(LIVE_DB + "/public/finance.json",{cache:"no-store"});
    if (!response.ok) throw Error();
    const entries = Object.values(await response.json() || {}).sort((a,b) => b.date.localeCompare(a.date));
    const names = {filing:"Form 1023-EZ",general:"General",marketing:"Marketing",equipment:"Boards and clocks",tournaments:"Tournament operations",reconciliation:"Pending fund allocation"};
    if (!view) {
      showBalanceSheet(entries, names);
      return;
    }
    const table = document.createElement("table");
    table.createCaption().textContent = "Recorded transactions in US dollars";
    const header = table.createTHead().insertRow();
    for (const label of ["Date","Purpose","Fund","Gross in","Processing fees","Paid out","Transfers","Net change","Change in amount owed"]) {
      const th = document.createElement("th"); th.scope = "col"; th.textContent = label; header.append(th);
    }

    const body = table.createTBody();
    let credited = 0, raised = 0, balance = 0, owed = 0;
    for (const entry of entries) for (const line of entry.lines) {
      if (view && line.fund !== view) continue;
      const net = cashChange(line);
      credited += Math.max(0,line.raised ?? line.donation ?? 0); raised += line.donation || 0; balance += net; owed += line.owed || 0;
      const row = body.insertRow();
      for (const value of [entry.date,line.pending ? entry.purpose + " (" + money(line.pending) + " paid)" : entry.purpose,names[line.fund],money(line.gross||0),money(line.fee||0),money(line.spent||0),money(line.transfer||0),money(net),money(line.owed||0)]) row.insertCell().textContent = value;
    }
    totals.textContent = body.rows.length ? `Net donations ${money(raised)}${view === "filing" ? " of $275.00" : ""}. Cash balance ${money(balance)}. Owed ${money(owed)}.` : "No transactions recorded yet.";
    if (view === "filing" && credited >= 27500) {
      document.querySelector('a.button').hidden = true;
      totals.textContent += " Fundraising complete.";
    }
    if (body.rows.length) document.querySelector("#journal").append(table);
  } catch { totals.textContent = "Financial records could not be loaded. Please refresh to try again."; }
})();
