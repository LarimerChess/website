// Loads every page in Chrome against a local server and checks what HTML validation can't: accessibility
// (axe, light and dark), the events page, the Register form, the TD desk, Pairings and Standings, and the
// menu at desktop and phone widths. Each file in tests/pages runs in its own Chrome, as many at once as
// there are cores, and its output is printed when it finishes.
//   node tests/check_pages.mjs [base URL, default http://127.0.0.1:8765] [file names in tests/pages, default all]
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";

const dir = new URL("pages/", import.meta.url);
const base = process.argv.slice(2).find((a) => /^https?:/.test(a)) || "http://127.0.0.1:8765";
const asked = process.argv.slice(2).filter((a) => !/^https?:/.test(a)).map((a) => a.replace(/(\.mjs)?$/, ".mjs"));
const all = readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "common.mjs");
const unknown = asked.filter((f) => !all.includes(f));
if (unknown.length) {
  console.log(`No such check file: ${unknown.join(", ")} (there are ${all.join(", ")})`);
  process.exit(1);
}
// Longest first, so the slowest file isn't left to run alone at the end; size stands in for time.
const queue = (asked.length ? asked : all).sort((a, b) => statSync(new URL(b, dir)).size - statSync(new URL(a, dir)).size);

const failed = [];
let failedChecks = 0;
const run = (file) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [new URL(file, dir).pathname, base]);
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child.on("close", (code) => {
    console.log(`--- ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)\n${output.trimEnd()}`);
    failedChecks += output.split("\n").filter((l) => l.startsWith("FAIL")).length;
    if (code) failed.push(file);
    resolve();
  });
});
await Promise.all([...Array(Math.min(availableParallelism(), queue.length))].map(async () => {
  for (let file; (file = queue.shift()); ) await run(file);
}));
if (failed.length) {
  console.log(`\n${failed.join(", ")} failed, with ${failedChecks} failed check(s); a file that stopped short shows its error above`);
  process.exit(1);
}
