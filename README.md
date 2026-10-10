# Larimer County Chess Club

Website for the Larimer County Chess Club, served by GitHub Pages from the main branch.

Edit index.html to update content; style.css holds the styling, copied into each page's <style>.

When you add a page, such as new board minutes, add its URL to sitemap.xml. The tournament pages under events/ are listed for you (see Events).

The menu at the top of every page is written by hand in each hand-written page and from NAV in scripts/build_pages.py in the pages it writes; Board minutes is in the footer. The menu fits on one line at 1100px, which the page checks enforce, with little room left: a new item likely means moving another to the footer.

After changing calendar.js or style.css, run python scripts/sync_assets.py. It copies style.css into every page, so the first paint doesn't wait on another request, and updates the ?v= stamp on every page's link to calendar.js, so browsers don't pair a new page with a cached old script. Never edit a page's <style> by hand. CI fails if a page is out of date.

## Events

The event cards come from events.json, which the Action "Update calendar" (.github/workflows/calendar.yml) rebuilds hourly with scripts/update_calendar.py. Don't edit events.json by hand. The script reads the club and community Google Calendars through the Calendar API, with a read-only OAuth token in the repository secret LCCC_GOOGLE_CALENDAR_READ_TOKEN, because the public iCal feeds leave out each event's metadata: private extended properties that say who runs it, its format, ages, rating, cost, and Details link. The filters use only that metadata, never titles or descriptions. FIELDS in the script lists the fields. If an event has missing or invalid metadata, the run fails, names the event, and leaves events.json alone.

Then scripts/build_pages.py writes what search engines should read without running JavaScript, all from events.json: the schema.org Event data in events/index.html, a page for each club event at events/<name>/ (named from its calendar title), and the sitemap's entries for them and lastmod dates. Every other page's lastmod is the day of the last commit that changed its text; the Date pages Action moves it after each push. Never edit those pages by hand; a page whose event has left events.json is deleted. Renaming a club event in Google Calendar moves its page, and the run fails if a hand-written page still links to the old one.

To run it locally, with a token JSON from ~/.config/lccc/:

```
LCCC_GOOGLE_TOKEN="$(cat ~/.config/lccc/google-token-calendar-read.json)" python3 scripts/update_calendar.py
python3 scripts/build_pages.py
```

## Registration

Registering for club events is the site's main call to action. Every club event's card offers Register, as do its details, at the top and bottom. Each club event's page has a Register form and the list of players registered, from register.js: a tournament takes entries by date, Monday Club Night by the night or the whole month. Players pay when they arrive. The home page's two cards, filled by calendar.js, point to the next Monday Club Night and the next tournament; through a month's second Monday the club night card asks players to register for the month, and after it to drop in. Entries are kept in a private Google Sheet, through the Apps Script in scripts/registration.gs, which runs in that Sheet as president@larimerchess.org and is deployed as a web app anyone can call. ENDPOINT in register.js is its URL; while it is empty, the pages say registration isn't open yet.

The form remembers the players registered from each browser, in its localStorage and never sent anywhere, so a returning player or a parent with several kids fills it in with one tap; Remember this player on this device, checked by default, decides whether a registration is kept. Chrome also saves what was typed for its own autofill, which follows a signed-in user to other devices. Browsers keep those values by field name across every site, so the US Chess ID field is named uschess-id, and register.js sends it to the script as id.

The script accepts a registration only for a club event in the live events.json until its date, or its month's last date, starts. It checks the US Chess ID and last name against the public US Chess member lookup, refuses a second entry for the same player and date or month, and emails a confirmation with the fee due and a withdraw link. The fee depends on whether the player is an adult, a senior (65+), or under 18 on the event's date, which the script asks US Chess with the club's API key and remembers in the Sheet's Players tab for a year, or three months for a player under 18. The fees themselves are in prices.json, by the event's page name; each Register form shows the fee beside each choice. A row's kind is entry (a tournament date), night, or month, and its applies is a date, a month such as 2026-10, or all; the most specific row wins. The entry list shows name, US Chess ID, and regular rating; emails and fee categories stay in the Sheet. Anyone can register any member, so the TD checks the list before the event.

The Entries page, /entries/, shows who is registered for the upcoming tournament date or club night the reader picks, from the script's ?entries=all; a night's list includes the month's registrations. It opens on ?event=<key> if the address has one, else the soonest event, and keeps the choice in the address.

The TD desk at /td/ (noindex, out of the sitemap and navigation) is for registering walk-ups, marking who has paid, logging incidents, and removing entries. Incidents follow the Safe Play policy's §8: an expelled or removed player drops off that date's entries, public and on the desk, so they aren't paired again, and a barred player can't register; those three email the President. It searches US Chess by ID or name, Colorado players first, through the script, since US Chess's API doesn't allow calls from browsers. When the TD picks a player, the desk fills in the email from their last registration, or from the club contact with the same first and last name in the registration Sheet's private Contacts tab, and shows their phone, which is saved with the entry. Every call carries the TD password, which the script checks against its TD_PASSWORD property and locks out for 15 minutes after ten wrong tries.

After changing scripts/registration.gs, paste it into the Sheet's Apps Script and deploy a new version of the existing deployment (Deploy → Manage deployments → Edit → New version), which keeps the URL.

## Pairings

pairing.js pairs Swiss rounds by the US Chess rules (chapter 2, rules 27 to 29) and computes standings with the default tiebreaks (34E): modified median, Solkoff, cumulative, and cumulative of opposition. It runs in the browser on the TD desk, and tests/test_pairing.mjs checks it against the rulebook's examples and simulated tournaments (`npm run test:pairing`). The TD reviews each round's pairings and can change them before posting, as the rulebook expects (29E7).

The TD desk's Run the tournament section (td-run.js) starts a tournament for the chosen event, with the registered entrants numbered by rating, checks players in each round (everyone starts as present and the TD changes anyone who isn't; anyone else's round is unplayed, or a half-point or zero-point bye they asked for, or they are withdrawn; in a quad, a player not here loses that game by forfeit). A round without a game is one of four kinds, full-point bye, half-point bye, zero-point bye, or unplayed, and the TD can reclassify any of them later under Standings; the score follows, pairs the round, lets the TD change any pairing, saves or posts it, and takes results board by board. A tournament date is one tournament; a club night's month is one Swiss, a round a night, so its key is the month. Quads (30G) group the players into fours by rating, number them by lot, pair from the round robin table in pairing.js, and rank each quad by score, Sonneborn-Berger, and the games between tied players (34F). The script keeps players, pairings, and results in the private Tournaments in progress spreadsheet (script property TOURNAMENT_SHEET_ID) until the tournament is finished and archived.

The TD reviews each round's pairings in an editor, by section: change either player on a board (the player chosen swaps places with whoever had the seat, so nobody is lost or doubled), swap a board's colors, remove a board (its players are then not yet paired), add a board from players without a game, take a player out of a game for a round without a game of any kind, and set a forfeit. Boards are numbered again within each section. Save and Post wait until every player who plays the round is on one board or has one round without a game, and list what is missing. Pair by hand starts the round with no boards: the players present are not yet paired, the others unplayed or on the byes they asked for. A posted round with no results yet can be changed with Edit pairings (29G); saving or posting replaces its rows, which also clears any reports for it, and the script refuses once the round has a result.

Players report their own results on the Pairings page, for a posted round of a running Swiss or quad: a board whose White or Black is saved on that device (by the Register form, or by typing a US Chess ID on the Pairings page; the two share one list, so the Pairings page lists the same saved players, fills in the most recent one's ID, and has the same Remember choice and Forget buttons) gets buttons for 1–0, 0–1, and ½–½. The script's public report action checks that the ID is on that board in that posted round and the board has no result, is limited like public registrations, and keeps the report in the Rounds tab's White report and Black report columns, never in Result. Nothing proves who is reporting, so a report counts only once the TD confirms it: the Pairings page shows it as awaiting the TD, and the standings leave it out. On the desk each board shows its reports, with Confirm for a single report or two that agree, Confirm agreed results for every board both players reported alike, and conflicting reports flagged; the TD's result menu still sets or overrides any result.

A Swiss can have sections, such as Open and Under 1400, each paired and ranked on its own, as if a tournament of its own (28A, 29); a player plays in one. The TD names them when starting, one Open section by default, each with an optional rating limit: a section takes players rated under its limit, and unrated players. Starting puts each player in the section with the lowest limit their rating is under, and players added later the same way; until round 1 is posted the TD can move a player up to a higher section (never down) or change the sections, which places everyone again. Each quad is a section, Quad 1, Quad 2, and so on. All sections play each round together, since they share the schedule: one check-in, one Pair the round that pairs each section on its own, one review, and one Post, with each section in its own tables and its boards numbered from 1. Pairing.sections in pairing.js splits a tournament into its sections, numbering their players 1 up within each. The Tournaments tab's Sections column holds the sections as JSON, and the Players and Rounds tabs' Section column says which each row belongs to; the script adds those columns when they're missing. A tournament started before sections has none of them and runs as one section, or as quads by number, as it always did.

The Pairings page, /pairings/ (pairings.js), shows each tournament in progress, from the script's ?tournaments=current, with a table for each section and a menu of its posted rounds that starts at the latest. The Standings page, /standings/, also from pairings.js, shows each section's standings after the latest round with results, or after an earlier one from its menu: a Swiss's with the tiebreaks above, a quad's with Sonneborn-Berger and head-to-head.

An arena has no rounds. arena.js scores it and pairs the next games from the queue of players waiting, and tests/test_arena.mjs checks it (`npm run test:arena`). An arena starts with the time after which no new games start. Its Run the tournament section (td-arena.js) shows the queue, where the TD puts players in and takes them out for a break, and pairs the players waiting when the TD asks, never after that time. It takes each game's Blood Pacts and result, after which both players wait again unless one forfeited, and shows the leaderboard and the finished games, whose results can be corrected. The queue and games live in the tournament spreadsheet's Queue and Arena tabs, which the script adds when they're missing, so every device sees the same arena. The Pairings page shows an arena's games in progress, who is waiting, and recent results; the Standings page, its leaderboard.

## Results

When the TD finishes a tournament, the Action "Results" (.github/workflows/results.yml) writes its page within the hour: scripts/build_results.py reads the finished tournaments from the script's ?tournaments=current and writes results/<event>-<date>/ (results/monday-club-night-at-peak-2026-10/ for a club night's month). A Swiss gets its final standings, with the tiebreaks from pairing.js run in node, and a wall chart in the US Chess style: each round's result and opponent's number, the color, and the running score, with forfeits, byes, and unplayed rounds marked. A Swiss in sections gets both for each section, its players numbered within it. A quad tournament gets each quad's standings and crosstable; an arena, its leaderboard and games. The pages show names, US Chess IDs, ratings, and results, as US Chess's crosstables do, and nothing from the registration Sheet. The Results page, /results/, lists them all in a table, newest first, which results.js shows 20 rows a page (?page=2 in the address); each gets a sitemap entry.

The pages are written once and committed, because the docs repo's Archive tournaments Action then archives the tournament and clears it from the Tournaments in progress spreadsheet; it clears one only when its page here answers with the same rows, which build_results.py records in the page's data-results attribute. A row's section counts only when it has one, so a tournament without sections has the same fingerprint as before them. Nothing deletes a results page, and a page whose tournament has been cleared is never rewritten, so a later correction is made by hand. To build pages from saved data, as tests/test_build_results.py does: `python3 scripts/build_results.py --from tests/fixtures/tournaments.json`.

## TD expirations

The Action "TD expirations" (.github/workflows/td-expirations.yml) runs scripts/td_expirations.py every Monday. It reads the club's TDs from scripts/tds.json and asks the US Chess ratings API for each one's membership, TD certification, and SafeSport dates and for the affiliate's expiration, and fails, which emails a warning, when any is past or within 60 days. When a TD joins or leaves, change scripts/tds.json. Junior TDs are minors: their IDs go in the repository secret LCCC_JUNIOR_TD_IDS, never in the repo, and the output shows neither their names nor their dates. The API key is the secret USCHESS_API_KEY. When anything is due, the run also emails the list to president@larimerchess.org through Gmail, with a send-only token for that account in the secret LCCC_GOOGLE_GMAIL_SEND_TOKEN (made with docs/scripts/google_auth.py --gmail-send). To test the email, run the Action by hand with a large number of days, such as 400. Locally the script reads all three from ~/.config/lccc/ (uschess-api-key, junior-td-ids, and google-token-gmail-send.json) and emails only with --email.

## Checks

Every push runs .github/workflows/checks.yml: HTML validation, a JavaScript syntax check, a check that the pages built from events.json are current, that the Results page lists every results page, the sitemap check, tests for the calendar import, the page builder, and the results pages, tests for the pairing engine, arenas, and the registration script's running tournaments (tests/test_registration.mjs, against in-memory sheets, including one from before sections, and players' reports), page checks in Chrome (axe accessibility in light and dark mode, the event filters, the Run by lines and Details links, the add-to-calendar menu, structured data, the tournament, Pairings, Standings, and results pages, reporting a result, a Swiss in two sections on the TD desk, confirming reports, editing pairings, pairing by hand, and changing a posted round, and the menu on one line at 1100px and on a 390px phone), and internal links. External links are checked weekly. .github/workflows/docs-private.yml checks hourly that the docs repo is still private.

To run them locally:

```
npm ci
npm run check:html
python scripts/sync_assets.py --check
python scripts/build_pages.py --check
python scripts/build_results.py --check
python tests/check_sitemap.py
python -m unittest discover -s tests
node --test tests/test_pairing.mjs tests/test_arena.mjs tests/test_registration.mjs
python -m http.server 8765 --bind 127.0.0.1 &
npm run check:pages
```

## License

Licensed under [CC BY 4.0](LICENSE). This does not cover material the club does not own, such as third-party photos and logos, or the club's name and logo, which remain the club's.

The knight in the site icon (favicon.svg, favicon.ico, apple-touch-icon.png, icon-512.png) is by Cburnett from Wikimedia Commons, used under the BSD license. See [ICON-LICENSE.txt](ICON-LICENSE.txt) for the notice and license text.
