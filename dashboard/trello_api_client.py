"""Trello REST client shared by both halves of the plugin.

This single file is loaded by the dashboard router (``plugin_api.py``) and by
the agent tools (``__init__.py``). It is deliberately self-contained and uses
only the standard library.

Responsibilities
----------------
* credential resolution and storage (env, this profile's file, the app-wide file)
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


_CRED_DIR = "trello-browser"
_CRED_FILE = "credentials.json"
SCOPES = ("app", "profile")


def _default_home():
    return Path.home() / ".hermes"


def _capture_root_home():
    """The app-wide home, read once at import: the root of the Hermes home tree.

    That is the process home (``$HERMES_HOME`` or ``~/.hermes``) when it already is a root. When this
    process runs inside a named profile (``<root>/profiles/<name>``) Hermes can say where the root is, so
    "all profiles" stays the same place for the dashboard and for every profile's agent half. The Hermes
    import is optional and kept out of module scope.
    """
    raw = (os.environ.get("HERMES_HOME") or "").strip()
    base = Path(raw).expanduser() if raw else _default_home()
    try:
        from hermes_constants import get_default_hermes_root  # optional: absent outside Hermes
    except ImportError:
        return base
    try:
        return Path(get_default_hermes_root())
    except Exception:  # noqa: BLE001 - a Hermes-side failure must not break the client
        return base


ROOT_HOME = _capture_root_home()


def effective_home(environ=None):
    """Home of the request being served: Hermes' context override, then ``HERMES_HOME``, then the default.

    With an explicit ``environ`` mapping (tests, embedding) only that mapping is consulted.
    """
    if environ is not None:
        raw = (environ.get("HERMES_HOME") or "").strip()
        return Path(raw).expanduser() if raw else _default_home()
    try:
        from hermes_constants import get_hermes_home  # optional: absent outside Hermes
    except ImportError:
        get_hermes_home = None
    if get_hermes_home is not None:
        try:
            return Path(get_hermes_home())
        except Exception:  # noqa: BLE001 - fall back to the environment below
            pass
    raw = (os.environ.get("HERMES_HOME") or "").strip()
    return Path(raw).expanduser() if raw else _default_home()


def _same_dir(a, b):
    try:
        return Path(a).resolve() == Path(b).resolve()
    except OSError:
        return Path(a) == Path(b)


def _cred_path(home):
    return Path(home) / _CRED_DIR / _CRED_FILE


def _profile_is_root(environ=None):
    return _same_dir(effective_home(environ), ROOT_HOME)


def credentials_path(scope, environ=None):
    """File for ``scope``. Without a separate profile home, ``"profile"`` is the app-wide file."""
    if scope not in SCOPES:
        raise ValueError('scope must be "app" or "profile"')
    if scope == "profile" and not _profile_is_root(environ):
        return _cred_path(effective_home(environ))
    return _cred_path(ROOT_HOME)


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


def _explicit(environ):
    """``environ`` when the caller injected a mapping; None means "the live process"."""
    return None if environ is None or environ is os.environ else environ


def resolve_credentials(environ=None):
    """Return ``(Credentials | None, source)``, source one of ``env``/``profile``/``app``/``None``.

    Order: environment variables, this profile's file, the app-wide file. Evaluated on every call so a
    settings change (or a switch of profile) is live.
    """
    env = os.environ if environ is None else environ
    key = (env.get("TRELLO_API_KEY") or "").strip()
    token = (env.get("TRELLO_TOKEN") or "").strip()
    if key and token:
        return Credentials(key, token), "env"
    explicit = _explicit(environ)
    if not _profile_is_root(explicit):
        creds = _read_credentials_file(credentials_path("profile", explicit))
        if creds is not None:
            return creds, "profile"
    creds = _read_credentials_file(credentials_path("app", explicit))
    if creds is not None:
        return creds, "app"
    return None, None


def credentials_status(environ=None):
    """Connection state only. Never contains the key or the token."""
    env = os.environ if environ is None else environ
    explicit = _explicit(environ)
    _creds, source = resolve_credentials(environ)
    key_set = bool((env.get("TRELLO_API_KEY") or "").strip())
    token_set = bool((env.get("TRELLO_TOKEN") or "").strip())
    profile_is_root = _profile_is_root(explicit)
    profile_file = (not profile_is_root) and _read_credentials_file(credentials_path("profile", explicit)) is not None
    return {
        "configured": source is not None,
        "source": source,
        "active_scope": source,
        "env_partial": key_set != token_set,  # only one of the two env vars is set
        "app_file": _read_credentials_file(credentials_path("app", explicit)) is not None,
        "profile_file": profile_file,
        "profile_overrides": source == "profile",
        "profile_is_root": profile_is_root,
        "profile_home": str(effective_home(explicit)),
    }


def save_credentials(api_key, token, scope="app", environ=None):
    """Write the credential file for ``scope`` (dir 0700, file 0600) atomically.

    Returns ``{"path", "scope", "requested_scope"}``. ``scope`` is where the file really went: asking for
    ``"profile"`` while the process has no home of its own (profile home == app home) stores the app-wide
    file and says so.
    """
    validate_credential_values(api_key, token)
    path = credentials_path(scope, _explicit(environ))
    stored = "app" if _same_dir(path.parent.parent, ROOT_HOME) else "profile"
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
    return {"path": path, "scope": stored, "requested_scope": scope}


def delete_credentials(scope="app", environ=None):
    """Remove the credential file for ``scope``. True if it existed."""
    path = credentials_path(scope, _explicit(environ))
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
    label_ids = []
    for label in raw.get("labels") or []:
        if isinstance(label, dict):
            shown = label.get("name") or label.get("color")
            if shown:
                labels.append(str(shown))
            if _OID_RE.fullmatch(_str(label.get("id"))):
                label_ids.append(label["id"])
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
        "label_ids": label_ids,
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


ACTIVITY_TYPES = "createCard,updateCard,commentCard,addChecklistToCard,updateCheckItemStateOnCard"
ACTIVITY_LIMIT = 20
_SUMMARY_MAX = 200
_CHANGED_FIELDS = {
    "name": "title",
    "desc": "description",
    "due": "due date",
    "dueComplete": "due status",
    "idLabels": "labels",
    "idMembers": "members",
}


def _name_of(node):
    return _str(node.get("name")) if isinstance(node, dict) else ""


def summarize_action(action):
    """One short, plain-English line for a Trello action (the comment text for comments)."""
    kind = _str(action.get("type"))
    data = action.get("data") if isinstance(action.get("data"), dict) else {}
    if kind == "commentCard":
        return _str(data.get("text"))
    text = ""
    if kind == "createCard":
        where = _name_of(data.get("list"))
        text = f"created this card in {where}" if where else "created this card"
    elif kind == "updateCard":
        before, after = _name_of(data.get("listBefore")), _name_of(data.get("listAfter"))
        old = data.get("old") if isinstance(data.get("old"), dict) else {}
        card = data.get("card") if isinstance(data.get("card"), dict) else {}
        if before and after:
            text = f"moved from {before} to {after}"
        elif "closed" in old:
            text = "archived this card" if card.get("closed") else "restored this card"
        else:
            changed = [label for key, label in _CHANGED_FIELDS.items() if key in old]
            text = "changed " + ", ".join(changed) if changed else "updated this card"
    elif kind == "addChecklistToCard":
        name = _name_of(data.get("checklist"))
        text = f"added checklist {name}" if name else "added a checklist"
    elif kind == "updateCheckItemStateOnCard":
        item = data.get("checkItem") if isinstance(data.get("checkItem"), dict) else {}
        verb = "completed" if item.get("state") == "complete" else "marked incomplete"
        text = f"{verb} {_str(item.get('name'))}".strip()
    return text[:_SUMMARY_MAX]


def normalize_activity(raw):
    creator = raw.get("memberCreator") if isinstance(raw.get("memberCreator"), dict) else {}
    return {
        "id": _str(raw.get("id")),
        "type": _str(raw.get("type")),
        "author": _str(creator.get("fullName")) or _str(creator.get("username")),
        "date": _str(raw.get("date")),
        "text": summarize_action(raw),
    }


def _smallest_preview(raw):
    """The smallest (1x) preview Trello made for an attachment, or None. Entries without a usable URL are skipped."""
    previews = raw.get("previews")
    best = None
    for preview in previews if isinstance(previews, list) else []:
        if not isinstance(preview, dict) or _safe_url(preview.get("url")) is None:
            continue
        width = preview.get("width")
        width = width if isinstance(width, int) and not isinstance(width, bool) and width > 0 else None
        if best is None or (width or 10**9) < (best[1] or 10**9):
            best = (preview, width)
    return best[0] if best else None


def _dimension(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def normalize_attachment(raw):
    """One attachment. ``thumb_url`` / ``width`` / ``height`` describe the smallest preview (the thumbnail), not the original."""
    size = raw.get("bytes")
    mime = _str(raw.get("mimeType")) or None
    preview = _smallest_preview(raw)
    return {
        "id": _str(raw.get("id")),
        "name": _str(raw.get("name")),
        "url": _safe_url(raw.get("url")),
        "is_upload": bool(raw.get("isUpload")),
        "bytes": size if isinstance(size, int) else None,
        "mime": mime,
        "thumb_url": _safe_url(preview.get("url")) if preview else None,
        "width": _dimension(preview.get("width")) if preview else None,
        "height": _dimension(preview.get("height")) if preview else None,
        "is_image": bool(mime and mime.lower().startswith("image/")) or preview is not None,
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
        for kind in ("view", "page", "card", "attachments", "activity"):
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
                "attachment_fields": "name,url,bytes,mimeType,isUpload,previews",
                "list": "true",
                "list_fields": "name",
                "board": "true",
                "board_fields": "name",
            }
            action_query = {"filter": "commentCard", "limit": "20", "memberCreator_fields": "fullName,username"}
            with ThreadPoolExecutor(max_workers=3) as pool:
                card_future = pool.submit(self._call, "card", ids, card_query)
                actions_future = pool.submit(self._call, "card_actions", ids, action_query)
                activity_future = pool.submit(self._fetch_activity, card_id)
            card_raw = card_future.result()
            actions_raw = actions_future.result()
            activity = activity_future.result()
            card_raw = card_raw or {}
            checklists = [c for c in (card_raw.get("checklists") or []) if isinstance(c, dict)]
            self._remember_checklists(_str(card_raw.get("id")), checklists)
            list_raw = card_raw.get("list") if isinstance(card_raw.get("list"), dict) else {}
            board_raw = card_raw.get("board") if isinstance(card_raw.get("board"), dict) else {}
            return {
                "card": normalize_card(card_raw),
                "desc": _str(card_raw.get("desc")),
                "list": {"id": _str(list_raw.get("id")) or _str(card_raw.get("idList")), "name": _str(list_raw.get("name"))},
                "board": {"id": _str(board_raw.get("id")) or _str(card_raw.get("idBoard")), "name": _str(board_raw.get("name"))},
                "checklists": [normalize_checklist(c) for c in _by_pos(checklists)],
                "comments": [normalize_comment(a) for a in (actions_raw or []) if isinstance(a, dict)],
                "attachments": [
                    normalize_attachment(a) for a in (card_raw.get("attachments") or []) if isinstance(a, dict)
                ],
                "activity": activity,
            }

        def tags(detail):
            card = detail["card"]
            return {("card", card_id), ("card", card["id"]), ("card", card["short_link"])}

        return self._cached(("card", card_id), TTL_CARD, load, tags)

    def _fetch_activity(self, card_id):
        raw = self._call(
            "card_actions",
            {"card": card_id},
            {"filter": ACTIVITY_TYPES, "limit": str(ACTIVITY_LIMIT), "memberCreator_fields": "fullName,username"},
        )
        rows = [normalize_activity(a) for a in (raw or []) if isinstance(a, dict)]
        return rows[:ACTIVITY_LIMIT]

    def activity(self, card_id):
        """Latest card actions (created, updated, commented, checklist changes). Never None."""
        card_id = _id(card_id, "card_id")
        return self._cached(
            ("activity", card_id),
            TTL_CARD,
            lambda: self._fetch_activity(card_id),
            lambda _v: {("card", card_id)},
        )

    def attachments(self, card_id):
        card_id = _id(card_id, "card_id")

        def load():
            raw = self._call(
                "card_attachments",
                {"card": card_id},
                {"fields": "name,url,bytes,mimeType,isUpload,previews"},
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
_SHARED_MAX = 8
_shared = {}  # type: dict  # (credentials, transport) -> TrelloClient, oldest first


def set_transport_override(transport):
    """Test seam: route every shared client through ``transport`` (None resets)."""
    global _transport_override
    with _shared_lock:
        _transport_override = transport
        _shared.clear()


def shared_client(environ=None):
    """Client for the currently resolved credentials; raises ``TrelloNotConnected``.

    Credentials are re-resolved on every call, so each request is served with the account of its own
    profile. One client (cache and rate limiter included) is kept per credential pair, which is what stops
    two profiles that use different accounts from sharing, or constantly discarding, each other's data.
    """
    creds, source = resolve_credentials(environ)
    if creds is None:
        raise TrelloNotConnected("Trello credentials are not configured")
    fingerprint = (creds, _transport_override)
    with _shared_lock:
        client = _shared.pop(fingerprint, None)
        if client is None:
            client = TrelloClient(creds, transport=_transport_override)
        _shared[fingerprint] = client
        while len(_shared) > _SHARED_MAX:
            _shared.pop(next(iter(_shared)))
        return client, source
