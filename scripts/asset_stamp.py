"""Version a JavaScript asset consistently across Git checkout line endings."""

import hashlib


def asset_stamp(path):
    content = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(content).hexdigest()[:10]
