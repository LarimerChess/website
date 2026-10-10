"""Write a results page for each finished tournament, and the Results page that lists them.

    python scripts/build_results.py              # from the registration script's ?tournaments=current
    python scripts/build_results.py --from FILE  # from a saved copy of that JSON
    python scripts/build_results.py --check      # fail if results/index.html or sitemap.xml is out of date

- Each finished tournament gets results/<slug>/, the slug being its key with "/" as "-"
  (first-saturday-classic-2026-11-07). A Swiss shows its final standings with the US Chess
  tiebreaks, from pairing.js run with node, and a wall chart; a quad tournament, each quad's
  standings and crosstable; an arena, its leaderboard and games.
- The pages are written while the tournament is in the Tournaments in progress spreadsheet, and
  kept after the docs repo's archive Action clears it from there. Nothing here deletes a page.
- results/index.html lists every page under results/, newest first, and sitemap.xml gets an
  entry for each. build_pages.py dates them like any other page.

The Results Action runs this hourly, then build_pages.py.
"""

import hashlib
import html
import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_pages import CLUB, ROOT, SITE, TZ, escaped, page_html  # noqa: E402

GENERATED = "<!-- Written by scripts/build_results.py from the tournament results; don't edit by hand. -->"
RESULTS = ROOT / "results"
SHOWN = {"1-0": "1–0", "0-1": "0–1", "1/2-1/2": "½–½", "1F-0F": "1F–0F", "0F-1F": "0F–1F", "0F-0F": "0F–0F"}
POINTS = {"1-0": (1, 0), "0-1": (0, 1), "1/2-1/2": (0.5, 0.5), "1F-0F": (1, 0), "0F-1F": (0, 1), "0F-0F": (0, 0)}
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
CHART_KEY = ("Players by number. Each round shows the result and the opponent's number, then the color played "
             "(w or b) and the running score. W win, L loss, D draw, X win by forfeit, F loss by forfeit, "
             "B full-point bye, H half-point bye, U not played. Forfeits have no color.")


def endpoint():
    match = re.search(r'const ENDPOINT = "([^"]*)"', (ROOT / "register.js").read_text(encoding="utf-8"))
    return match[1] if match else ""


def fetch(url):
    with urllib.request.urlopen(f"{url}?tournaments=current", timeout=60) as response:
        body = response.read().decode("utf-8", "replace")
    try:
        return json.loads(body).get("tournaments", [])
    except ValueError:
        # A deployment older than the tournament code answers with its plain-text greeting. The
        # archive in the docs repo then waits for the pages, and says so in its log.
        print(f"::warning::The registration script answered ?tournaments=current with {body[:80]!r}, not JSON. "
              "Deploy the current scripts/registration.gs (README, Registration). No results pages written.")
        return []


def slug(key):
    return key.replace("/", "-")


def score_text(x):
    """1.5 as '1½', 0.5 as '½'."""
    whole, half = int(x), x - int(x) >= 0.5
    return (str(whole) if whole or not half else "") + ("½" if half else "")


def rating_text(p):
    return escaped(str(p["rating"])) if p.get("rating") is not None else "Unrated"


def date_text(date):
    """'2026-11-07' as 'November 7, 2026', and a month, '2026-10', as 'October 2026'."""
    year, month, *day = date.split("-")
    return f"{MONTHS[int(month) - 1]} {int(day[0])}, {year}" if day else f"{MONTHS[int(month) - 1]} {year}"


def pact(value):
    return "" if str(value).strip().lower() in ("", "no", "false", "0", "none") else "1"


def arena_games(t):
    return t.get("arena") or t.get("games") or []


def fingerprint(t):
    """What the page shows, as a hash. docs/scripts/archive_tournaments.py computes the same from the
    spreadsheet's rows and clears a tournament only when the published page carries it."""
    lines = [f"P {p['id']} {p.get('out') or ''}" for p in t["players"]]
    for n, r in enumerate(t["rounds"], 1):
        lines += [f"G {n} {g['board']} {g['white']} {g['black']} {g.get('result') or ''}" for g in r["games"]]
        lines += [f"B {n} {b['id']} {float(b.get('points') or 0):g}" for b in r.get("byes", [])]
    lines += [f"A {g.get('game')} {g['white']} {g['black']} {g.get('result') or ''} "
              f"{pact(g.get('whitePact'))} {pact(g.get('blackPact'))}" for g in arena_games(t)]
    return hashlib.sha256("\n".join(sorted(lines)).encode()).hexdigest()[:16]


def standings(t, function="standings"):
    """Pairing.standings from pairing.js: score, then modified median, Solkoff, cumulative, and
    cumulative of opposition (34E). With "quadStandings", a quad's: score, Sonneborn-Berger, then
    head-to-head. None if this pairing.js has no such function."""
    program = ("const P = require(process.argv[1]); const f = P[process.argv[2]]; let s = '';"
               "process.stdin.on('data', (d) => s += d)"
               ".on('end', () => console.log(JSON.stringify(f ? f(JSON.parse(s)) : null)));")
    tournament = {"players": [{"id": p["id"], "name": p["name"], "rating": p.get("rating")} for p in t["players"]],
                  "rounds": [{"games": r["games"], "byes": r.get("byes", []), "out": r.get("out", [])}
                             for r in t["rounds"]]}
    run = subprocess.run(["node", "-e", program, str(ROOT / "pairing.js"), function], input=json.dumps(tournament),
                         capture_output=True, text=True, check=True)
    return json.loads(run.stdout)


def wall_chart(t):
    """Each player's rounds as (code, opponent number, color, running score), US Chess codes:
    W, L, D, X (won by forfeit), F (lost by forfeit), B (full-point bye), H (half-point bye), U (not played)."""
    number = {p["id"]: p["number"] for p in t["players"]}
    rows = {p["id"]: [] for p in t["players"]}
    running = {p["id"]: 0.0 for p in t["players"]}
    for r in t["rounds"]:
        got = {}
        for g in r["games"]:
            result = g.get("result") or ""
            forfeit = "F" in result
            for me, them, color, side in ((g["white"], g["black"], "w", 0), (g["black"], g["white"], "b", 1)):
                points = POINTS[result][side] if result in POINTS else 0
                code = ("X" if points else "F") if forfeit else {1: "W", 0.5: "D", 0: "L"}[points] if result else "U"
                got[me] = (code, number.get(them), "" if forfeit or not result else color, points)
        for b in r.get("byes", []):
            points = float(b.get("points") or 0)
            got[b["id"]] = ({1: "B", 0.5: "H"}.get(points, "U"), None, "", points)
        for pid in rows:
            code, opponent, color, points = got.get(pid, ("U", None, "", 0))
            running[pid] += points
            rows[pid].append((code, opponent, color, running[pid]))
    return rows


def table(headings, rows, label, cls="entries"):
    """A table in a labeled region that scrolls sideways on narrow screens. A cell starting with <td is used as is."""
    head = "".join(f'<th scope="col">{h}</th>' for h in headings)
    body = "\n".join("          <tr>" + "".join(c if c.startswith("<td") else f"<td>{c}</td>" for c in row) + "</tr>"
                     for row in rows)
    return (f'<section class="td-table" aria-label="{html.escape(label)}" tabindex="0">\n'
            f'        <table class="{cls}">\n          <thead><tr>{head}</tr></thead>\n          <tbody>\n{body}\n'
            "          </tbody>\n        </table>\n      </section>")


def chart_table(t, label):
    """The wall chart by number, then a line for each player who withdrew."""
    chart = wall_chart(t)
    rows = []
    for p in sorted(t["players"], key=lambda p: p["number"]):
        cells = [str(p["number"]), escaped(p["name"]), rating_text(p)]
        for code, opponent, color, running in chart[p["id"]]:
            cells.append(f"<td>{code}{opponent or ''} <small>{color + ' ' if color else ''}{score_text(running)}</small></td>")
        cells.append(score_text(chart[p["id"]][-1][3] if chart[p["id"]] else 0))
        rows.append(cells)
    withdrawn = "".join(f"\n      <p>{escaped(p['name'])} withdrew from round {p['out']}.</p>"
                        for p in sorted(t["players"], key=lambda p: p["number"]) if p.get("out"))
    rounds = [f"Round {n}" for n in range(1, len(t["rounds"]) + 1)]
    return table(["No.", "Name", "Rating", *rounds, "Total"], rows, label, "entries wallchart") + withdrawn


def swiss_main(t):
    by_id = {p["id"]: p for p in t["players"]}
    rows = [[str(i), str(by_id[r["id"]]["number"]), escaped(r["name"]), r["id"], rating_text(by_id[r["id"]]),
             score_text(r["score"]), score_text(r["median"]), score_text(r["solkoff"]), score_text(r["cumulative"]),
             score_text(r["opposition"])]
            for i, r in enumerate(standings(t), 1)]
    return f"""<section id="standings">
      <h2>Final standings</h2>
      <p>Ties are broken by US Chess's default tiebreaks, in order: modified median, Solkoff, cumulative, and cumulative of opposition. Ratings are as the players entered.</p>
      {table(["Place", "No.", "Name", "US Chess ID", "Rating", "Score", "Median", "Solkoff", "Cumulative", "Opp. cumulative"], rows, "Final standings")}
    </section>

    <section id="wall-chart">
      <h2>Wall chart</h2>
      <p>{CHART_KEY}</p>
      {chart_table(t, "Wall chart")}
    </section>"""


def quad(p):
    """Numbers 1 to 4 are the first quad, 5 to 8 the second, and so on."""
    return (p["number"] - 1) // 4 + 1


def within(t, ids):
    """The tournament as only these players played it: their games with each other, and their byes."""
    rounds = [{"games": [g for g in r["games"] if g["white"] in ids and g["black"] in ids],
               "byes": [b for b in r.get("byes", []) if b["id"] in ids],
               "out": [i for i in r.get("out", []) if i in ids]} for r in t["rounds"]]
    return dict(t, players=[p for p in t["players"] if p["id"] in ids], rounds=rounds)


def sonneborn_berger(t):
    """Each player's score, and the sum of the scores of the opponents they beat plus half of those they drew."""
    score = {p["id"]: 0.0 for p in t["players"]}
    for r in t["rounds"]:
        for g in r["games"]:
            if g.get("result") in POINTS:
                score[g["white"]] += POINTS[g["result"]][0]
                score[g["black"]] += POINTS[g["result"]][1]
        for b in r.get("byes", []):
            score[b["id"]] += float(b.get("points") or 0)
    sb = dict.fromkeys(score, 0.0)
    for r in t["rounds"]:
        for g in r["games"]:
            if g.get("result") in POINTS and "F" not in g["result"]:
                sb[g["white"]] += POINTS[g["result"]][0] * score[g["black"]]
                sb[g["black"]] += POINTS[g["result"]][1] * score[g["white"]]
    return score, sb


def quad_main(t):
    sections = []
    for group in sorted({quad(p) for p in t["players"]}):
        q = within(t, {p["id"] for p in t["players"] if quad(p) == group})
        score, sb = sonneborn_berger(q)
        by_id = {p["id"]: p for p in q["players"]}
        # Without Pairing.quadStandings, rating stands in for head-to-head among players still tied.
        order = standings(q, "quadStandings") or sorted(
            q["players"], key=lambda p: (-score[p["id"]], -sb[p["id"]], -(p.get("rating") or 0)))
        rows = [[str(i), str(by_id[r["id"]]["number"]), escaped(by_id[r["id"]]["name"]), r["id"],
                 rating_text(by_id[r["id"]]), score_text(score[r["id"]]), score_text(sb[r["id"]])]
                for i, r in enumerate(order, 1)]
        sections.append(f"""<section id="quad-{group}">
      <h2>Quad {group}</h2>
      <h3>Final standings</h3>
      {table(["Place", "No.", "Name", "US Chess ID", "Rating", "Score", "Sonneborn-Berger"], rows, f"Quad {group} standings")}
      <h3>Crosstable</h3>
      {chart_table(q, f"Quad {group} crosstable")}
    </section>""")
    intro = ("<p>Each quad is a round robin of four players. Ties are broken by Sonneborn-Berger, then by the tied "
             f"players' games with each other. {CHART_KEY}</p>")
    return "\n\n    ".join([intro, *sections])


def arena_scores(t):
    """Leaderboard and each game's points, by the arena's rules: a win 2, a draw 1, a loss 0; after two
    wins in a row each further win is 3 until a loss or draw; a win with a Blood Pact earns 1 more
    when the opponent didn't take one. A forfeit counts as a win or a loss."""
    blank = lambda p: {"id": p["id"], "name": p["name"], "rating": p.get("rating"), "points": 0, "games": 0,
                       "wins": 0, "draws": 0, "losses": 0, "streak": 0}
    players = {p["id"]: blank(p) for p in t["players"]}
    scored = []
    for g in sorted(arena_games(t), key=lambda g: int(g.get("game") or 0)):
        result = g.get("result") or ""
        if result not in POINTS:
            continue
        got = []
        for me, side, mine, theirs in ((g["white"], 0, "whitePact", "blackPact"), (g["black"], 1, "blackPact", "whitePact")):
            p = players.setdefault(me, blank({"id": me, "name": me}))
            outcome = POINTS[result][side]
            p["games"] += 1
            if outcome == 1:
                points = (3 if p["streak"] >= 2 else 2) + (1 if pact(g.get(mine)) and not pact(g.get(theirs)) else 0)
                p["wins"] += 1
                p["streak"] += 1
            elif outcome == 0.5:
                points = 1
                p["draws"] += 1
                p["streak"] = 0
            else:
                points = 0
                p["losses"] += 1
                p["streak"] = 0
            p["points"] += points
            got.append(points)
        scored.append((g, got))
    board = sorted(players.values(), key=lambda p: (-p["points"], -p["wins"], -(p["rating"] or 0)))
    return board, scored


def arena_main(t):
    board, scored = arena_scores(t)
    names = {p["id"]: p["name"] for p in t["players"]}
    name = lambda pid: escaped(names.get(pid, pid))
    leader_rows = [[str(i), escaped(p["name"]), p["id"], rating_text(p), str(p["games"]), str(p["wins"]),
                    str(p["draws"]), str(p["losses"]), str(p["points"])] for i, p in enumerate(board, 1)]
    pacts = lambda g: ", ".join(name(g[side]) for side in ("white", "black") if pact(g.get(side + "Pact"))) or "None"
    game_rows = [[str(g.get("game") or ""), name(g["white"]), name(g["black"]), SHOWN[g["result"]], f"{got[0]}–{got[1]}",
                  pacts(g)] for g, got in scored]
    return f"""<section id="standings">
      <h2>Final leaderboard</h2>
      <p>A win scores 2 points, a draw 1, and a loss 0. After two wins in a row, each further win scores 3 until a loss or a draw, and a win with a Blood Pact scores 1 more when the opponent kept the full time.</p>
      {table(["Place", "Name", "US Chess ID", "Rating", "Games", "Wins", "Draws", "Losses", "Points"], leader_rows, "Final leaderboard")}
    </section>

    <section id="games">
      <h2>Games</h2>
      {table(["Game", "White", "Black", "Result", "Points", "Blood Pact"], game_rows, "Games")}
    </section>"""


def results_page(t):
    date = t["key"].rsplit("/", 1)[-1]
    name = t["name"]
    form = t.get("format") or "swiss"
    shows = {"arena": "leaderboard and games", "quad": "standings and crosstables"}.get(form, "standings and wall chart")
    kind = {"arena": "arena tournament", "quad": "quad tournament"}.get(form, f"{len(t['rounds'])}-round Swiss")
    description = f"Final {shows} of the {name}, a US Chess rated {kind} of the {CLUB} in Fort Collins, Colorado."
    body = {"arena": arena_main, "quad": quad_main}.get(form, swiss_main)(t)
    main = f"""<h1>{escaped(name)}</h1>
    <p>A US Chess rated {kind} of the {CLUB} in Fort Collins, Colorado, <time datetime="{date}">{date_text(date)}</time>.</p>

    {body}

    <p><a href="/results/">All tournament results</a></p>"""
    return page_html(f"{name} results", description, f"{SITE}/results/{slug(t['key'])}/", main,
                     main_attributes=f' data-results="{fingerprint(t)}"', generated=GENERATED)


def listed():
    """Every results page as (path, name, date), newest first."""
    pages = []
    for file in RESULTS.glob("*/index.html"):
        text = file.read_text(encoding="utf-8")
        name, date = re.search(r"<h1>(.*?)</h1>", text), re.search(r'<time datetime="([^"]+)"', text)
        pages.append((f"results/{file.parent.name}/", name[1] if name else file.parent.name, date[1] if date else ""))
    return sorted(pages, key=lambda p: (p[2], p[0]), reverse=True)


def index_page():
    pages = listed()
    items = "\n".join(f'        <li><a href="/{path}">{name}</a>, <time datetime="{date}">{date_text(date)}</time></li>'
                      for path, name, date in pages)
    body = f"<ul>\n{items}\n      </ul>" if pages else "<p>Results are posted here after each tournament is finished.</p>"
    main = f"""<h1>Results</h1>
    <p>Final standings and wall charts of the club's US Chess rated tournaments. Tournaments in progress are on the <a href="/pairings/">Pairings</a> page.</p>
    <section id="all-results">
      <h2>Tournaments</h2>
      {body}
    </section>"""
    return page_html(f"Results · {CLUB}",
                     "Final standings and wall charts of Larimer County Chess Club tournaments in Fort Collins, Colorado.",
                     f"{SITE}/results/", main, depth=1, current="/results/", generated=GENERATED)


def sitemap(text, paths, today):
    """sitemap.xml with an entry for each results page, after the last results/ entry."""
    have = set(re.findall(r"<loc>([^<]+)</loc>", text))
    new = "".join(f"  <url><loc>{SITE}/{path}</loc><lastmod>{today}</lastmod></url>\n"
                  for path in sorted(paths) if f"{SITE}/{path}" not in have)
    entries = list(re.finditer(re.escape(f"<url><loc>{SITE}/results/") + r".*?</url>\n", text))
    if not entries:
        sys.exit(f"sitemap.xml has no entry for {SITE}/results/ to put the results pages after.")
    return text[:entries[-1].end()] + new + text[entries[-1].end():]


def main(args):
    check = "--check" in args
    writes = {}
    if not check:
        if "--from" in args:
            data = json.loads(Path(args[args.index("--from") + 1]).read_text(encoding="utf-8"))
            tournaments = data.get("tournaments", []) if isinstance(data, dict) else data
        else:
            tournaments = fetch(endpoint()) if endpoint() else []
        for t in tournaments:
            if t.get("status") != "finished":
                continue
            if not t["rounds"] and not arena_games(t):
                print(f"skipped {t['key']}: finished with nothing posted")
                continue
            writes[f"results/{slug(t['key'])}/index.html"] = results_page(t)
        for path, text in writes.items():
            (ROOT / path).parent.mkdir(parents=True, exist_ok=True)
            (ROOT / path).write_text(text, encoding="utf-8")
    today = datetime.now(TZ).date().isoformat()
    paths = [path for path, _, _ in listed()]
    expected = {"results/index.html": index_page(),
                "sitemap.xml": sitemap((ROOT / "sitemap.xml").read_text(encoding="utf-8"), paths, today)}
    stale = [path for path, text in expected.items()
             if not (ROOT / path).exists() or (ROOT / path).read_text(encoding="utf-8") != text]
    if check:
        for path in stale:
            print(f"FAIL {path}: out of date with the results pages; run python scripts/build_results.py")
        if stale:
            sys.exit(1)
        print(f"ok   results/index.html and sitemap.xml list all {len(paths)} results pages")
        return
    for path in stale:
        (ROOT / path).write_text(expected[path], encoding="utf-8")
    print(f"wrote {len(writes)} results page(s){': ' + ', '.join(writes) if writes else ''};"
          f" updated {', '.join(stale) or 'nothing else'}")


if __name__ == "__main__":
    main(sys.argv[1:])
