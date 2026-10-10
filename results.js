// The Results page (results/): its table of finished tournaments, 20 to a page, with the page
// number kept in the address (?page=2). Without this script every row shows.

const resultsTable = document.querySelector(".results-table");
const resultsPages = document.querySelector(".results-pages");
const PER_PAGE = 20;

if (resultsTable && resultsPages) {
  const rows = [...resultsTable.tBodies[0].rows];
  const count = Math.ceil(rows.length / PER_PAGE);
  const button = (text, label) => Object.assign(document.createElement("button"),
    { type: "button", className: "button button-secondary", textContent: text, ariaLabel: label });
  const previous = button("Previous", "Previous page of results");
  const next = button("Next", "Next page of results");
  const where = Object.assign(document.createElement("span"), { role: "status" });
  resultsPages.append(previous, where, next);
  const show = (page, moveFocus) => {
    page = Math.min(Math.max(page, 1), count);
    rows.forEach((row, i) => { row.hidden = Math.floor(i / PER_PAGE) + 1 !== page; });
    where.textContent = `Page ${page} of ${count}`;
    previous.disabled = page === 1;
    next.disabled = page === count;
    history.replaceState(history.state, "", page === 1 ? location.pathname : `?page=${page}`);
    if (moveFocus) rows[(page - 1) * PER_PAGE].querySelector("a").focus();
    return page;
  };
  let page = show(Number(new URLSearchParams(location.search).get("page")) || 1, false);
  previous.addEventListener("click", () => { page = show(page - 1, true); });
  next.addEventListener("click", () => { page = show(page + 1, true); });
  resultsPages.hidden = count < 2;
}
