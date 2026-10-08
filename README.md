# Larimer County Chess Club

Website for the Larimer County Chess Club, served by GitHub Pages from the main branch.

Edit index.html to update content; style.css holds the styling, copied into each page's <style>.

When you add a page, such as new board minutes, add its URL to sitemap.xml. The tournament pages under events/ are listed for you (see Events).

After changing calendar.js or style.css, run python scripts/sync_assets.py. It copies style.css into every page, so the first paint doesn't wait on another request, and updates the ?v= stamp on every page's link to calendar.js, so browsers don't pair a new page with a cached old script. Never edit a page's <style> by hand. CI fails if a page is out of date.

## Events

The event cards come from events.json, which the Action "Update calendar" (.github/workflows/calendar.yml) rebuilds hourly with scripts/update_calendar.py. Don't edit events.json by hand. The script reads the club and community Google Calendars through the Calendar API, with a read-only OAuth token in the repository secret LCCC_GOOGLE_CALENDAR_READ_TOKEN, because the public iCal feeds leave out each event's metadata: private extended properties that say who runs it, its format, ages, rating, cost, and Details link. The filters use only that metadata, never titles or descriptions. FIELDS in the script lists the fields. If an event has missing or invalid metadata, the run fails, names the event, and leaves events.json alone.

Then scripts/build_pages.py writes what search engines should read without running JavaScript, all from events.json: the schema.org Event data in events/index.html, a page for each club tournament at events/<name>/ (named from its calendar title), and the sitemap's tournament entries and lastmod dates. Every other page's lastmod is the day of the last commit that changed its text; the Date pages Action moves it after each push. Never edit those pages by hand; a page whose tournament has left events.json is deleted. Renaming a tournament in Google Calendar moves its page, and the run fails if a hand-written page still links to the old one.

To run it locally, with a token JSON from ~/.config/lccc/:

```
LCCC_GOOGLE_TOKEN="$(cat ~/.config/lccc/google-token-calendar-read.json)" python3 scripts/update_calendar.py
python3 scripts/build_pages.py
```

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
