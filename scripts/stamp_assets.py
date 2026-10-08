"""Stamp calendar.js and style.css links in every page with a hash of the file's contents.

    python scripts/stamp_assets.py          # update the stamps
    python scripts/stamp_assets.py --check  # fail if any stamp is out of date

GitHub Pages lets browsers cache files for ten minutes, so a browser can pair a new
page with an old script. The stamp changes whenever the file does, so pages always
load the script and styles they were written for.
"""

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ["calendar.js", "style.css"]

stamps = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()[:10] for name in ASSETS}
pattern = re.compile(r"((?:\.\./)*(?:" + "|".join(map(re.escape, ASSETS)) + r"))(?:\?v=[0-9a-f]+)?\"")

stale = []
for page in sorted(ROOT.rglob("*.html")):
    if "node_modules" in page.parts:
        continue
    text = page.read_text(encoding="utf-8")
    stamped = pattern.sub(lambda m: f'{m.group(1)}?v={stamps[Path(m.group(1)).name]}"', text)
    if stamped != text:
        stale.append(page.relative_to(ROOT).as_posix())
        if "--check" not in sys.argv:
            page.write_text(stamped, encoding="utf-8")

if "--check" in sys.argv and stale:
    for page in stale:
        print(f"FAIL {page}: asset stamps are out of date; run python scripts/stamp_assets.py")
    sys.exit(1)
print(("ok   asset stamps current" if "--check" in sys.argv else f"stamped {len(stale)} page(s)")
      + f" ({', '.join(f'{n}?v={s}' for n, s in stamps.items())})")
