"""Trello REST client shared by both halves of the plugin.

This single file is loaded by the dashboard router (``plugin_api.py``) and by
the agent tools (``__init__.py``). It is deliberately self-contained and uses
only the standard library.

Responsibilities
----------------
* credential resolution and storage (env, ``$HERMES_HOME`` file, root fallback)
* a fixed allowlist of Trello endpoints (no caller-supplied URLs)
* id and input validation before anything touches the network
* a response cache with single-flight, a sliding-window rate limiter and 429
  backoff
* normalisation of Trello JSON into small flat dicts

The HTTP layer is an injectable ``transport(url, method, params)`` returning
``(status, headers, body_bytes)`` so tests never need the network.
"""

import copy
import json
import logging
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

logger = logging.getLogger("hermes_trello_browser")

API_BASE = "https://api.trello.com"
USER_AGENT = "hermes-trello-browser/0.1"
HTTP_TIMEOUT = 15
MAX_BODY_BYTES = 8 * 1024 * 1024

TTL_BOARD_VIEW = 20.0
TTL_CARD = 10.0
TTL_BOARDS = 60.0
TTL_MEMBER = 60.0

RATE_WINDOW = 10.0
RATE_LIMIT_GLOBAL = 60
RATE_LIMIT_MEMBERS = 20
RATE_MAX_WAIT = 2.0

MAX_RETRIES_429 = 2
MAX_RETRY_SLEEP = 5.0  # never sleep longer than this inside one retry

PAGE_LIMIT = 1000
MAX_TEXT = 16384
MAX_CACHE_ENTRIES = 256

# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


class TrelloError(Exception):
    """Base class for every error raised by this module."""


class TrelloAuthError(TrelloError):
    """HTTP 401: Trello rejected the key/token pair."""


class TrelloRateLimited(TrelloError):
    """HTTP 429 (or the local limiter ran out of budget)."""

    def __init__(self, message="Trello is rate-limiting requests", retry_after=None):
        super().__init__(message)
        self.retry_after = retry_after


class TrelloNotFound(TrelloError):
    """HTTP 404 (or a resource the account cannot reach)."""


class TrelloUnavailable(TrelloError):
    """Network failure, timeout or a 5xx answer."""


class TrelloBadRequest(TrelloError):
    """Other 4xx answers: Trello refused the request as sent."""


class TrelloNotConnected(TrelloError):
    """No credentials could be resolved."""


# --------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------

_CRED_VALUE_RE = re.compile(r"[\x21-\x7e]{8,256}")


class Credentials:
    """API key + token pair. ``repr`` never shows either value."""

    __slots__ = ("api_key", "token")

    def __init__(self, api_key, token):
        self.api_key = api_key
        self.token = token

    def __repr__(self):
        return "Credentials(<redacted>)"

    def __eq__(self, other):
        return (
            isinstance(other, Credentials)
            and self.api_key == other.api_key
            and self.token == other.token
        )

    def __hash__(self):
        return hash((self.api_key, self.token))


def _coerce_credentials(value):
    if isinstance(value, Credentials):
        return value
    if isinstance(value, dict):
        key, token = value.get("api_key"), value.get("token")
    else:
        key, token = getattr(value, "api_key", None), getattr(value, "token", None)
    if not isinstance(key, str) or not isinstance(token, str) or not key or not token:
        raise ValueError("credentials need a non-empty api_key and token")
    return Credentials(key, token)


def validate_credential_values(api_key, token):
    """Raise ``ValueError`` unless both values look like opaque ASCII tokens."""
    for label, value in (("api_key", api_key), ("token", token)):
        if not isinstance(value, str) or not _CRED_VALUE_RE.fullmatch(value.strip()):
            raise ValueError(f"{label} must be 8-256 printable characters with no spaces")


def hermes_home(environ=None):
    environ = os.environ if environ is None else environ
    raw = environ.get("HERMES_HOME")
    return Path(raw).expanduser() if raw else Path.home() / ".hermes"


def credentials_file(environ=None):
    """Primary credential file inside the active ``$HERMES_HOME``."""
    return hermes_home(environ) / "trello-browser" / "credentials.json"


def _fallback_credentials_file():
    return Path.home() / ".hermes" / "trello-browser" / "credentials.json"


def _read_credentials_file(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    key, token = data.get("api_key"), data.get("token")
    if isinstance(key, str) and isinstance(token, str) and key.strip() and token.strip():
        return Credentials(key.strip(), token.strip())
    return None


def resolve_credentials(environ=None):
    """Return ``(Credentials | None, source)`` with source ``env``/``file``/``None``.

    Evaluated on every call so a settings change is live.
    """
    environ = os.environ if environ is None else environ
    key = (environ.get("TRELLO_API_KEY") or "").strip()
    token = (environ.get("TRELLO_TOKEN") or "").strip()
    if key and token:
        return Credentials(key, token), "env"
    for path in (credentials_file(environ), _fallback_credentials_file()):
        creds = _read_credentials_file(path)
        if creds is not None:
            return creds, "file"
    return None, None


def credentials_status(environ=None):
    """Connection state only. Never contains the key or the token."""
    environ = os.environ if environ is None else environ
    creds, source = resolve_credentials(environ)
    key_set = bool((environ.get("TRELLO_API_KEY") or "").strip())
    token_set = bool((environ.get("TRELLO_TOKEN") or "").strip())
    env_partial = key_set != token_set  # only one of the two env vars is set
    return {
        "configured": creds is not None,
        "source": source,
        "env_partial": env_partial,
        "file_present": credentials_file(environ).is_file(),
    }


def save_credentials(api_key, token, environ=None):
    """Write the credential file (dir 0700, file 0600) atomically. Returns its path."""
    validate_credential_values(api_key, token)
    path = credentials_file(environ)
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(directory, 0o700)
    except OSError:
        pass
    tmp = directory / f".credentials.json.tmp-{os.getpid()}-{threading.get_ident()}"
    payload = json.dumps({"api_key": api_key.strip(), "token": token.strip()})
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return path


def delete_credentials(environ=None):
    """Remove the credential file in the active ``$HERMES_HOME``. True if it existed."""
    path = credentials_file(environ)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

_OID_RE = re.compile(r"[0-9a-f]{24}")
_SHORT_RE = re.compile(r"[A-Za-z0-9]{8}")
_DATE_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}"
    r"([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?"
)


def _id(value, label="id"):
    """24-hex object id or 8-char short link."""
    if isinstance(value, str) and (_OID_RE.fullmatch(value) or _SHORT_RE.fullmatch(value)):
        return value
    raise ValueError(f"invalid {label}")


def _oid(value, label="id"):
    """Strict 24-hex object id."""
    if isinstance(value, str) and _OID_RE.fullmatch(value):
        return value
    raise ValueError(f"invalid {label}")


def _text(value, label, allow_empty=False):
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    if not allow_empty and not value.strip():
        raise ValueError(f"{label} must not be empty")
    if len(value) > MAX_TEXT:
        raise ValueError(f"{label} is longer than {MAX_TEXT} characters")
    return value


def _due(value):
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value.strip()):
        raise ValueError("due must be an ISO 8601 date or datetime")
    return value.strip()


def _before(value):
    if isinstance(value, str) and (_OID_RE.fullmatch(value) or _DATE_RE.fullmatch(value.strip())):
        return value.strip()
    raise ValueError("before must be an ISO 8601 date or a 24-hex id")


def _bool_param(value):
    return "true" if value else "false"


# --------------------------------------------------------------------------
# Endpoint allowlist: op -> (method, path template, bucket)
# --------------------------------------------------------------------------

_ENDPOINTS = {
    "member_me": ("GET", "/1/members/me", "members"),
    "member_boards": ("GET", "/1/members/me/boards", "members"),
    "board": ("GET", "/1/boards/{board}", None),
    "board_lists": ("GET", "/1/boards/{board}/lists", None),
    "board_cards": ("GET", "/1/boards/{board}/cards", None),
    "board_members": ("GET", "/1/boards/{board}/members", None),
    "board_labels": ("GET", "/1/boards/{board}/labels", None),
    "card": ("GET", "/1/cards/{card}", None),
    "card_actions": ("GET", "/1/cards/{card}/actions", None),
    "card_attachments": ("GET", "/1/cards/{card}/attachments", None),
    "card_create": ("POST", "/1/cards", None),
    "card_update": ("PUT", "/1/cards/{card}", None),
    "card_comment": ("POST", "/1/cards/{card}/actions/comments", None),
    "card_checklist_add": ("POST", "/1/cards/{card}/checklists", None),
    "card_checkitem_update": ("PUT", "/1/cards/{card}/checkItem/{item}", None),
    "checklist": ("GET", "/1/checklists/{checklist}", None),
    "checklist_item_add": ("POST", "/1/checklists/{checklist}/checkItems", None),
    "checklist_item_delete": ("DELETE", "/1/checklists/{checklist}/checkItems/{item}", None),
    "search": ("GET", "/1/search", None),
}

_CARD_FIELDS = (
    "name,idList,idBoard,due,dueComplete,labels,idMembers,shortLink,shortUrl,url,"
    "badges,dateLastActivity,pos"
)

# --------------------------------------------------------------------------
# Normalisation
# --------------------------------------------------------------------------


def _str(value):
    return value if isinstance(value, str) else ""


def _safe_url(value):
    """Only http(s) URLs reach the front end; anything else becomes None."""
    if isinstance(value, str):
        scheme = urllib.parse.urlsplit(value.strip()).scheme.lower()
        if scheme in ("http", "https"):
            return value.strip()
    return None


def normalize_board(raw):
    return {
        "id": _str(raw.get("id")),
        "name": _str(raw.get("name")),
        "url": _safe_url(raw.get("url") or raw.get("shortUrl")) or "",
        "closed": bool(raw.get("closed")),
        "starred": bool(raw.get("starred")),
    }


def normalize_list(raw):
    pos = raw.get("pos")
    return {
        "id": _str(raw.get("id")),
        "name": _str(raw.get("name")),
        "pos": pos if isinstance(pos, (int, float)) else 0,
        "closed": bool(raw.get("closed")),
    }


def normalize_card(raw):
    badges = raw.get("badges") if isinstance(raw.get("badges"), dict) else {}
    labels = []
    for label in raw.get("labels") or []:
        if isinstance(label, dict):
            shown = label.get("name") or label.get("color")
            if shown:
                labels.append(str(shown))
    short = _str(raw.get("shortLink"))
    url = _safe_url(raw.get("shortUrl") or raw.get("url")) or (
        f"https://trello.com/c/{short}" if short else ""
    )
    return {
        "id": _str(raw.get("id")),
        "name": _str(raw.get("name")),
        "id_list": _str(raw.get("idList")),
        "closed": bool(raw.get("closed")),
        "due": raw.get("due") if isinstance(raw.get("due"), str) else None,
        "due_complete": bool(raw.get("dueComplete")),
        "labels": labels,
        "id_members": [m for m in (raw.get("idMembers") or []) if isinstance(m, str)],
        "short_link": short,
        "url": url,
        "comment_count": int(badges.get("comments") or 0),
        "attachment_count": int(badges.get("attachments") or 0),
        "checklist": {
            "total": int(badges.get("checkItems") or 0),
            "done": int(badges.get("checkItemsChecked") or 0),
        },
        "last_activity": raw.get("dateLastActivity")
        if isinstance(raw.get("dateLastActivity"), str)
        else None,
    }


def normalize_member(raw):
    avatar = None
    base = _safe_url(raw.get("avatarUrl"))
    if base:
        avatar = base.rstrip("/") + "/50.png"
    elif raw.get("avatarHash") and _OID_RE.fullmatch(_str(raw.get("id"))):
        avatar = f"https://trello-members.s3.amazonaws.com/{raw['id']}/{raw['avatarHash']}/50.png"
    return {
        "id": _str(raw.get("id")),
        "username": _str(raw.get("username")),
        "full_name": _str(raw.get("fullName")),
        "initials": _str(raw.get("initials")),
        "avatar_url": avatar,
    }


def normalize_label(raw):
    return {
        "id": _str(raw.get("id")),
        "name": _str(raw.get("name")),
        "color": raw.get("color") if isinstance(raw.get("color"), str) else None,
    }


def normalize_item(raw):
    return {
        "id": _str(raw.get("id")),
        "name": _str(raw.get("name")),
        "state": "complete" if raw.get("state") == "complete" else "incomplete",
    }


def _raw_pos(item):
    pos = item.get("pos")
    return pos if isinstance(pos, (int, float)) else 0


def _by_pos(items):
    return sorted(items, key=_raw_pos)


def normalize_checklist(raw):
    return {
        "id": _str(raw.get("id")),
        "name": _str(raw.get("name")),
        "items": [normalize_item(i) for i in _by_pos(raw.get("checkItems") or []) if isinstance(i, dict)],
    }


def normalize_comment(raw):
    data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
    creator = raw.get("memberCreator") if isinstance(raw.get("memberCreator"), dict) else {}
    return {
        "id": _str(raw.get("id")),
        "author": _str(creator.get("fullName")) or _str(creator.get("username")),
        "text": _str(data.get("text")),
        "date": _str(raw.get("date")),
    }


def normalize_attachment(raw):
    size = raw.get("bytes")
    return {
        "id": _str(raw.get("id")),
        "name": _str(raw.get("name")),
        "url": _safe_url(raw.get("url")),
        "is_upload": bool(raw.get("isUpload")),
        "bytes": size if isinstance(size, int) else None,
        "mime": _str(raw.get("mimeType")) or None,
    }


def _oldest_card_id(cards):
    ids = [c["id"] for c in cards if _OID_RE.fullmatch(c.get("id", ""))]
    return min(ids) if ids else None


# --------------------------------------------------------------------------
# Default HTTP transport
# --------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


def default_transport(url, method, params):
    """``urllib`` transport: HTTPS to api.trello.com only, no redirects.

    Auth (``key``/``token``) always travels in the query string; for POST/PUT
    the remaining params go in a form body so long text is not URL-limited.
    """
    if not url.startswith(API_BASE + "/"):
        raise TrelloUnavailable("refusing to contact an unexpected host")
    params = dict(params or {})
    auth = {k: params.pop(k) for k in ("key", "token") if k in params}
    data = None
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if method in ("POST", "PUT"):
        query = auth
        data = urllib.parse.urlencode(params).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    else:
        query = {**params, **auth}
    full = url + "?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(full, data=data, method=method, headers=headers)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=HTTP_TIMEOUT) as response:
            body = response.read(MAX_BODY_BYTES + 1)
            status, resp_headers = response.status, dict(response.headers.items())
    except urllib.error.HTTPError as exc:
        body = exc.read(MAX_BODY_BYTES + 1) if exc.fp else b""
        status, resp_headers = exc.code, dict(exc.headers.items()) if exc.headers else {}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        # Only the exception type is reported: URLs carry credentials.
        raise TrelloUnavailable(f"could not reach Trello ({type(exc).__name__})") from None
    if len(body) > MAX_BODY_BYTES:
        raise TrelloUnavailable("Trello response too large")
    return status, resp_headers, body


# --------------------------------------------------------------------------
# Cache, single-flight, rate limiter
# --------------------------------------------------------------------------


class _Cache:
    def __init__(self, clock, max_entries=MAX_CACHE_ENTRIES):
        self._clock = clock
        self._max = max_entries
        self._lock = threading.Lock()
        self._data = {}  # key -> (expires, value, tags)

    def get(self, key):
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return False, None
            if entry[0] <= self._clock():
                del self._data[key]
                return False, None
            return True, copy.deepcopy(entry[1])

    def put(self, key, value, ttl, tags=()):
        with self._lock:
            now = self._clock()
            if len(self._data) >= self._max:
                for k in [k for k, e in self._data.items() if e[0] <= now]:
                    del self._data[k]
            while len(self._data) >= self._max:
                oldest = min(self._data, key=lambda k: self._data[k][0])
                del self._data[oldest]
            self._data[key] = (now + ttl, copy.deepcopy(value), frozenset(tags))

    def drop_tag(self, tag):
        with self._lock:
            for k in [k for k, e in self._data.items() if tag in e[2]]:
                del self._data[k]

    def drop_kind(self, kind):
        with self._lock:
            for k in [k for k in self._data if k[0] == kind]:
                del self._data[k]

    def clear(self):
        with self._lock:
            self._data.clear()

    def __len__(self):
        with self._lock:
            return len(self._data)


class _Limiter:
    """Sliding-window limiter: at most N requests in any ``window`` seconds.

    One global window plus a stricter one for ``/1/members/*``. A caller waits
    at most ``max_wait`` seconds in total; if the budget will not free up in
    time ``TrelloRateLimited`` is raised instead of blocking longer.
    """

    def __init__(self, clock, sleep, window=RATE_WINDOW, global_limit=RATE_LIMIT_GLOBAL,
                 members_limit=RATE_LIMIT_MEMBERS, max_wait=RATE_MAX_WAIT):
        self._clock = clock
        self._sleep = sleep
        self._window = window
        self._global_limit = global_limit
        self._members_limit = members_limit
        self._max_wait = max_wait
        self._lock = threading.Lock()
        self._all = []
        self._members = []

    def _wait_needed(self, stamps, limit, now):
        stamps[:] = [t for t in stamps if t + self._window > now]
        if len(stamps) < limit:
            return 0.0
        return stamps[len(stamps) - limit] + self._window - now

    def acquire(self, bucket=None):
        waited = 0.0
        while True:
            with self._lock:
                now = self._clock()
                wait = self._wait_needed(self._all, self._global_limit, now)
                if bucket == "members":
                    wait = max(wait, self._wait_needed(self._members, self._members_limit, now))
                if wait <= 0:
                    self._all.append(now)
                    if bucket == "members":
                        self._members.append(now)
                    return
                if waited + wait > self._max_wait:
                    raise TrelloRateLimited(
                        "local request budget exhausted; retry shortly",
                        retry_after=max(1, math.ceil(wait)),
                    )
            self._sleep(wait)
            waited += wait


# --------------------------------------------------------------------------
# Client
# --------------------------------------------------------------------------


class TrelloClient:
    def __init__(self, credentials, transport=None, clock=time.monotonic, sleep=time.sleep):
        self._creds = _coerce_credentials(credentials)
        self._transport = transport or default_transport
        self._clock = clock
        self._sleep = sleep
        self._cache = _Cache(clock)
        self._limiter = _Limiter(clock, sleep)
        self._flights = {}
        self._flights_lock = threading.Lock()
        self._gen = 0
        self._gen_lock = threading.Lock()
        self._checklist_card = {}
        self._map_lock = threading.Lock()

    def __repr__(self):
        return "TrelloClient(<redacted>)"

    # -- plumbing ----------------------------------------------------------

    def _scrub(self, text):
        for secret in (self._creds.api_key, self._creds.token):
            if secret:
                text = text.replace(secret, "***")
        return text

    def _call(self, op, ids=None, query=None):
        method, template, bucket = _ENDPOINTS[op]
        path = template.format(**(ids or {}))
        url = API_BASE + path
        params = dict(query or {})
        params["key"] = self._creds.api_key
        params["token"] = self._creds.token

        attempt = 0
        while True:
            self._limiter.acquire(bucket)
            try:
                status, headers, body = self._transport(url, method, dict(params))
            except TrelloError:
                raise
            except (OSError, TimeoutError, urllib.error.URLError) as exc:
                raise TrelloUnavailable(f"could not reach Trello ({type(exc).__name__})") from None
            if status != 429:
                break
            lowered = {str(k).lower(): v for k, v in (headers or {}).items()}
            retry_after = None
            try:
                if "retry-after" in lowered:
                    retry_after = max(0.0, float(lowered["retry-after"]))
            except (TypeError, ValueError):
                retry_after = None
            delay = retry_after if retry_after is not None else float(2 ** attempt)
            if attempt >= MAX_RETRIES_429 or delay > MAX_RETRY_SLEEP:
                raise TrelloRateLimited(retry_after=max(1, math.ceil(delay)))
            self._sleep(delay)
            attempt += 1
        return self._handle(status, body)

    def _handle(self, status, body):
        text = ""
        if isinstance(body, (bytes, bytearray)):
            text = bytes(body[:2000]).decode("utf-8", "replace")
        if 200 <= status < 300:
            if not body:
                return None
            try:
                return json.loads(body)
            except ValueError:
                raise TrelloUnavailable("Trello returned a malformed response") from None
        message = self._scrub(text.strip())[:200]
        if status == 401:
            # Trello also answers 401 for a resource the account cannot read.
            if "permission requested" in message.lower():
                raise TrelloNotFound("this item is not reachable with the connected account")
            raise TrelloAuthError("Trello rejected the API key or token")
        if status == 404:
            raise TrelloNotFound("Trello item not found")
        if 500 <= status or status < 200 or 300 <= status < 400:
            raise TrelloUnavailable(f"Trello is unavailable (HTTP {status})")
        raise TrelloBadRequest(message or f"Trello refused the request (HTTP {status})")

    def _bump(self):
        with self._gen_lock:
            self._gen += 1

    def _cached(self, key, ttl, loader, tags_of=lambda value: ()):
        hit, value = self._cache.get(key)
        if hit:
            return value
        with self._flights_lock:
            flight = self._flights.setdefault(key, [threading.Lock(), 0])
            flight[1] += 1
        try:
            with flight[0]:
                hit, value = self._cache.get(key)
                if hit:
                    return value
                with self._gen_lock:
                    generation = self._gen
                value = loader()
                with self._gen_lock:
                    unchanged = generation == self._gen
                if unchanged:
                    self._cache.put(key, value, ttl, tags_of(value))
                return copy.deepcopy(value)
        finally:
            with self._flights_lock:
                flight[1] -= 1
                if flight[1] == 0:
                    self._flights.pop(key, None)

    # -- cache invalidation -----------------------------------------------

    def invalidate_board(self, board_id):
        self._bump()
        self._cache.drop_tag(("board", board_id))

    def invalidate_card(self, card_id):
        self._bump()
        self._cache.drop_tag(("card", card_id))

    def _invalidate_all_content(self):
        self._bump()
        for kind in ("view", "page", "card", "attachments"):
            self._cache.drop_kind(kind)

    def _remember_checklists(self, card_id, checklists):
        with self._map_lock:
            if len(self._checklist_card) > 2048:
                self._checklist_card.clear()
            for checklist in checklists:
                if isinstance(checklist, dict) and _OID_RE.fullmatch(_str(checklist.get("id"))):
                    self._checklist_card[checklist["id"]] = card_id

    # -- reads -------------------------------------------------------------

    def member(self):
        def load():
            raw = self._call("member_me", query={"fields": "username,fullName,initials,avatarUrl"})
            return normalize_member(raw or {})

        return self._cached(("member",), TTL_MEMBER, load)

    def boards(self):
        def load():
            raw = self._call(
                "member_boards",
                query={"fields": "name,url,closed,starred", "filter": "open"},
            )
            boards = [normalize_board(b) for b in (raw or []) if isinstance(b, dict)]
            boards.sort(key=lambda b: (not b["starred"], b["name"].lower()))
            return boards

        return self._cached(("boards",), TTL_BOARDS, load)

    def board_view(self, board_id):
        board_id = _id(board_id, "board_id")

        def load():
            ids = {"board": board_id}
            jobs = [
                ("board", {"fields": "name,url,closed,starred,shortLink"}),
                ("board_lists", {"fields": "name,pos,closed", "filter": "open"}),
                ("board_cards", {"fields": _CARD_FIELDS, "filter": "open", "limit": str(PAGE_LIMIT)}),
                ("board_members", {"fields": "fullName,username,initials,avatarUrl"}),
                ("board_labels", {"fields": "name,color", "limit": "1000"}),
            ]
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(self._call, op, ids, query) for op, query in jobs]
            results = []
            first_error = None
            for future in futures:
                try:
                    results.append(future.result())
                except Exception as exc:  # re-raised below, in submission order
                    first_error = first_error or exc
            if first_error is not None:
                raise first_error
            board_raw, lists_raw, cards_raw, members_raw, labels_raw = results
            cards_raw = [c for c in (cards_raw or []) if isinstance(c, dict)]
            cards_raw.sort(key=_raw_pos)
            return {
                "board": normalize_board(board_raw or {}),
                "lists": sorted(
                    (normalize_list(x) for x in (lists_raw or []) if isinstance(x, dict)),
                    key=lambda x: x["pos"],
                ),
                "cards": [normalize_card(c) for c in cards_raw],
                "members": [normalize_member(m) for m in (members_raw or []) if isinstance(m, dict)],
                "labels": [normalize_label(x) for x in (labels_raw or []) if isinstance(x, dict)],
            }

        def tags(view):
            found = {("board", board_id), ("board", view["board"]["id"])}
            found.update(("card", c["id"]) for c in view["cards"])
            return found

        return self._cached(("view", board_id), TTL_BOARD_VIEW, load, tags)

    def board_cards_page(self, board_id, before=None):
        """One page of open cards (up to 1000). ``next_before`` is the oldest id seen."""
        board_id = _id(board_id, "board_id")
        before = _before(before) if before else None

        def load():
            query = {"fields": _CARD_FIELDS, "filter": "open", "limit": str(PAGE_LIMIT)}
            if before:
                query["before"] = before
            raw = self._call("board_cards", {"board": board_id}, query)
            cards = [normalize_card(c) for c in (raw or []) if isinstance(c, dict)]
            more = len(cards) >= PAGE_LIMIT
            return {"cards": cards, "next_before": _oldest_card_id(cards) if more else None}

        def tags(page):
            return {("board", board_id)} | {("card", c["id"]) for c in page["cards"]}

        return self._cached(("page", board_id, before), TTL_BOARD_VIEW, load, tags)

    def card(self, card_id):
        card_id = _id(card_id, "card_id")

        def load():
            ids = {"card": card_id}
            card_query = {
                "fields": _CARD_FIELDS + ",desc",
                "checklists": "all",
                "checklist_fields": "name,pos,idCard",
                "attachments": "true",
                "attachment_fields": "name,url,bytes,mimeType,isUpload",
            }
            action_query = {"filter": "commentCard", "limit": "20", "memberCreator_fields": "fullName,username"}
            with ThreadPoolExecutor(max_workers=2) as pool:
                card_future = pool.submit(self._call, "card", ids, card_query)
                actions_future = pool.submit(self._call, "card_actions", ids, action_query)
            card_raw = card_future.result()
            actions_raw = actions_future.result()
            card_raw = card_raw or {}
            checklists = [c for c in (card_raw.get("checklists") or []) if isinstance(c, dict)]
            self._remember_checklists(_str(card_raw.get("id")), checklists)
            return {
                "card": normalize_card(card_raw),
                "desc": _str(card_raw.get("desc")),
                "checklists": [normalize_checklist(c) for c in _by_pos(checklists)],
                "comments": [normalize_comment(a) for a in (actions_raw or []) if isinstance(a, dict)],
                "attachments": [
                    normalize_attachment(a) for a in (card_raw.get("attachments") or []) if isinstance(a, dict)
                ],
            }

        def tags(detail):
            card = detail["card"]
            return {("card", card_id), ("card", card["id"]), ("card", card["short_link"])}

        return self._cached(("card", card_id), TTL_CARD, load, tags)

    def attachments(self, card_id):
        card_id = _id(card_id, "card_id")

        def load():
            raw = self._call(
                "card_attachments",
                {"card": card_id},
                {"fields": "name,url,bytes,mimeType,isUpload"},
            )
            return [normalize_attachment(a) for a in (raw or []) if isinstance(a, dict)]

        return self._cached(("attachments", card_id), TTL_CARD, load, lambda _v: {("card", card_id)})

    def search(self, query, limit=20):
        query = _text(query, "query")
        if len(query) > 256:
            raise ValueError("query is longer than 256 characters")
        limit = max(1, min(int(limit), 50))
        raw = self._call(
            "search",
            query={
                "query": query.strip(),
                "modelTypes": "cards,boards",
                "partial": "true",
                "board_fields": "name,url,closed",
                "card_fields": _CARD_FIELDS,
                "cards_limit": str(limit),
                "boards_limit": "10",
            },
        )
        raw = raw or {}
        cards = []
        for item in raw.get("cards") or []:
            if isinstance(item, dict):
                card = normalize_card(item)
                card["id_board"] = _str(item.get("idBoard"))
                cards.append(card)
        return {
            "boards": [normalize_board(b) for b in (raw.get("boards") or []) if isinstance(b, dict)],
            "cards": cards,
        }

    # -- writes ------------------------------------------------------------

    def create_card(self, list_id, name, desc=None, due=None):
        params = {"idList": _oid(list_id, "list_id"), "name": _text(name, "name")}
        if desc is not None:
            params["desc"] = _text(desc, "desc", allow_empty=True)
        if due:
            params["due"] = _due(due)
        raw = self._call("card_create", query=params) or {}
        card = normalize_card(raw)
        if raw.get("idBoard"):
            self.invalidate_board(raw["idBoard"])
        else:
            self._invalidate_all_content()
        return card

    def update_card(self, card_id, **fields):
        """Partial update. Keys: name, desc, due (None clears), id_list, closed, id_labels."""
        card_id = _id(card_id, "card_id")
        allowed = {"name", "desc", "due", "id_list", "closed", "id_labels"}
        unknown = set(fields) - allowed
        if unknown:
            raise ValueError("unknown field: " + ", ".join(sorted(unknown)))
        if not fields:
            raise ValueError("nothing to update")
        params = {}
        if "name" in fields:
            params["name"] = _text(fields["name"], "name")
        if "desc" in fields:
            params["desc"] = _text(fields["desc"], "desc", allow_empty=True)
        if "due" in fields:
            params["due"] = "null" if fields["due"] in (None, "") else _due(fields["due"])
        if "id_list" in fields:
            params["idList"] = _oid(fields["id_list"], "id_list")
        if "closed" in fields:
            if not isinstance(fields["closed"], bool):
                raise ValueError("closed must be a boolean")
            params["closed"] = _bool_param(fields["closed"])
        if "id_labels" in fields:
            labels = fields["id_labels"]
            if not isinstance(labels, (list, tuple)):
                raise ValueError("id_labels must be a list")
            params["idLabels"] = ",".join(_oid(x, "label id") for x in labels)
        raw = self._call("card_update", {"card": card_id}, params) or {}
        card = normalize_card(raw)
        self.invalidate_card(card_id)
        if card["id"]:
            self.invalidate_card(card["id"])
        board_id = raw.get("idBoard")
        if isinstance(board_id, str) and _OID_RE.fullmatch(board_id):
            self.invalidate_board(board_id)  # covers archive/unarchive and moves
        else:
            self._invalidate_all_content()
        return card

    def add_comment(self, card_id, text):
        card_id = _id(card_id, "card_id")
        raw = self._call("card_comment", {"card": card_id}, {"text": _text(text, "text")}) or {}
        self.invalidate_card(card_id)
        comment = normalize_comment(raw)
        if not comment["text"]:
            comment["text"] = text
        return comment

    def add_checklist(self, card_id, name):
        card_id = _id(card_id, "card_id")
        raw = self._call("card_checklist_add", {"card": card_id}, {"name": _text(name, "name")}) or {}
        self._remember_checklists(_str(raw.get("idCard")) or card_id, [raw])
        self.invalidate_card(card_id)
        return normalize_checklist(raw)

    def add_checklist_item(self, checklist_id, name):
        checklist_id = _oid(checklist_id, "checklist_id")
        raw = self._call("checklist_item_add", {"checklist": checklist_id}, {"name": _text(name, "name")}) or {}
        self._invalidate_for_checklist(checklist_id)
        return normalize_item(raw)

    def set_checklist_item(self, checklist_id, item_id, state=None, name=None, card_id=None):
        checklist_id = _oid(checklist_id, "checklist_id")
        item_id = _oid(item_id, "item_id")
        params = {}
        if state is not None:
            if state not in ("complete", "incomplete"):
                raise ValueError("state must be 'complete' or 'incomplete'")
            params["state"] = state
        if name is not None:
            params["name"] = _text(name, "name")
        if not params:
            raise ValueError("nothing to update")
        if card_id is None:
            with self._map_lock:
                card_id = self._checklist_card.get(checklist_id)
            if card_id is None:
                raw = self._call("checklist", {"checklist": checklist_id}, {"fields": "idCard"}) or {}
                card_id = _str(raw.get("idCard"))
        card_id = _id(card_id, "card_id")
        raw = self._call("card_checkitem_update", {"card": card_id, "item": item_id}, params) or {}
        self.invalidate_card(card_id)
        item = normalize_item(raw)
        return item

    def delete_checklist_item(self, checklist_id, item_id):
        checklist_id = _oid(checklist_id, "checklist_id")
        item_id = _oid(item_id, "item_id")
        self._call("checklist_item_delete", {"checklist": checklist_id, "item": item_id})
        self._invalidate_for_checklist(checklist_id)

    def _invalidate_for_checklist(self, checklist_id):
        with self._map_lock:
            card_id = self._checklist_card.get(checklist_id)
        if card_id:
            self.invalidate_card(card_id)
        else:
            self._invalidate_all_content()


# --------------------------------------------------------------------------
# Shared client (one per credential pair, used by both halves)
# --------------------------------------------------------------------------

_transport_override = None
_shared_lock = threading.Lock()
_shared = {"client": None, "fingerprint": None}  # type: dict


def set_transport_override(transport):
    """Test seam: route every shared client through ``transport`` (None resets)."""
    global _transport_override
    with _shared_lock:
        _transport_override = transport
        _shared["client"] = None
        _shared["fingerprint"] = None


def shared_client(environ=None):
    """Client for the currently resolved credentials; raises ``TrelloNotConnected``.

    Credentials are re-resolved on every call. The client (and so its cache and
    rate limiter) is reused while the credential pair is unchanged.
    """
    creds, source = resolve_credentials(environ)
    if creds is None:
        raise TrelloNotConnected("Trello credentials are not configured")
    fingerprint = (creds, _transport_override)
    with _shared_lock:
        if _shared["client"] is None or _shared["fingerprint"] != fingerprint:
            _shared["client"] = TrelloClient(creds, transport=_transport_override)
            _shared["fingerprint"] = fingerprint
        return _shared["client"], source
