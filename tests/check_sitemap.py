"""Fail if a page is missing from sitemap.xml, or the sitemap lists a page that doesn't exist."""

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://larimerchess.org/"


def url(page):
    path = page.relative_to(ROOT).as_posix()
    return BASE + (path[: -len("index.html")] if path.endswith("index.html") else path)


pages = {url(p) for p in ROOT.rglob("*.html") if "node_modules" not in p.parts}
ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
listed = {loc.text for loc in ET.parse(ROOT / "sitemap.xml").findall("s:url/s:loc", ns)}
missing, extra = sorted(pages - listed), sorted(listed - pages)
for u in missing:
    print(f"FAIL {u} is a page but isn't in sitemap.xml")
for u in extra:
    print(f"FAIL sitemap.xml lists {u}, which doesn't exist")
if missing or extra:
    sys.exit(1)
print(f"ok   sitemap.xml lists all {len(pages)} pages")
