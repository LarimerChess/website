# Larimer County Chess Club

Website for the Larimer County Chess Club, served by GitHub Pages from the main branch.

Edit index.html to update content; style.css holds the styling.

When you add a page, such as new board minutes, add its URL to sitemap.xml.

## Checks

Every push runs .github/workflows/checks.yml: HTML validation, a JavaScript syntax check, the sitemap check, tests for the calendar import, page checks in Chrome (axe accessibility in light and dark mode, the event filters, the add-to-calendar menu, and structured data), and internal links. External links are checked weekly. .github/workflows/docs-private.yml checks hourly that the docs repo is still private.

To run them locally:

```
npm ci
npm run check:html
python tests/check_sitemap.py
python -m unittest discover -s tests
python -m http.server 8765 --bind 127.0.0.1 &
npm run check:pages
```

## License

Licensed under [CC BY 4.0](LICENSE). This does not cover material the club does not own, such as third-party photos and logos, or the club's name and logo, which remain the club's.

The knight in the site icon (favicon.svg, favicon.ico, apple-touch-icon.png, icon-512.png) is by Cburnett from Wikimedia Commons, used under the BSD license. See [ICON-LICENSE.txt](ICON-LICENSE.txt) for the notice and license text.
