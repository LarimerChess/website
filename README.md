# Larimer County Chess Club

Website for the Larimer County Chess Club, served by GitHub Pages from the main branch.

Edit index.html to update content; style.css holds the styling, copied into each page's <style>.

When you add a page, such as new board minutes, add its URL to sitemap.xml. The tournament pages under events/ are listed for you (see Events).

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

The script accepts a registration only for a club event in the live events.json until its date, or its month's last date, starts. It checks the US Chess ID and last name against the public US Chess member lookup, refuses a second entry for the same player and date or month, and emails a confirmation with the fee due and a withdraw link. The fee depends on whether the player is an adult, a senior (65+), or under 18 on the event's date, which the script asks US Chess with the club's API key and remembers in the Sheet's Players tab for a year, or three months for a player under 18. The fees themselves are in prices.json, by the event's page name; each Register form shows the fee beside each choice. A row's kind is entry (a tournament date), night, or month, and its applies is a date, a month such as 2026-10, or all; the most specific row wins. The entry list shows name, US Chess ID, and regular rating; emails and fee categories stay in the Sheet. Anyone can register any member, so the TD checks the list before the event.

The Entries page, /entries/, lists who is registered for every upcoming tournament date and club night, from the script's ?entries=all; a night's list includes the month's registrations.

The TD desk at /td/ (noindex, out of the sitemap and navigation) is for registering walk-ups, marking who has paid, logging incidents, and removing entries. Incidents follow the Safe Play policy's §8: an expelled or removed player drops off that date's entries, public and on the desk, so they aren't paired again, and a barred player can't register; those three email the President. It searches US Chess by ID or name, Colorado players first, through the script, since US Chess's API doesn't allow calls from browsers. Every call carries the TD password, which the script checks against its TD_PASSWORD property and locks out for 15 minutes after ten wrong tries.

After changing scripts/registration.gs, paste it into the Sheet's Apps Script and deploy a new version of the existing deployment (Deploy → Manage deployments → Edit → New version), which keeps the URL.

## Pairings

pairing.js pairs Swiss rounds by the US Chess rules (chapter 2, rules 27 to 29) and computes standings with the default tiebreaks (34E): modified median, Solkoff, cumulative, and cumulative of opposition. It runs in the browser on the TD desk, and tests/test_pairing.mjs checks it against the rulebook's examples and simulated tournaments (`npm run test:pairing`). The TD reviews each round's pairings and can change them before posting, as the rulebook expects (29E7).

The TD desk's Run the tournament section (td-run.js) starts a tournament for the chosen event, with the registered entrants numbered by rating, checks players in each round (playing, half-point bye, absent, or withdrawn), pairs the round, lets the TD change any pairing, saves or posts it, and takes results board by board. A tournament date is one tournament; a club night's month is one Swiss, a round a night, so its key is the month. Quads (30G) group the players into fours by rating, number them by lot, pair from the round robin table in pairing.js, and rank each quad by score, Sonneborn-Berger, and the games between tied players (34F). The script keeps players, pairings, and results in the private Tournaments in progress spreadsheet (script property TOURNAMENT_SHEET_ID) until the tournament is finished and archived. The Pairings page, /pairings/ (pairings.js), shows each tournament's latest posted round and its standings, from the script's ?tournaments=current.

An arena has no rounds. arena.js scores it and pairs the next games from the queue of players waiting, and tests/test_arena.mjs checks it (`npm run test:arena`). An arena starts with the time after which no new games start. Its Run the tournament section (td-arena.js) shows the queue, where the TD puts players in and takes them out for a break, and pairs the players waiting when the TD asks, never after that time. It takes each game's Blood Pacts and result, after which both players wait again unless one forfeited, and shows the leaderboard and the finished games, whose results can be corrected. The queue and games live in the tournament spreadsheet's Queue and Arena tabs, which the script adds when they're missing, so every device sees the same arena. The Pairings page shows an arena's games in progress, who is waiting, the leaderboard, and recent results.

## TD expirations

The Action "TD expirations" (.github/workflows/td-expirations.yml) runs scripts/td_expirations.py every Monday. It reads the club's TDs from scripts/tds.json and asks the US Chess ratings API for each one's membership, TD certification, and SafeSport dates and for the affiliate's expiration, and fails, which emails a warning, when any is past or within 60 days. When a TD joins or leaves, change scripts/tds.json. Junior TDs are minors: their IDs go in the repository secret LCCC_JUNIOR_TD_IDS, never in the repo, and the output shows neither their names nor their dates. The API key is the secret USCHESS_API_KEY. When anything is due, the run also emails the list to president@larimerchess.org through Gmail, with a send-only token for that account in the secret LCCC_GOOGLE_GMAIL_SEND_TOKEN (made with docs/scripts/google_auth.py --gmail-send). To test the email, run the Action by hand with a large number of days, such as 400. Locally the script reads all three from ~/.config/lccc/ (uschess-api-key, junior-td-ids, and google-token-gmail-send.json) and emails only with --email.

## Checks

Every push runs .github/workflows/checks.yml: HTML validation, a JavaScript syntax check, a check that the pages built from events.json are current, the sitemap check, tests for the calendar import and the page builder, page checks in Chrome (axe accessibility in light and dark mode, the event filters, the Run by lines and Details links, the add-to-calendar menu, structured data, and the tournament pages), and internal links. External links are checked weekly. .github/workflows/docs-private.yml checks hourly that the docs repo is still private.

To run them locally:

```
npm ci
npm run check:html
python scripts/sync_assets.py --check
python scripts/build_pages.py --check
python tests/check_sitemap.py
python -m unittest discover -s tests
python -m http.server 8765 --bind 127.0.0.1 &
npm run check:pages
```

## License

Licensed under [CC BY 4.0](LICENSE). This does not cover material the club does not own, such as third-party photos and logos, or the club's name and logo, which remain the club's.

The knight in the site icon (favicon.svg, favicon.ico, apple-touch-icon.png, icon-512.png) is by Cburnett from Wikimedia Commons, used under the BSD license. See [ICON-LICENSE.txt](ICON-LICENSE.txt) for the notice and license text.
