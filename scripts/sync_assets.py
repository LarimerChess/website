"""Copy style.css into every page and stamp its calendar.js link with a hash of the file.

    python scripts/sync_assets.py          # update the pages
    python scripts/sync_assets.py --check  # fail if any page is out of date

The styles are inlined so the first paint doesn't wait on a second request; edit
style.css, never a page's <style>. GitHub Pages lets browsers cache files for ten
minutes, so a browser can pair a new page with an old script. The stamp changes
whenever the script does, so pages always load the one they were written for.
"""

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

stamp = hashlib.sha256((ROOT / "calendar.js").read_bytes()).hexdigest()[:10]
script = re.compile(r"((?:\.\./)*calendar\.js)(?:\?v=[0-9a-f]+)?\"")
css = (ROOT / "style.css").read_text(encoding="utf-8")
styles = re.compile(r'<link rel="stylesheet" href="(?:\.\./)*style\.css[^"]*">|<style>.*?</style>', re.S)

stale = []
for page in sorted(ROOT.rglob("*.html")):
    if "node_modules" in page.parts:
        continue
    text = page.read_text(encoding="utf-8")
    synced = script.sub(lambda m: f'{m.group(1)}?v={stamp}"', text)
    synced = styles.sub(lambda m: f"<style>\n{css}</style>", synced, count=1)
    if synced != text:
        stale.append(page.relative_to(ROOT).as_posix())
        if "--check" not in sys.argv:
            page.write_text(synced, encoding="utf-8")

if "--check" in sys.argv and stale:
    for page in stale:
        print(f"FAIL {page}: out of date with style.css or calendar.js; run python scripts/sync_assets.py")
    sys.exit(1)
print(("ok   pages match style.css and calendar.js" if "--check" in sys.argv else f"updated {len(stale)} page(s)")
      + f" (calendar.js?v={stamp})")
