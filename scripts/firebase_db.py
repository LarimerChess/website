"""The club's Firebase Realtime Database, through its REST API, as the president's Google token.

The database's URL is LIVE_DB in register.js, or the environment variable LCCC_FIREBASE_URL,
which wins even when empty. The token is google_auth.py --firebase's; in Actions its JSON comes
from LCCC_GOOGLE_FIREBASE_TOKEN. The layout is in the docs repo's plans/firebase-tournaments.md.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Characters a database key can't hold, and % so the encoding reverses: "No." is stored as "No%2E".
UNSAFE = re.compile(r"[.$#\[\]/%]")


def database_url():
    if "LCCC_FIREBASE_URL" in os.environ:
        url = os.environ["LCCC_FIREBASE_URL"]
    else:
        match = re.search(r'^const LIVE_DB = "([^"]*)";', (ROOT / "register.js").read_text(encoding="utf-8"), re.M)
        url = match[1] if match else ""
    return url.strip().rstrip("/")


def node(key):
    return key.replace("/", ":")


def encode_field(name):
    return UNSAFE.sub(lambda m: f"%{ord(m[0]):02X}", name)


def decode_field(name):
    return re.sub(r"%([0-9A-F]{2})", lambda m: chr(int(m[1], 16)), name)


def encode_row(row):
    return {encode_field(k): v for k, v in row.items()}


def decode_row(row):
    return {decode_field(k): v for k, v in row.items()}


class Database:
    def __init__(self, url, creds):
        self.url, self.creds = url, creds

    def token(self):
        if not self.creds.valid:
            from google.auth.transport.requests import Request
            self.creds.refresh(Request())
        return self.creds.token

    def call(self, method, path, body=None, **query):
        url = f"{self.url}/{path.strip('/')}.json" + (f"?{urllib.parse.urlencode(query)}" if query else "")
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token()}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                text = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            sys.exit(f"{method} /{path.strip('/')}: the database answered HTTP {error.code}: "
                     f"{error.read().decode('utf-8', 'replace')[:300]}")
        return json.loads(text) if text.strip() else None

    def get(self, path, **query):
        return self.call("GET", path, **query)

    def put(self, path, body):
        return self.call("PUT", path, body)

    def patch(self, path, body):
        """Writes every path in body at once; None deletes one."""
        return self.call("PATCH", path, body)


def connect():
    url = database_url()
    if not url:
        sys.exit("No database URL: LIVE_DB in register.js is empty. Set LCCC_FIREBASE_URL to the database's URL.")
    from google_auth import credentials
    return Database(url, credentials("firebase"))
