const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// Use the deployed script's row encoding and index membership rules.
const script = fs.readFileSync(path.join(__dirname, "registration.gs"), "utf8");
const context = vm.createContext({ Utilities: {
  newBlob: value => ({ getBytes: () => Buffer.from(value) }),
  base64EncodeWebSafe: bytes => Buffer.from(bytes).toString("base64url"),
} });
vm.runInContext(script, context);
const definitions = vm.runInContext(`({
  Entries: HEADER, Payments: PAYMENT_HEADER, "Stripe checkout baskets": STRIPE_BASKET_HEADERS,
  "Stripe card quotes": STRIPE_CARD_HEADERS, "Stripe test payments": ["Session", "Intent", "Amount", "Reference", "Kind"],
  "Stripe review": ["Session", "Reason", "Recorded", "Snapshot", "Resolution"],
  "Stripe test review": ["Session", "Reason", "Recorded", "Snapshot", "Resolution"],
})`, context);
const keys = vm.runInContext("REGISTRATION_TABLES", context);

function registrationTables(tabs) {
  if (!tabs.Entries) throw new Error("Registration Entries tab missing");
  return Object.fromEntries(Object.entries(definitions).map(([name, required]) => {
    const [header = [], ...rows] = tabs[name] ?? [];
    const labels = header.map(value => value.trim());
    const nonempty = labels.filter(Boolean);
    if (new Set(nonempty).size !== nonempty.length) throw new Error(`Duplicate heading in ${name}`);
    const headings = [...new Set([...required, ...nonempty])];
    const table = { headings: JSON.stringify(headings) };
    if (rows.length) {
      table.rows = Object.fromEntries(rows.map((row, index) => [
        `r${index + 2}`, context.registrationRow_(headings.map(heading => row[labels.indexOf(heading)] ?? "")),
      ]));
    }
    return [keys[name], table];
  }));
}

function paymentLookup(tables) {
  const index = {};
  for (const key of Object.values(keys)) {
    const { headings, rows } = tables[key];
    const required = context.paymentLookupFields_(key);
    if (!required) continue;
    const col = Object.fromEntries(JSON.parse(headings).map((heading, i) => [heading, i]));
    if (required.some(heading => !(heading in col))) throw new Error(`Missing lookup headings in ${key}`);
    for (const [id, row] of Object.entries(rows || {})) {
      for (const [group, fields] of context.paymentLookupRow_(key, row, col)) {
        const grouped = index[group] ??= {};
        (grouped[key] ??= {})[id] = fields;
      }
    }
  }
  return index;
}

function paymentViews(tables, events, revision) {
  const labels = {};
  for (const event of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
    if (!event.page || !event.tags.includes("rated")) continue;
    const slug = event.page.split("/").filter(Boolean).at(-1);
    const label = { name: event.title.replace(/^Larimer County Chess Club\s*/, "") };
    labels[`${slug}/${event.start.slice(0, 10)}`] = label;
    if (!event.tags.includes("tournament")) labels[`${slug}/${event.start.slice(0, 7)}`] = label;
  }
  return context.paymentViewsFromLookup_(paymentLookup(tables), labels, revision);
}

module.exports = { registrationTables, paymentLookup, paymentViews };
if (require.main === module) {
  if (process.argv[2] === "--tabs") {
    console.log(JSON.stringify(Object.keys(definitions)));
  } else {
    const source = JSON.parse(fs.readFileSync(0, "utf8"));
    if (process.argv[2] === "--publish-balances") {
      console.log(JSON.stringify(paymentViews(source.tables, source.events, source.revision)));
    } else {
      const tables = process.argv[2] === "--rebuild-lookup" ? source : registrationTables(source);
      console.log(JSON.stringify({ tables, paymentLookup: paymentLookup(tables) }));
    }
  }
}
