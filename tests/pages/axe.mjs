// axe on every page, in light and dark mode.
import { axeSource, base, done, fail, pages, tabs, pass } from "./common.mjs";

await tabs(pages, async (tab, path) => {
  for (const scheme of ["light", "dark"]) {
    await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await tab.goto(base + path, { waitUntil: "networkidle0" });
    await tab.evaluate(axeSource);
    const result = await tab.evaluate(() =>
      axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"] }));
    if (result.violations.length === 0) pass(`axe ${path} (${scheme})`);
    for (const v of result.violations) fail(`axe ${path} (${scheme}): ${v.id}: ${v.help} at ${v.nodes[0].target}`);
  }
});

await done();
