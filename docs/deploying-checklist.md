# Running your own club: checklist

Each item is a step in [the deployment guide](deploying.md), under the same number; the guide says how. To track your progress, paste this list into an issue in your fork.

## What you need

- [ ] A GitHub account or organization for the fork
- [ ] A domain (optional)
- [ ] One Google account for the club, ideally Google Workspace on your domain
- [ ] A US Chess affiliate ID and your TDs' US Chess IDs
- [ ] git, Python 3.15, Node 24, and Google Chrome on your computer

## 1. Fork and publish

- [ ] Fork the repo, and set Pages to deploy from main, / (root)
- [ ] Domain: CNAME file, Pages custom domain, A and www CNAME records (DNS only on Cloudflare), verify.sh passes, Enforce HTTPS on
- [ ] Or no domain: CNAME deleted
- [ ] Actions turned on, scheduled workflows included
- [ ] Actions can push to main (workflow permissions, branch rules)
- [ ] docs-private.yml deleted
- [ ] Calendar syncs deleted, or adapted to your area
- [ ] This club's minutes, results pages, and event pages deleted

## 2. Make it your club

- [ ] CLUB set to your club's exact name in all four places
- [ ] SITE, EVENTS_PAGE, robots.txt, and sitemap.xml point at your site
- [ ] PRESIDENT and every president@larimerchess.org changed
- [ ] DOMAIN in scripts/google_auth.py
- [ ] Time zone and state changed, if not Colorado
- [ ] Home, scholastic, privacy, events, and minutes pages rewritten
- [ ] Add to Google Calendar link points at your calendar
- [ ] share.png replaced
- [ ] ratings.json and rated-dates.json are {}, events.json is []
- [ ] Credit to the Larimer County Chess Club's site added (CC BY 4.0)
- [ ] The grep finds no mention of this club you didn't mean to keep

## 3. Google

- [ ] Cloud project with the Calendar, Sheets, and Gmail APIs enabled
- [ ] OAuth consent screen Internal, or External and In production
- [ ] Desktop OAuth client saved as ~/.config/lccc/google-client.json
- [ ] Python venv made, requirements installed
- [ ] google_auth.py run once, google-token.json made

## 4. US Chess

- [ ] API key created and saved in ~/.config/lccc/uschess-api-key
- [ ] Affiliate ID and adult TDs in scripts/tds.json

## 5. Calendars

- [ ] Club calendar and community calendar created and public
- [ ] Their IDs in CALENDARS
- [ ] Club events' organizer is exactly CLUB
- [ ] Each event's location is Venue, Street, City, ST 12345
- [ ] Every event has its metadata (organizer, format, ages, rated, cost, and any others it needs)
- [ ] Fees in prices.json under each club event's page name
- [ ] update_calendar.py and build_pages.py run without errors

## 6. Registration and the TD desk

- [ ] Registration Sheet with an Entries tab
- [ ] registration.gs and appsscript.json pasted into its Apps Script
- [ ] Script properties: TD_PASSWORD, USCHESS_API_KEY
- [ ] A function run once, every permission allowed, Gmail service listed
- [ ] Deployed as a web app: execute as me, access Anyone
- [ ] The /exec URL shows the greeting in a private window
- [ ] URL in ENDPOINT, sync_assets.py run, pushed
- [ ] Sheet shared with TDs only

## 7. Running tournaments

Firebase:

- [ ] Firebase project in the same Cloud project
- [ ] Realtime Database in locked mode; URL in LIVE_DB and FIREBASE_URL
- [ ] google_auth.py --firebase run, firebase_rules.py applied
- [ ] Web app config in FIREBASE; apiKey in FIREBASE_API_KEY
- [ ] Google and email link sign-in on; your domain authorized
- [ ] Each TD in the TDs tab

Or a spreadsheet:

- [ ] Tournaments in progress Sheet created and shared with TDs only
- [ ] Its ID in TOURNAMENT_SHEET_ID and TOURNAMENT_SHEET
- [ ] LIVE_DB is "" and FIREBASE is null

Either way:

- [ ] sync_assets.py run, pushed, script redeployed as a new version

## 8. Tokens and secrets

- [ ] LCCC_GOOGLE_CALENDAR_READ_TOKEN
- [ ] LCCC_GOOGLE_SHEETS_TOKEN
- [ ] LCCC_GOOGLE_FIREBASE_TOKEN (with Firebase)
- [ ] LCCC_GOOGLE_GMAIL_SEND_TOKEN
- [ ] LCCC_GOOGLE_CALENDAR_TOKEN (if you kept the syncs)
- [ ] USCHESS_API_KEY
- [ ] LCCC_TD_EMAILS
- [ ] LCCC_JUNIOR_TD_IDS (if you have junior TDs)

## 9. Check it and go live

- [ ] The README's checks pass locally
- [ ] Check site passes on GitHub
- [ ] Update calendar, Results, Archive tournaments, and TD expirations each run once by hand, logs read
- [ ] Your events show on the home and Events pages
- [ ] Each club event has a page; rated ones have a Register form
- [ ] A test registration shows on Entries and in the Sheet, and its email arrives
- [ ] A TD signs in at /td/
- [ ] A test tournament shows on the Pairings page
- [ ] Test registration and tournament deleted
