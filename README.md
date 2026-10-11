# Larimer County Chess Club

The club's website, larimerchess.org. GitHub Pages serves the main branch as it is; there is no build step, so a push publishes at once.

How each part works is in the opening comment of its file. This README says where things are and what runs them. The private side, the Google Sheets, their setup, and the steps on the day of an event, is in the docs repo's events/registration.md.

## Pages

| Page | Files |
|---|---|
| Home, / | index.html; calendar.js fills the event cards from events.json |
| Events, /events/ | events/index.html with calendar.js's filters; each club event's page, events/<name>/, is written by scripts/build_pages.py and takes entries with register.js |
| Scholastic, /scholastic/ | calendar.js, showing the events tagged for youth |
| Entries, /entries/ | entries.js |
| Pairings and Standings, /pairings/ and /standings/ | pairings.js, with pairing.js for Swiss and quad tournaments and arena.js for arenas |
| Results, /results/ | written by scripts/build_results.py; results.js pages the table |
| TD desk, /td/ (noindex, unlinked) | td.js, td-run.js, td-arena.js, pairing.js, arena.js, ratingreport.js |
| Board minutes, /minutes/ | by hand |

- **Styles.** style.css is copied into every page's <style>, so the first paint doesn't wait on another request. After changing style.css or any page's script, run python scripts/sync_assets.py, which copies it and updates each script link's ?v= stamp so browsers don't pair a new page with a cached old script. Never edit a page's <style> by hand.
- **Menu.** It is written by hand in each hand-written page and from NAV in scripts/build_pages.py in the pages it writes. It fits on one line at 1100px with little room left, so a new item likely means moving another to the footer.
- **New pages.** Add a hand-written page's URL to sitemap.xml. The Date pages Action keeps every page's lastmod.
- **Written pages.** Never edit events.json, events/<name>/, results/, or the Event data in events/index.html by hand; the Actions below rewrite them.

## The registration script

scripts/registration.gs is the only server. It is an Apps Script in the private registration Sheet, deployed as a web app whose URL is ENDPOINT in register.js. It takes registrations, serves the public entry lists and tournaments, and runs the TD desk, which signs in with the password in its TD_PASSWORD property. Players, pairings, and results live in a second private spreadsheet, Tournaments in progress, until US Chess rates the tournament.

What the site shows of them is public: names, US Chess IDs, ratings, pairings, and results, minors' included, as US Chess's crosstables show them. Emails, phones, fees, payments, ages, and incidents stay in the Sheets.

Pushing registration.gs changes nothing live. Paste it into the Sheet's Extensions → Apps Script, then Deploy → Manage deployments → Edit → New version, which keeps the URL. Only the president's account can deploy it.

## Actions

| Action | When | What it runs | Secrets |
|---|---|---|---|
| Update calendar | hourly | scripts/update_calendar.py, then build_pages.py | LCCC_GOOGLE_CALENDAR_READ_TOKEN |
| Results | hourly | scripts/rating_check.mjs, build_results.py, and build_pages.py | LCCC_GOOGLE_GMAIL_SEND_TOKEN, LCCC_TD_EMAILS |
| Archive tournaments | daily, 10:30, 11:30, and 12:30 UTC | scripts/archive_tournaments.py, then again with --clear | LCCC_GOOGLE_SHEETS_TOKEN |
| Sync calendars | daily, 13:15 UTC | scripts/sync_grandslam.py, sync_chessmates.py, sync_tournaments.py, and sync_evrpd.py | LCCC_GOOGLE_CALENDAR_TOKEN |
| TD expirations | Mondays | scripts/td_expirations.py | USCHESS_API_KEY, LCCC_JUNIOR_TD_IDS, LCCC_GOOGLE_GMAIL_SEND_TOKEN |
| Date pages | each push that changes a page | build_pages.py, for the sitemap's lastmod dates | |
| Docs repo is private | hourly | fails if the docs repo can be seen | |
| Check site | each push, and weekly for external links | the checks below | |

Update calendar fails, naming the event, when an event's calendar metadata is missing or invalid, and leaves events.json alone. A tournament goes from Results to Archive tournaments: once US Chess rates it, rating_check.mjs adds it to ratings.json, the record of what US Chess has rated; build_results.py writes its page; and the archive commits its rows beside the page, then clears them from the spreadsheet.

The Google tokens' secrets are each token's whole JSON file. scripts/google_auth.py makes them, signed in as president@larimerchess.org: --calendar-read, --calendar, --sheets, or --gmail-send. LCCC_TD_EMAILS is JSON by US Chess ID. Junior TDs are minors, so their IDs are only in LCCC_JUNIOR_TD_IDS, never in the repo. Action logs are public: nothing may print an address or a junior TD.

## Running scripts locally

Tokens, the US Chess API key, and the other secrets' local copies are in ~/.config/lccc/, outside every repo. The Python scripts that use Google need the venv at ~/.local/share/lccc/venv, with pip install -r scripts/requirements.txt. Each script's opening comment gives its options; the ones that change a calendar or a spreadsheet take --dry-run. Offline, from the fixtures in tests/fixtures/:

```
python3 scripts/build_results.py --from tests/fixtures/tournaments.json
python3 scripts/archive_tournaments.py --fixture tests/fixtures/sheets.json --ratings FILE --out DIR
node scripts/rating_check.mjs --now 2026-11-08T09:17 --from tests/fixtures/tournaments.json --uschess tests/fixtures/uschess.json
```

## Checks

Check site runs these on every push; run them before pushing:

```
npm ci
npm run check:html
python scripts/sync_assets.py --check
python scripts/build_pages.py --check
python scripts/build_results.py --check
python tests/check_sitemap.py
python -m unittest discover -s tests
node --test tests/test_pairing.mjs tests/test_arena.mjs tests/test_registration.mjs tests/test_ratingreport.mjs tests/test_rating_check.mjs
python -m http.server 8765 --bind 127.0.0.1 &
npm run check:pages
```

tests/check_pages.mjs drives the pages in Chrome against a stand-in for the registration script, and checks accessibility in light and dark mode and the layout at 1100px and on a 390px phone. New behavior gets a check there.

## Running your own club

A fork runs another club's site. Do these steps once, in order.

### 1. Publish the fork

1. Fork the repo. In its Settings → Pages, deploy from the branch main, folder / (root).
2. Put your domain in CNAME, or delete CNAME to use <owner>.github.io/<repo>. Point the domain's DNS at GitHub Pages; verify.sh checks the records once DOMAIN in it is yours.
3. GitHub turns off a fork's scheduled Actions. Turn them on in the Actions tab.
4. Delete what only this club uses: .github/workflows/docs-private.yml, and the four calendar syncs (scripts/sync_*.py and .github/workflows/sync-calendars.yml) unless you adapt them to your area's events.

### 2. Make it your club

Change the club's name, site, and address wherever they appear:

```
grep -rln "Larimer County Chess Club\|larimerchess" --exclude-dir=node_modules --exclude-dir=.git .
```

These need your values too:

| What | Where |
|---|---|
| The club and community calendars' IDs (step 4) | CALENDARS in scripts/update_calendar.py |
| The Tournaments in progress spreadsheet's ID (step 5) | TOURNAMENT_SHEET in scripts/archive_tournaments.py |
| Your Google domain or account, which sign-in insists on | DOMAIN in scripts/google_auth.py |
| The address that sends and receives the club's mail | PRESIDENT in scripts/rating_check.mjs and scripts/td_expirations.py, and the president@ addresses in scripts/registration.gs and the pages |
| Your site's URL | SITE in scripts/registration.gs, scripts/build_pages.py, and scripts/archive_tournaments.py |
| Your US Chess affiliate ID and your TDs' US Chess IDs | scripts/tds.json |
| Each club event's fees by age | prices.json, by event page name |
| The time zone, if not Colorado's | every America/Denver: grep -rn America/Denver --exclude-dir=node_modules . |

Then set ratings.json to {}, and delete the club's minutes, results pages, and event pages; the Actions rewrite events.json and the event pages from your calendars.

### 3. Google

Use one Google account for everything, the one that owns the calendars and sends the club's mail. A Google Workspace account on your own domain is simplest.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the Google Calendar, Google Sheets, and Gmail APIs.
2. Set up the OAuth consent screen. With Workspace, choose Internal. With a personal Gmail account, choose External and then publish the app (In production): while it is in Testing, Google expires its sign-ins after seven days and every Action stops.
3. Under Credentials, create an OAuth client ID of type Desktop app, download its JSON, and save it as ~/.config/lccc/google-client.json.
4. Install the Python libraries: python3 -m venv ~/.local/share/lccc/venv, then ~/.local/share/lccc/venv/bin/pip install -r scripts/requirements.txt.

### 4. Calendars

Create two Google Calendars in that account: the club's own events, and the community's (other groups' events, shown on /events/). Put their IDs, from each calendar's settings, in CALENDARS. Every event needs metadata, private extended properties named in FIELDS in scripts/update_calendar.py (who runs it, its format, ages, rating, and cost); the hourly import fails on an event without it and names the event. Set them through the Calendar API, as extendedProperties.private. An event whose organizer is your club's name is a club event and gets its own page.

### 5. Sheets and the registration script

1. Create an empty Google Sheet for running tournaments, Tournaments in progress; the script adds its tabs. Copy its ID from its URL.
2. Create a Google Sheet for registrations with one tab, Entries; the script adds the rest. Extensions → Apps Script, and replace Code.gs with scripts/registration.gs.
3. In the script's Project Settings → Script properties, add TD_PASSWORD (a password you choose for the TD desk), USCHESS_API_KEY (step 6), and TOURNAMENT_SHEET_ID (the ID from 1).
4. Run any function, such as checkPassword, and allow what it asks: the spreadsheets, outside requests (your site and US Chess), and sending mail. Google warns the app isn't verified; it's your own, so go ahead (Advanced).
5. Deploy → New deployment → Web app, executing as you, with access for Anyone. Put its URL, which ends in /exec, in ENDPOINT in register.js, run python scripts/sync_assets.py, and push. Opening the URL should show the plain greeting.
6. Share both Sheets with your TDs, never publicly.

To change the script later, see The registration script above.

### 6. Tokens and secrets

Make each Google token by running scripts/google_auth.py with the venv's Python, signed in as the club account; each lands in ~/.config/lccc/. Over SSH, forward port 8085 from the machine with the browser first (ssh -L 8085:localhost:8085 <host>). Then put each file's whole contents in the repo's Settings → Secrets and variables → Actions, or use gh secret set NAME -R <owner>/<repo> < FILE.

| Secret | How to make it | Used by |
|---|---|---|
| LCCC_GOOGLE_CALENDAR_READ_TOKEN | google_auth.py --calendar-read, google-token-calendar-read.json | Update calendar |
| LCCC_GOOGLE_CALENDAR_TOKEN | google_auth.py --calendar, google-token-calendar.json | Sync calendars |
| LCCC_GOOGLE_SHEETS_TOKEN | google_auth.py --sheets, google-token-sheets.json | Archive tournaments |
| LCCC_GOOGLE_GMAIL_SEND_TOKEN | google_auth.py --gmail-send, google-token-gmail-send.json | Results, TD expirations |
| USCHESS_API_KEY | A US Chess member creates one on the ratings portal's [API access page](https://ratings.uschess.org/portal/api-access); it shows only once. It is also the script property in step 5. | TD expirations |
| LCCC_TD_EMAILS | JSON of each TD's US Chess ID and email, {"12345678": "td@example.org"} | Results |
| LCCC_JUNIOR_TD_IDS | The US Chess IDs of TDs who are minors, comma-separated, or leave it out | TD expirations |

Each token can do only its one job. google_auth.py without an option makes google-token.json, which can do everything, for running scripts locally; it never goes in a secret. The same files in ~/.config/lccc/ serve the scripts when run locally: uschess-api-key, td-emails.json, and junior-td-ids hold the last three.

Last, run each Action once by hand from the Actions tab and read its log.

## License

Licensed under [CC BY 4.0](LICENSE). This does not cover material the club does not own, such as third-party photos and logos, or the club's name and logo, which remain the club's.

The knight in the site icon (favicon.svg, favicon.ico, apple-touch-icon.png, icon-512.png) is by Cburnett from Wikimedia Commons, used under the BSD license. See [ICON-LICENSE.txt](ICON-LICENSE.txt) for the notice and license text.
