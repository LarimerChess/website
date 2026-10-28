# Running your own club: checklist

Each section is a step in [the deployment guide](deploying.md), and its heading links to the step, which says how to do each item. Tick items off as you go; an item left unticked is the place to pick up again. To track your progress, paste this list into an issue in your fork.

For a site that shows only your calendar, do What you need through step 5, then LCCC_GOOGLE_CALENDAR_READ_TOKEN in step 8 and step 9's first four items. For the whole site, do everything; in step 7, pick Firebase or a spreadsheet.

## [What you need](deploying.md#what-you-need)

- [ ] A GitHub account ([sign up](https://github.com/signup)) or [organization](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/creating-a-new-organization-from-scratch) for the fork
- [ ] A domain (optional), from any registrar
- [ ] One Google account for the club, ideally [Google Workspace](https://workspace.google.com/) on your domain ([free for nonprofits](https://www.google.com/nonprofits/))
- [ ] US Chess memberships for your TDs ([join](https://new.uschess.org/join-us-chess))
- [ ] A US Chess affiliate ([apply](https://new.uschess.org/form/affiliate-new-membership), logged in; [FAQ](https://new.uschess.org/tournament-director-and-affiliate-frequently-asked-questions)), its ID, and your TDs' US Chess IDs
- [ ] [git](https://git-scm.com/downloads), [Python 3.15](https://www.python.org/downloads/), [Node 24](https://nodejs.org/en/download), and [Google Chrome](https://www.google.com/chrome/) on your computer

## [1. Fork and publish](deploying.md#1-fork-and-publish)

- [ ] Fork the repo, and set Pages to deploy from main, / (root)
- [ ] Domain: CNAME file, Pages custom domain, A and www CNAME records (DNS only on Cloudflare), verify.sh passes, Enforce HTTPS on
- [ ] Or no domain: CNAME deleted
- [ ] Actions turned on, scheduled workflows included
- [ ] Actions can push to main (workflow permissions, branch rules)
- [ ] docs-private.yml deleted
- [ ] Calendar syncs deleted, or adapted to your area
- [ ] This club's minutes, results pages, and event pages deleted

## [2. Make it your club](deploying.md#2-make-it-your-club)

- [ ] In register.js, ENDPOINT and LIVE_DB are "" and FIREBASE is null, until steps 6 and 7
- [ ] CLUB set to your club's exact name in all four places
- [ ] SITE, EVENTS_PAGE, robots.txt, and sitemap.xml point at your site
- [ ] PRESIDENT and every president@larimerchess.org changed
- [ ] DOMAIN in scripts/google_auth.py (gmail.com for a personal Google account)
- [ ] Time zone and state changed, if not Colorado
- [ ] Home, scholastic, privacy, events, and minutes pages rewritten
- [ ] share.png replaced
- [ ] ratings.json and rated-dates.json are {}, events.json is []
- [ ] Tests that name this club or its events updated
- [ ] Credit to the Larimer County Chess Club's site added (CC BY 4.0)
- [ ] The grep finds no mention of this club you didn't mean to keep

## [3. Google](deploying.md#3-google)

- [ ] [Cloud project](https://console.cloud.google.com/) with the Calendar, Sheets, and Gmail APIs enabled
- [ ] OAuth consent screen Internal, or External and In production
- [ ] Desktop OAuth client saved as ~/.config/lccc/google-client.json
- [ ] Python venv made, requirements installed
- [ ] google_auth.py run once, google-token.json made

## [4. US Chess](deploying.md#4-us-chess)

- [ ] [API key](https://ratings.uschess.org/portal/api-access) created and saved in ~/.config/lccc/uschess-api-key
- [ ] Affiliate ID and adult TDs in scripts/tds.json

## [5. Calendars](deploying.md#5-calendars)

- [ ] Club calendar and community calendar created and public
- [ ] Their IDs in CALENDARS
- [ ] Add to Google Calendar link in index.html points at your club calendar
- [ ] Club events' organizer is exactly CLUB
- [ ] Each event's location is Venue, Street, City, ST 12345
- [ ] Every event has its metadata (organizer, format, ages, rated, cost, and any others it needs)
- [ ] Fees in prices.json under each club event's page name
- [ ] update_calendar.py and build_pages.py run without errors

## [6. Registration and the TD desk](deploying.md#6-registration-and-the-td-desk)

- [ ] The site is published at SITE
- [ ] Registration Sheet with an Entries tab
- [ ] registration.gs and appsscript.json pasted into its Apps Script
- [ ] Script properties: TD_PASSWORD, USCHESS_API_KEY
- [ ] A function run once, every permission allowed, Gmail service listed
- [ ] Deployed as a web app: execute as me, access Anyone
- [ ] The /exec URL shows the greeting in a private window
- [ ] URL in ENDPOINT, sync_assets.py run, pushed
- [ ] Sheet shared with TDs only

## [7. Running tournaments](deploying.md#7-running-tournaments-firebase-or-a-spreadsheet)

Firebase:

- [ ] [Firebase project](https://console.firebase.google.com/) in the same Cloud project
- [ ] Realtime Database in locked mode; URL in LIVE_DB and FIREBASE_URL
- [ ] google_auth.py --firebase run, firebase_rules.py applied
- [ ] Web app config in FIREBASE; apiKey in FIREBASE_API_KEY
- [ ] Google and email link sign-in on; your domain authorized
- [ ] Each TD in the TDs tab

Or a spreadsheet:

- [ ] Tournaments in progress Sheet created and shared with TDs only
- [ ] Its ID in TOURNAMENT_SHEET_ID and TOURNAMENT_SHEET
- [ ] LIVE_DB is still "" and FIREBASE still null

Either way:

- [ ] sync_assets.py run, pushed

## [8. Tokens and secrets](deploying.md#8-tokens-and-secrets)

- [ ] LCCC_GOOGLE_CALENDAR_READ_TOKEN
- [ ] LCCC_GOOGLE_SHEETS_TOKEN
- [ ] LCCC_GOOGLE_FIREBASE_TOKEN (with Firebase)
- [ ] LCCC_GOOGLE_GMAIL_SEND_TOKEN
- [ ] LCCC_GOOGLE_CALENDAR_TOKEN (if you kept the syncs)
- [ ] USCHESS_API_KEY
- [ ] LCCC_TD_EMAILS
- [ ] LCCC_JUNIOR_TD_IDS (if you have junior TDs)

## [9. Check it and go live](deploying.md#9-check-it-and-go-live)

- [ ] The README's checks pass locally
- [ ] Check site passes on GitHub
- [ ] Update calendar, Results, Archive tournaments, and TD expirations each run once by hand, logs read
- [ ] Your events show on the home and Events pages
- [ ] Each club event has a page; rated ones have a Register form
- [ ] A test registration shows on Entries and in the Sheet, and its email arrives
- [ ] A TD signs in at /td/
- [ ] A test tournament shows on the Pairings page
- [ ] Test registration and tournament deleted

## Afterward

- [ ] [Keeping it running](deploying.md#keeping-it-running) read: redeploying the script, expired tokens, and updates from this repo
