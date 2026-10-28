# Running your own club

This site can run another chess club's website: the calendar and event pages, online registration, entry lists, the TD desk, live pairings and standings, results pages once US Chess rates a tournament, and weekly checks on your TDs' certifications. This guide takes a fork from nothing to a working site. [The checklist](deploying-checklist.md) has the same steps as a list to tick off.

Do the steps in order; later ones need what earlier ones make. A static site with the calendar is done after step 5. Registration and the TD desk need steps 6 and 7, and the hourly and weekly Actions need step 8.

## What you need

- A GitHub account or organization to own the fork.
- A domain, if you want one. Without it the site is at <owner>.github.io/<repo>.
- One Google account for everything: it owns the calendars, the Sheets, the registration script, and the Firebase project, and it sends the club's mail. A Google Workspace account on your own domain is simplest.
- A US Chess affiliate, its affiliate ID, and your TDs' US Chess IDs.
- A US Chess API key, which a US Chess member creates.
- On your computer: git, Python 3.15, Node 24, and Google Chrome for the page checks.

## 1. Fork and publish

1. Fork the repo. In its Settings → Pages, deploy from a branch: main, folder / (root).
2. Pick the address:
   - With a domain, put it alone in CNAME, and in Settings → Pages → Custom domain. Point the domain at GitHub Pages: A records for the bare domain to 185.199.108.153, 185.199.109.153, 185.199.110.153, and 185.199.111.153, and a CNAME record for www to <owner>.github.io. On Cloudflare, keep the records DNS only (grey cloud), or GitHub can't issue the certificate. Set DOMAIN in verify.sh and run it to check the records. Once the certificate is issued, turn on Enforce HTTPS.
   - Without one, delete CNAME. The site is at https://<owner>.github.io/<repo>/, which is SITE in step 2.
3. GitHub turns off a fork's Actions. Turn them on in the Actions tab, and on each scheduled workflow GitHub lists as disabled.
4. In Settings → Actions → General → Workflow permissions, the Actions need to push to main. If a branch rule protects main, let github-actions[bot] push past it, or the Actions that commit fail.
5. Delete what only this club uses:
   - .github/workflows/docs-private.yml, which checks this club's private repo.
   - The four calendar syncs, scripts/sync_grandslam.py, sync_chessmates.py, sync_tournaments.py, and sync_evrpd.py, and .github/workflows/sync-calendars.yml. Keep them only to adapt to your area's events; they copy other groups' events in Colorado onto the community calendar.
   - The club's board minutes (minutes/ except minutes/index.html), results pages (results/ except results/index.html), and event pages (events/ except events/index.html). The Actions write your own results and event pages from your calendars.

## 2. Make it your club

Find every mention of the club's name, site, and address:

```
grep -rln "Larimer County Chess Club\|larimerchess\|Fort Collins\|Larimer" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude --exclude=events.json .
```

These settings take your values:

| What | Where |
|---|---|
| The club's name, which is how the site tells your events from others' (step 5) | CLUB in scripts/update_calendar.py, scripts/build_pages.py, calendar.js, and tests/pages/common.mjs |
| Your site's URL, with no slash at the end | SITE in scripts/registration.gs, scripts/build_pages.py, and scripts/archive_tournaments.py; EVENTS_PAGE and the larimerchess.org links in calendar.js; robots.txt; sitemap.xml |
| The address that sends and receives the club's mail | PRESIDENT in scripts/rating_check.mjs and scripts/td_expirations.py, and every president@larimerchess.org in the pages, the scripts, and registration.gs |
| Your Google Workspace domain, which sign-in insists on | DOMAIN in scripts/google_auth.py |
| Your US Chess affiliate ID and your TDs' names and US Chess IDs | scripts/tds.json. Junior TDs (minors) go only in a secret (step 8), never here. |
| Each club event's fees, and US Chess's rating charge | prices.json, keyed by each event's page name (step 5); the rating charge under fees.uschess, and the card processor's under fees.card |
| The calendars' IDs | CALENDARS in scripts/update_calendar.py (step 5) |
| The registration script's URL | ENDPOINT in register.js (step 6) |
| The tournament database, and the TD desk's sign-in | LIVE_DB and FIREBASE in register.js (step 7) |
| The Tournaments in progress spreadsheet's ID, if you don't use Firebase | TOURNAMENT_SHEET in scripts/archive_tournaments.py (step 7) |
| The time zone, if not Colorado's | every America/Denver, scripts/appsscript.json's timeZone among them: grep -rn America/Denver --exclude-dir=node_modules --exclude-dir=.claude . |
| The state, if not Colorado | the CO\|Colorado fallback in city() in scripts/update_calendar.py, and the city, state, and ZIP code that the rating report falls back to in reportFiles() in td-run.js |

Then:

1. Rewrite the pages' words for your club: index.html (home), scholastic/, privacy/, events/index.html's introduction, and minutes/index.html. Change the Add to Google Calendar link in index.html to your club calendar's (Google gives it under the calendar's Settings → Integrate calendar, once the calendar is public).
2. Replace share.png, the picture link previews show. The knight icons (favicon.svg, favicon.ico, apple-touch-icon.png, icon-512.png) may stay, with ICON-LICENSE.txt; the fonts may stay, with their OFL files.
3. Set ratings.json and rated-dates.json to {}, and events.json to [] until the first calendar import.
4. Update the tests that name this club or its events (tests/pages, tests/fixtures, and the tests that read them) as the checks in step 9 report them.
5. Run python scripts/sync_assets.py after changing style.css or any page's script, and the checks in the README before each push.

The site is licensed CC BY 4.0, so credit the Larimer County Chess Club's site somewhere on yours, such as the footer or your README. The license doesn't cover the club's name or logo.

## 3. Google

Everything in this step and the next ones is done signed in as the club's Google account.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, and enable the Google Calendar API, Google Sheets API, and Gmail API.
2. Set up the OAuth consent screen. With Workspace, choose Internal. With a personal Gmail account, choose External, then publish the app (In production): while it is in Testing, Google expires its sign-ins after seven days and every Action stops. With a personal account, also set DOMAIN in scripts/google_auth.py to gmail.com.
3. Under Credentials, create an OAuth client ID of type Desktop app, download its JSON, and save it as ~/.config/lccc/google-client.json.
4. Make the Python environment the scripts use:

```
python3.15 -m venv ~/.local/share/lccc/venv
~/.local/share/lccc/venv/bin/pip install -r scripts/requirements.txt
```

5. Sign in once for a local token that can do everything, google-token.json, which steps 5 and 7 use:

```
~/.local/share/lccc/venv/bin/python scripts/google_auth.py
```

Over SSH, forward the sign-in port from the machine with the browser first: ssh -N -L 8085:localhost:8085 <host>. The token never goes in a secret.

## 4. US Chess

1. A US Chess member creates an API key on the ratings portal's [API access page](https://ratings.uschess.org/portal/api-access). It shows only once; save it in ~/.config/lccc/uschess-api-key. The registration script uses it to tell a player's fee category, and the TD expirations Action to check your TDs.
2. Put your affiliate ID and your adult TDs in scripts/tds.json.

## 5. Calendars

1. Create two Google Calendars: the club's own events, and the community's, which holds other groups' events for the Events page. Make both public (Settings → Access permissions → Make available to public), so visitors can add them.
2. Put each calendar's ID, from Settings → Integrate calendar, in CALENDARS in scripts/update_calendar.py.
3. Add events. A club event is one whose organizer is exactly CLUB. Its title, less the club's name at the front, makes its page name: "Larimer County Chess Club First Saturday Classic" is events/first-saturday-classic/, and the key for its fees in prices.json is first-saturday-classic. A US Chess rated club event gets a Register form on its page.
4. Give each event a location in the form Venue, Street, City, ST 12345, so its page and search engines get the address.
5. Give each event its metadata. The hourly import reads private extended properties on each event, and fails, naming the event, when one is missing or wrong. FIELDS in scripts/update_calendar.py lists them and what each allows; organizer, format, ages, rated, and cost are required. Google Calendar's own screens can't set them, so set them through the Calendar API, for example with the token from step 3:

```python
import sys
sys.path.insert(0, "scripts")
from google_auth import credentials
from googleapiclient.discovery import build

calendar = build("calendar", "v3", credentials=credentials())
calendar.events().patch(calendarId="<calendar ID>", eventId="<event ID>", body={"extendedProperties": {"private": {
    "organizer": "Your Chess Club", "format": "tournament", "ages": "all", "rated": "yes", "cost": "paid",
    "pairing": "swiss", "rounds": "4"}}}).execute()
```

For a recurring event, patch the series' event, not one day's. The event's ID is in calendar.events().list(calendarId=...).

6. Check the import before pushing:

```
LCCC_GOOGLE_TOKEN="$(cat ~/.config/lccc/google-token.json)" python scripts/update_calendar.py events.json
python scripts/build_pages.py
```

## 6. Registration and the TD desk

scripts/registration.gs is the site's only server: an Apps Script in a Google Sheet, which keeps registrations, serves the entry lists and pairings, and runs the TD desk. The site must already be published at SITE, because the script reads the site's events.json and prices.json.

1. Create a Google Sheet for registrations with one tab, Entries. The script adds its columns and the other tabs (Payments, Contacts, Incidents, TDs, Closed events, and more) as it needs them.
2. In the Sheet, Extensions → Apps Script. Replace everything in Code.gs with scripts/registration.gs and save. In Project Settings, check Show "appsscript.json" manifest file in editor, and replace appsscript.json with scripts/appsscript.json. It lists the permissions the script needs; Google doesn't guess the database's.
3. In Project Settings → Script properties, add:

| Property | Value |
|---|---|
| TD_PASSWORD | A password you choose for the TD desk, used until Firebase sign-in is set up (step 7) |
| USCHESS_API_KEY | The key from step 4 |
| TOURNAMENT_SHEET_ID or FIREBASE_URL | Where running tournaments live (step 7) |
| FIREBASE_API_KEY | The Firebase web app's apiKey, for TD sign-in (step 7) |

4. In the editor, choose any function, such as checkPassword, and Run. Allow what it asks: the spreadsheets, outside requests (your site and US Chess), sending mail, reading mail, and the Firebase database. Google warns that the app isn't verified; it is your own, so go ahead (Advanced → Go to …). If the editor's Services list lacks Gmail, add it (Services + → Gmail API).
5. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone, not Anyone with Google account. Copy the URL, which ends in /exec.
6. Open the URL in a private window: it should show the plain greeting. A Google sign-in page means access isn't Anyone; fix it in Deploy → Manage deployments → Edit.
7. Put the URL in ENDPOINT in register.js, run python scripts/sync_assets.py, and push.
8. Share the Sheet with your TDs as editors. Never share it publicly; it holds players' emails, phones, and payments.

To change the script later, paste the new registration.gs, then Deploy → Manage deployments → Edit → Version: New version → Deploy. A new deployment would make a new URL that the site doesn't know. A change that adds a permission also needs the new appsscript.json and one run of any function, as in 4; deploying never asks for permissions.

The TD desk is at /td/, left out of the menu and of search engines.

## 7. Running tournaments: Firebase or a spreadsheet

Players, pairings, and results of running tournaments live in one of two places until US Chess rates the tournament and the Archive tournaments Action moves them to the site.

**A Firebase Realtime Database** (recommended) streams pairings, standings, and changes to the Pairings page and every TD desk within seconds, and lets each TD sign in to the desk with their own Google account or an emailed link instead of a shared password.

1. In the [Firebase console](https://console.firebase.google.com/), create a project, adding it to the Google Cloud project from step 3.
2. Build → Realtime Database → Create database, in locked mode. Its URL is https://<project>-default-rtdb.firebaseio.com, or the one the console shows. Put it in LIVE_DB in register.js and in the script property FIREBASE_URL.
3. Apply the site's rules, which let anyone read the public copies and nobody write but the club account:

```
~/.local/share/lccc/venv/bin/python scripts/google_auth.py --firebase
~/.local/share/lccc/venv/bin/python scripts/firebase_rules.py
```

4. Project settings → General → Your apps → add a Web app. Put its config's apiKey, authDomain, projectId, and appId in FIREBASE in register.js (they are public), and its apiKey in the script property FIREBASE_API_KEY.
5. Build → Authentication → Sign-in method: turn on Google, and Email/Password with Email link (passwordless sign-in). Under Settings → Authorized domains, add your site's domain.
6. In the registration Sheet's TDs tab (Email, Name, US Chess ID, Role), add a row for each TD. Only those addresses, verified, may use the desk; a blank Role is td. The script makes the tab the first time a TD signs in, or add it with those headings.
7. Run python scripts/sync_assets.py, push, and redeploy the script (step 6) if you changed its properties after deploying.

**A Google Sheet**, with no Firebase: the pages and desks poll instead, and TDs sign in with TD_PASSWORD.

1. Create an empty Google Sheet named Tournaments in progress; the script adds its tabs. Share it with your TDs, never publicly.
2. Put its ID, from its URL, in the script property TOURNAMENT_SHEET_ID and in TOURNAMENT_SHEET in scripts/archive_tournaments.py.
3. Set LIVE_DB in register.js to "" and FIREBASE to null, then run python scripts/sync_assets.py and push.

You can start with the spreadsheet and move to Firebase later: the script uses the database once FIREBASE_URL is set, and scripts/migrate_tournaments.py copies the spreadsheet's rows over. Switch on a day with no tournament running.

## 8. Tokens and secrets

Each Action gets a Google token that can do only its one job. Make each with scripts/google_auth.py, signed in as the club account; each lands in ~/.config/lccc/. Put each file's whole contents in the repo's Settings → Secrets and variables → Actions, or:

```
gh secret set NAME -R <owner>/<repo> < FILE
```

| Secret | How to make it | Used by |
|---|---|---|
| LCCC_GOOGLE_CALENDAR_READ_TOKEN | google_auth.py --calendar-read, google-token-calendar-read.json | Update calendar |
| LCCC_GOOGLE_SHEETS_TOKEN | google_auth.py --sheets, google-token-sheets.json | Archive tournaments |
| LCCC_GOOGLE_FIREBASE_TOKEN | google_auth.py --firebase, google-token-firebase.json (only with Firebase) | Archive tournaments |
| LCCC_GOOGLE_GMAIL_SEND_TOKEN | google_auth.py --gmail-send, google-token-gmail-send.json | Results, TD expirations |
| LCCC_GOOGLE_CALENDAR_TOKEN | google_auth.py --calendar, google-token-calendar.json (only if you kept the calendar syncs) | Sync calendars |
| USCHESS_API_KEY | The key from step 4 | TD expirations |
| LCCC_TD_EMAILS | JSON of each TD's US Chess ID and email, {"12345678": "td@example.org"}, for the reminders to report a tournament's results | Results |
| LCCC_JUNIOR_TD_IDS | The US Chess IDs of TDs who are minors, comma-separated; leave it out if you have none | TD expirations |

The secrets keep their LCCC names unless you rename them in the workflows too. Action logs are public, so nothing you add to a script may print an email address or a junior TD.

## 9. Check it and go live

1. Run the checks in the [README](../README.md#checks), and fix what they report. CHROME_PATH points the page checks at Chrome if it isn't /usr/bin/google-chrome.
2. Push. Check site runs the same checks on GitHub.
3. In the Actions tab, run each Action once by hand and read its log: Update calendar first, then Results, Archive tournaments, and TD expirations (with a large number of days, it sends a test email).
4. Open the site and check:
   - the home page and Events list show your events;
   - each club event has its own page, and a rated one has a Register form;
   - a test registration appears on the Entries page and in the Sheet, and its confirmation email arrives;
   - a TD can sign in at /td/;
   - a test tournament started on the desk shows on the Pairings page.
5. Delete the test registration and tournament from the Sheet or the desk.

## Keeping it running

- **The script** changes only when you paste and deploy it (step 6). Pushing registration.gs changes nothing live.
- **Tokens** from an External consent screen left in Testing expire in seven days; publish the app. A token also stops when its account's password changes or its access is removed under Google Account → Security → Third-party apps. Make it again and replace the secret.
- **Scheduled Actions** stop after 60 days without a commit to the repo. The Actions' own commits count, but a quiet summer may not have any; GitHub emails before it turns them off.
- **This repo's changes** can be merged into yours with Sync fork on GitHub, or git pull from it as a second remote. After merging, redo the settings in step 2 that the merge changed back, run the checks, and redeploy the script if registration.gs changed.
- **Backups.** scripts/backup_firebase.py copies the whole database to a local folder; run it from cron on a machine you trust.
