# Larimer County Chess Club

The website of the Larimer County Chess Club in Fort Collins, Colorado: [larimerchess.org](https://larimerchess.org). GitHub Pages serves the main branch as it is; there is no build step, so a push publishes at once.

How each part works is in the opening comment of its file. This README says where things are and what runs them. The private side, the Google Sheets, their setup, and the steps on the day of an event, is in the docs repo's events/registration.md.

## Pages

| Page | Files |
|---|---|
| Home, / | index.html; calendar.js fills the event cards from events.json |
| Events, /events/ | events/index.html with calendar.js's filters; each club event's page, events/<name>/, is written by scripts/build_pages.py and takes entries with register.js |
| Scholastic, /scholastic/ | calendar.js, showing the events tagged for youth |
| Entries, /entries/ | entries.js, which shows the live database's copy of the lists first once LIVE_DB in register.js is set |
| Pairings and Standings, /pairings/ and /standings/ | pairings.js, with pairing.js for Swiss, round robin, and quad sections, arena.js for arenas, and live.js to follow the live database once LIVE_DB in register.js is set |
| Results, /results/ | written by scripts/build_results.py; results.js pages the table |
| TD desk, /td/ (noindex, unlinked) | td.js, td-run.js, td-arena.js, td-contacts.js, pairing.js, arena.js, ratingreport.js, live.js |
| Board minutes, /minutes/ | by hand |

- **Styles.** style.css is copied into every page's <style>, so the first paint doesn't wait on another request. After changing style.css or any page's script, run python scripts/sync_assets.py, which copies it and updates each script link's ?v= stamp so browsers don't pair a new page with a cached old script. Never edit a page's <style> by hand.
- **Menu.** It is written by hand in each hand-written page and from NAV in scripts/build_pages.py in the pages it writes. It fits on one line at 1100px with little room left, so a new item likely means moving another to the footer.
- **New pages.** Add a hand-written page's URL to sitemap.xml. The Date pages Action keeps every page's lastmod.
- **Written pages.** Never edit events.json, events/<name>/, results/, the Event data in events/index.html, or the home page's marked data-event-time-control text by hand; the Actions below rewrite them. build_pages.py fills the home page's marked time control from the next event's description and checks it with --check.

## The registration script

scripts/registration.gs is the only server. It is an Apps Script in the private registration Sheet, deployed as a web app whose URL is ENDPOINT in register.js. It takes registrations, serves the public entry lists and tournaments, and runs the TD desk, which signs in with the password in its TD_PASSWORD property. Players, pairings, and results live in a second private spreadsheet, Tournaments in progress, until US Chess rates the tournament; once the script property FIREBASE_URL is set, they live in a Firebase Realtime Database instead, which also streams the public copies to the Pairings page and the TD desk, and keeps a copy of the entry lists that the Entries page shows while the script answers (LIVE_DB in register.js; database.rules.json).

What the site shows of them is public: names, US Chess IDs, ratings, pairings, results, and the byes players asked for, minors' included, as US Chess's crosstables and wall charts show them. Emails, phones, fees, payments, ages, and incidents stay in the Sheets.

Pushing registration.gs changes nothing live. Paste it into the Sheet's Extensions → Apps Script, then Deploy → Manage deployments → Edit → New version, which keeps the URL. Only the president's account can deploy it.

## Actions

| Action | When | What it runs | Secrets |
|---|---|---|---|
| Update calendar | hourly, and when the managed description source changes | scripts/sync_event_descriptions.py, update_calendar.py, then build_pages.py; checks saved tournament controls | LCCC_GOOGLE_CALENDAR_TOKEN, LCCC_GOOGLE_CALENDAR_READ_TOKEN, LCCC_GOOGLE_FIREBASE_TOKEN |
| Results | hourly | scripts/rating_check.mjs, build_results.py, and build_pages.py | LCCC_GOOGLE_GMAIL_SEND_TOKEN, LCCC_TD_EMAILS |
| Archive tournaments | daily, 10:30, 11:30, and 12:30 UTC | scripts/archive_tournaments.py, then again with --clear | LCCC_GOOGLE_SHEETS_TOKEN, LCCC_GOOGLE_FIREBASE_TOKEN |
| Sync calendars | daily, 13:15 UTC, and when tournament sync code changes | scripts/sync_grandslam.py, sync_chessmates.py, sync_tournaments.py (including club weekend conflicts), and sync_evrpd.py | LCCC_GOOGLE_CALENDAR_TOKEN |
| TD expirations | Mondays | scripts/td_expirations.py | USCHESS_API_KEY, LCCC_JUNIOR_TD_IDS, LCCC_GOOGLE_GMAIL_SEND_TOKEN |
| Date pages | each push that changes a page | build_pages.py, for the sitemap's lastmod dates | |
| Docs repo is private | hourly | fails if the docs repo can be seen | |
| Check site | each push, and weekly for external links | the checks below | |

Update calendar fails, naming the event, when an event's calendar metadata is missing or invalid, and leaves events.json alone. A tournament goes from Results to Archive tournaments: once US Chess rates it, rating_check.mjs adds it to ratings.json, the record of what US Chess has rated, and US Chess's first and last day for it to rated-dates.json, which its pages show; build_results.py writes its page; and the archive commits its rows beside the page, then clears them from the spreadsheet.

event-descriptions.json is the reviewed source for managed club event descriptions and website metadata. The private docs repo's scripts/export_event_descriptions.py exports selected event pages' public text and metadata into it, excluding internal notes. Update calendar first syncs those records to Google Calendar, checking each event's title and revision and reading the result back, then imports the live calendars and rebuilds the pages. The same Action runs on a source change and hourly, so a manual Calendar edit to a managed description is replaced by its reviewed source. Events absent from the source are imported without changing their descriptions.

An explicit previous_title permits a managed event to be renamed from that title; end_time sets its same-day end in America/Denver. These fields come from calendar_previous_title and calendar_end_time in the docs frontmatter. The sync preserves the start and recurrence and verifies the new title and end. Calendar metadata capacity sets a default public registration limit. The TD desk can override it per date; registration.gs saves those overrides automatically in script properties and checks capacity under the registration lock. TD registrations can exceed the public limit.

Monthly player totals can be fixed in prices.json's monthly_totals. build_pages.py writes the corresponding entry-fee rows for each listed month's nights, so the existing registration API can add the unchanged per-night rating fee and still charge the advertised total. These generated price rows are committed with the event pages. Under-18 entries retain their existing entry fee and per-night rating charge.

The Action also checks saved time controls for the managed events' current and future tournaments. A different saved value fails the check for the TD to inspect; it never relabels games already played or changes section overrides.

The Google tokens' secrets are each token's whole JSON file. scripts/google_auth.py makes them, signed in as president@larimerchess.org: --calendar-read, --calendar, --sheets, --firebase, or --gmail-send. LCCC_TD_EMAILS is JSON by US Chess ID. Junior TDs are minors, so their IDs are only in LCCC_JUNIOR_TD_IDS, never in the repo. Action logs are public: nothing may print an address or a junior TD.

The tournament sync preserves each listing's city in Calendar metadata. Multi-day tournaments at regular or dual-rated time controls are marked rated even without rating keywords. It also cancels individual future club tournament dates on the same weekend as a listed multi-day tournament, and restores only its own cancellations when the conflict disappears. It leaves classes, casual play, and manual cancellations alone. A private calendar event dated January 1, 1970 stores cancellation receipts so sparse Google tombstones can be restored; do not delete it. The hourly calendar import then regenerates the public event data and pages.

## Running scripts locally

Tokens, the US Chess API key, and the other secrets' local copies are in ~/.config/lccc/, outside every repo. The Python scripts that use Google need the venv at ~/.local/share/lccc/venv, with pip install -r scripts/requirements.txt. Each script's opening comment gives its options; the ones that change a calendar or a spreadsheet take --dry-run. Offline, from the fixtures in tests/fixtures/:

```
python3 scripts/build_results.py --from tests/fixtures/tournaments.json
python3 scripts/archive_tournaments.py --fixture tests/fixtures/sheets.json --ratings FILE --out DIR
node scripts/rating_check.mjs --now 2026-11-08T09:17 --from tests/fixtures/tournaments.json --uschess tests/fixtures/uschess.json
```

The president's machine runs scripts/backup_firebase.py from cron at 2:15 every night. It copies the whole database to ~/.local/share/lccc/backups, which is private to that account, and prunes old copies there.

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

tests/check_pages.mjs runs the files in tests/pages, each in its own Chrome and all at once. They drive the pages against a stand-in for the registration script, and check accessibility in light and dark mode and the layout at 1100px and on a 390px phone. New behavior gets a check in the file for its page, or in a new file there. To rerun only some files, name them: npm run check:pages -- desk menu. A push that changes nothing the site serves (only scripts/, .github/, or tests outside tests/pages) can skip check:pages.

## Running your own club

A fork can run another club's site. [docs/deploying.md](docs/deploying.md) says what it gives a club and takes it from fork to live site, and [docs/deploying-checklist.md](docs/deploying-checklist.md) is its checklist.

## License

Licensed under [CC BY 4.0](LICENSE). This does not cover material the club does not own, such as third-party photos and logos, or the club's name and logo, which remain the club's.

The knight in the site icon (favicon.svg, favicon.ico, apple-touch-icon.png, icon-512.png) is by Cburnett from Wikimedia Commons, used under the BSD license. See [ICON-LICENSE.txt](ICON-LICENSE.txt) for the notice and license text.
