// The menu: on one line at 1100px; on a phone it wraps, without covering the page or scrolling sideways.
import { PHONE, base, done, fail, failures, pages, pass, tabs } from "./common.mjs";

const failedBefore = failures.length;
await tabs(pages, async (layout, path) => {
  await layout.setViewport({ width: 1100, height: 800 });
  await layout.goto(base + path, { waitUntil: "networkidle0" });
  const wide = await layout.evaluate(() => {
    const tops = [...document.querySelectorAll(".site-nav li")].map((li) => Math.round(li.getBoundingClientRect().top));
    const brand = document.querySelector(".site-nav .brand").getBoundingClientRect();
    const list = document.querySelector(".site-nav ul").getBoundingClientRect();
    return { lines: new Set(tops).size, besideBrand: list.top < brand.bottom, footer: Boolean(document.querySelector('footer a[href="/minutes/"]')),
      menu: [...document.querySelectorAll(".site-nav li")].map((li) => li.textContent).join(", ") };
  });
  if (wide.lines !== 1 || !wide.besideBrand || !wide.footer || wide.menu !== "Events, Entries, Pairings, Standings, Results, Scholastic, Join") {
    fail(`menu at 1100px on ${path}: ${JSON.stringify(wide)}`);
  }
  await layout.setViewport(PHONE);
  await layout.goto(base + path, { waitUntil: "networkidle0" });
  const narrow = await layout.evaluate(() => ({ nav: document.querySelector(".site-nav").getBoundingClientRect().bottom,
    content: document.querySelector("main").getBoundingClientRect().top, wide: document.documentElement.scrollWidth, view: innerWidth }));
  if (narrow.content < narrow.nav || narrow.wide > narrow.view) fail(`${path} on a phone: ${JSON.stringify(narrow)}`);
});
if (failures.length === failedBefore) pass(`the menu fits one line at 1100px, and on a phone covers none of the ${pages.length} pages or makes them scroll sideways`);

await done();
