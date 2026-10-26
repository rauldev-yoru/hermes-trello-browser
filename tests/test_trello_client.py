"""Tests for dashboard/trello_api_client.py. No network: a fake transport answers."""

import atexit
import importlib.util
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

# --- suite sandbox -------------------------------------------------------------
# No test may read or write the real Hermes home, or pick up the real Trello pair
# from the environment. Every other test module imports this one, so the redirect
# happens before any client code resolves a home.
_SANDBOX = tempfile.mkdtemp(prefix="trello-browser-tests-")
os.environ["HOME"] = _SANDBOX
os.environ["HERMES_HOME"] = os.path.join(_SANDBOX, ".hermes")
for _leaky in ("TRELLO_API_KEY", "TRELLO_TOKEN"):
    os.environ.pop(_leaky, None)
atexit.register(shutil.rmtree, _SANDBOX, ignore_errors=True)

ROOT = Path(__file__).resolve().parents[1]


def load_client_module():
    path = ROOT / "dashboard" / "trello_api_client.py"
    existing = sys.modules.get("trello_api_client")
    if existing is not None and Path(existing.__file__).resolve() == path:
        return existing
    spec = importlib.util.spec_from_file_location("trello_api_client", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["trello_api_client"] = module
    spec.loader.exec_module(module)
    return module


C = load_client_module()

# No test may ever reach the real app-wide credentials: the root home is redirected for the whole run, and
# individual tests then patch it again with their own temporary directory.
_SANDBOX = tempfile.mkdtemp(prefix="trello-tests-")
C.ROOT_HOME = Path(_SANDBOX) / "app-root"

KEY = "k" * 32
TOKEN = "t" * 64


def oid(n):
    return f"{n:024x}"


BOARD, LIST_A, LIST_B = oid(1), oid(2), oid(3)
CARD_1, CARD_2 = oid(10), oid(11)
MEMBER, LABEL = oid(20), oid(30)
CHECKLIST, ITEM_1, ITEM_2 = oid(40), oid(41), oid(42)


def resp(data=None, status=200, headers=None, raw=None):
    body = raw if raw is not None else json.dumps(data).encode()
    return status, dict(headers or {}), body


class FakeTime:
    """Deterministic clock; ``sleep`` advances it and is recorded."""

    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class FakeTransport:
    """Routes ``(METHOD, /path)`` to a response, a list of responses, or a callable."""

    def __init__(self, routes=None):
        self.routes = dict(routes or {})
        self.calls = []
        self.lock = threading.Lock()

    def __call__(self, url, method, params):
        path = url[len(C.API_BASE):]
        with self.lock:
            self.calls.append((method, path, dict(params)))
        handler = self.routes.get((method, path))
        if handler is None:
            return resp({"message": "no route"}, 404)
        if callable(handler):
            return handler(params)
        if isinstance(handler, list):
            with self.lock:
                return handler.pop(0) if len(handler) > 1 else handler[0]
        return handler

    def count(self, method=None, path=None):
        return sum(
            1 for m, p, _ in self.calls if (method is None or m == method) and (path is None or p == path)
        )


def raw_card(n=10, list_id=LIST_A, **extra):
    card = {
        "id": oid(n),
        "name": f"Card {n}",
        "idList": list_id,
        "idBoard": BOARD,
        "due": "2026-11-01T12:00:00.000Z",
        "dueComplete": False,
        "labels": [
            {"id": LABEL, "name": "", "color": "green"},
            {"id": oid(31), "name": "Backend", "color": "blue"},
        ],
        "idMembers": [MEMBER],
        "shortLink": "AbCd1234",
        "shortUrl": "https://trello.com/c/AbCd1234",
        "url": "https://trello.com/c/AbCd1234/10-card",
        "badges": {"comments": 2, "attachments": 1, "checkItems": 4, "checkItemsChecked": 1},
        "dateLastActivity": "2026-10-20T09:00:00.000Z",
        "pos": n,
    }
    card.update(extra)
    return card


def board_routes():
    return {
        ("GET", f"/1/boards/{BOARD}"): resp(
            {"id": BOARD, "name": "Demo board", "url": "https://trello.com/b/Demo1234/demo", "closed": False}
        ),
        ("GET", f"/1/boards/{BOARD}/lists"): resp(
            [
                {"id": LIST_B, "name": "Doing", "pos": 2048, "closed": False},
                {"id": LIST_A, "name": "To do", "pos": 1024, "closed": False},
            ]
        ),
        ("GET", f"/1/boards/{BOARD}/cards"): resp([raw_card(11, LIST_B), raw_card(10, LIST_A)]),
        ("GET", f"/1/boards/{BOARD}/members"): resp(
            [{"id": MEMBER, "username": "ada", "fullName": "Ada Demo", "initials": "AD",
              "avatarUrl": "https://example.invalid/avatar/abc"}]
        ),
        ("GET", f"/1/boards/{BOARD}/labels"): resp([{"id": LABEL, "name": "", "color": "green"}]),
    }


def make_client(routes=None, fake_time=None):
    fake_time = fake_time or FakeTime()
    transport = FakeTransport(routes if routes is not None else board_routes())
    client = C.TrelloClient(
        C.Credentials(KEY, TOKEN), transport=transport, clock=fake_time.clock, sleep=fake_time.sleep
    )
    return client, transport, fake_time


class NormalizationTests(unittest.TestCase):
    def test_board_view_shape_is_exact(self):
        client, _, _ = make_client()
        view = client.board_view(BOARD)
        self.assertEqual(set(view), {"board", "lists", "cards", "members", "labels"})
        self.assertEqual(
            view["board"],
            {"id": BOARD, "name": "Demo board", "url": "https://trello.com/b/Demo1234/demo",
             "closed": False, "starred": False},
        )
        self.assertEqual([x["name"] for x in view["lists"]], ["To do", "Doing"])
        self.assertEqual(set(view["lists"][0]), {"id", "name", "pos", "closed"})
        # cards are ordered by Trello position
        self.assertEqual([c["id"] for c in view["cards"]], [CARD_1, CARD_2])
        self.assertEqual(
            view["cards"][0],
            {
                "id": CARD_1, "name": "Card 10", "id_list": LIST_A,
                "closed": False,
                "due": "2026-11-01T12:00:00.000Z", "due_complete": False,
                "labels": ["green", "Backend"], "label_ids": [LABEL, oid(31)], "id_members": [MEMBER],
                "short_link": "AbCd1234", "url": "https://trello.com/c/AbCd1234",
                "comment_count": 2, "attachment_count": 1,
                "checklist": {"total": 4, "done": 1},
                "last_activity": "2026-10-20T09:00:00.000Z",
            },
        )
        self.assertEqual(
            view["members"],
            [{"id": MEMBER, "username": "ada", "full_name": "Ada Demo", "initials": "AD",
              "avatar_url": "https://example.invalid/avatar/abc/50.png"}],
        )
        self.assertEqual(view["labels"], [{"id": LABEL, "name": "", "color": "green"}])

    def test_card_normalizer_tolerates_missing_fields(self):
        card = C.normalize_card({"id": CARD_1})
        self.assertEqual(card["labels"], [])
        self.assertEqual(card["checklist"], {"total": 0, "done": 0})
        self.assertIsNone(card["due"])
        self.assertEqual(card["url"], "")

    def test_card_detail_shape(self):
        card = raw_card(10)
        card.update(
            desc="Hello",
            checklists=[
                {"id": CHECKLIST, "name": "Release", "idCard": CARD_1, "pos": 1,
                 "checkItems": [
                     {"id": ITEM_2, "name": "Tag", "state": "incomplete", "pos": 2},
                     {"id": ITEM_1, "name": "Build", "state": "complete", "pos": 1},
                 ]}
            ],
            attachments=[
                {"id": oid(50), "name": "spec.pdf", "url": "https://example.invalid/spec.pdf",
                 "bytes": 1234, "mimeType": "application/pdf", "isUpload": True},
                {"id": oid(51), "name": "evil", "url": "javascript:alert(1)", "isUpload": False},
            ],
        )
        comments = [{"id": oid(60), "type": "commentCard", "date": "2026-10-21T10:00:00.000Z",
                     "data": {"text": "Looks good"}, "memberCreator": {"fullName": "Ada Demo", "username": "ada"}}]
        feed = [
            {"id": oid(63), "type": "updateCard", "date": "2026-10-22T10:00:00.000Z",
             "data": {"listBefore": {"name": "To do"}, "listAfter": {"name": "Doing"}}, "memberCreator": {"username": "ada"}},
            comments[0],
        ]
        routes = {
            ("GET", f"/1/cards/{CARD_1}"): resp({**card, "list": {"id": LIST_A, "name": "To do"}, "board": {"id": BOARD, "name": "Demo board"}}),
            ("GET", f"/1/cards/{CARD_1}/actions"): lambda params: resp(feed if "updateCard" in params["filter"] else comments),
        }
        client, transport, _ = make_client(routes)
        detail = client.card(CARD_1)
        self.assertEqual(set(detail), {"card", "desc", "list", "board", "checklists", "comments", "attachments", "activity"})
        self.assertEqual(detail["list"], {"id": LIST_A, "name": "To do"})
        self.assertEqual(detail["board"], {"id": BOARD, "name": "Demo board"})
        filters = sorted(c[2]["filter"] for c in transport.calls if c[1].endswith("/actions"))
        self.assertEqual(filters, ["commentCard", C.ACTIVITY_TYPES])
        self.assertEqual(
            detail["activity"],
            [
                {"id": oid(63), "type": "updateCard", "author": "ada", "date": "2026-10-22T10:00:00.000Z",
                 "text": "moved from To do to Doing"},
                {"id": oid(60), "type": "commentCard", "author": "Ada Demo", "date": "2026-10-21T10:00:00.000Z",
                 "text": "Looks good"},
            ],
        )
        self.assertEqual(detail["desc"], "Hello")
        self.assertEqual(
            detail["checklists"],
            [{"id": CHECKLIST, "name": "Release", "items": [
                {"id": ITEM_1, "name": "Build", "state": "complete"},
                {"id": ITEM_2, "name": "Tag", "state": "incomplete"}]}],
        )
        self.assertEqual(
            detail["comments"],
            [{"id": oid(60), "author": "Ada Demo", "text": "Looks good", "date": "2026-10-21T10:00:00.000Z"}],
        )
        self.assertEqual(
            detail["attachments"][0],
            {"id": oid(50), "name": "spec.pdf", "url": "https://example.invalid/spec.pdf",
             "is_upload": True, "bytes": 1234, "mime": "application/pdf"},
        )
        self.assertIsNone(detail["attachments"][1]["url"], "non-http(s) attachment URLs are dropped")

    def test_label_ids_follow_the_labels(self):
        card = C.normalize_card(raw_card(10, labels=[
            {"id": oid(31), "name": "bug", "color": "red"},
            {"id": oid(32), "name": "", "color": "red"},
            {"id": oid(33), "name": "", "color": None},
            {"id": "not-an-id", "name": "odd", "color": "blue"},
        ]))
        self.assertEqual(card["labels"], ["bug", "red", "odd"])
        # every real id is kept, even for a label with no display text; malformed ids are dropped
        self.assertEqual(card["label_ids"], [oid(31), oid(32), oid(33)])
        self.assertEqual(C.normalize_card({"id": CARD_1})["label_ids"], [])

    def test_activity_summaries(self):
        def action(kind, data, n=1):
            return {"id": oid(200 + n), "type": kind, "date": "2026-10-22T10:00:00.000Z",
                    "data": data, "memberCreator": {"fullName": "Ada Demo"}}

        cases = {
            "createCard": (action("createCard", {"list": {"name": "Backlog"}}), "created this card in Backlog"),
            "moved": (action("updateCard", {"listBefore": {"name": "A"}, "listAfter": {"name": "B"}}), "moved from A to B"),
            "archived": (action("updateCard", {"old": {"closed": False}, "card": {"closed": True}}), "archived this card"),
            "restored": (action("updateCard", {"old": {"closed": True}, "card": {"closed": False}}), "restored this card"),
            "changed": (action("updateCard", {"old": {"due": None, "desc": ""}}), "changed description, due date"),
            "updated": (action("updateCard", {"old": {"pos": 1}}), "updated this card"),
            "checklist": (action("addChecklistToCard", {"checklist": {"name": "QA"}}), "added checklist QA"),
            "done": (action("updateCheckItemStateOnCard", {"checkItem": {"name": "Ship", "state": "complete"}}), "completed Ship"),
            "undone": (action("updateCheckItemStateOnCard", {"checkItem": {"name": "Ship", "state": "incomplete"}}), "marked incomplete Ship"),
            "comment": (action("commentCard", {"text": "hello"}), "hello"),
        }

        for name, (raw, expected) in cases.items():
            row = C.normalize_activity(raw)
            self.assertEqual(row["text"], expected, name)
            self.assertEqual(set(row), {"id", "type", "author", "date", "text"})
            self.assertEqual(row["type"], raw["type"], "type is kept exactly as Trello sends it")
            self.assertEqual(row["author"], "Ada Demo")

        self.assertEqual(C.normalize_activity({"type": "weird"})["text"], "")
        self.assertLessEqual(len(C.normalize_activity(action("updateCard", {"listBefore": {"name": "x" * 500}, "listAfter": {"name": "y"}}))["text"]), 200)

    def test_activity_is_a_list_even_when_empty_and_capped_at_20(self):
        routes = {
            ("GET", f"/1/cards/{CARD_1}"): resp(raw_card(10)),
            ("GET", f"/1/cards/{CARD_1}/actions"): resp([]),
        }
        client, transport, _ = make_client(routes)
        self.assertEqual(client.card(CARD_1)["activity"], [])
        self.assertEqual(client.activity(CARD_1), [])

        many = [{"id": oid(300 + i), "type": "commentCard", "date": "2026-10-22T10:00:00Z", "data": {"text": str(i)}} for i in range(30)]
        transport.routes[("GET", f"/1/cards/{CARD_1}/actions")] = resp(many)
        client.invalidate_card(CARD_1)
        self.assertEqual(len(client.activity(CARD_1)), 20)
        self.assertEqual(transport.calls[-1][2]["limit"], "20")

    def test_activity_shares_the_card_cache_rules(self):
        routes = {("GET", f"/1/cards/{CARD_1}/actions"): resp([])}
        client, transport, fake = make_client(routes)
        client.activity(CARD_1)
        fake.now += 9
        client.activity(CARD_1)
        self.assertEqual(transport.count(), 1)
        fake.now += 2
        client.activity(CARD_1)
        self.assertEqual(transport.count(), 2, "same 10 s TTL as the card detail")
        client.invalidate_card(CARD_1)
        client.activity(CARD_1)
        self.assertEqual(transport.count(), 3, "same invalidation as the card detail")

    def test_boards_starred_first(self):
        routes = {
            ("GET", "/1/members/me/boards"): resp(
                [
                    {"id": oid(5), "name": "Zeta", "url": "https://trello.com/b/zzzzzzzz", "closed": False, "starred": False},
                    {"id": oid(6), "name": "beta", "url": "https://trello.com/b/bbbbbbbb", "closed": False, "starred": True},
                    {"id": oid(7), "name": "Alpha", "url": "https://trello.com/b/aaaaaaaa", "closed": False, "starred": False},
                ]
            )
        }
        client, _, _ = make_client(routes)
        self.assertEqual([b["name"] for b in client.boards()], ["beta", "Alpha", "Zeta"])


class AuthAndValidationTests(unittest.TestCase):
    def test_every_request_carries_key_and_token(self):
        client, transport, _ = make_client()
        client.board_view(BOARD)
        self.assertEqual(transport.count(), 5)
        for _, _, params in transport.calls:
            self.assertEqual(params["key"], KEY)
            self.assertEqual(params["token"], TOKEN)

    def test_member_hits_members_me(self):
        routes = {("GET", "/1/members/me"): resp({"id": MEMBER, "username": "ada", "fullName": "Ada Demo"})}
        client, transport, _ = make_client(routes)
        self.assertEqual(client.member()["username"], "ada")
        self.assertEqual(transport.calls[0][:2], ("GET", "/1/members/me"))

    def test_secrets_never_in_repr(self):
        client, _, _ = make_client()
        self.assertNotIn(TOKEN, repr(client))
        self.assertNotIn(KEY, repr(client))
        self.assertNotIn(TOKEN, repr(C.Credentials(KEY, TOKEN)))

    def test_invalid_ids_rejected_before_network(self):
        client, transport, _ = make_client()
        bad = ["", "xyz", "../../etc/passwd", BOARD + "0", "G" * 24, "AbCd123", "AbCd12345", BOARD + "\n", None, 12]
        for value in bad:
            for call in (client.board_view, client.card, client.attachments, client.board_cards_page):
                with self.assertRaises(ValueError, msg=repr(value)):
                    call(value)
        with self.assertRaises(ValueError):
            client.create_card("shortlnk", "x")  # list ids must be 24-hex
        with self.assertRaises(ValueError):
            client.add_checklist_item("AbCd1234", "x")
        self.assertEqual(transport.calls, [])

    def test_short_links_are_accepted(self):
        routes = {("GET", "/1/cards/AbCd1234/attachments"): resp([])}
        client, transport, _ = make_client(routes)
        self.assertEqual(client.attachments("AbCd1234"), [])
        self.assertEqual(transport.count(), 1)

    def test_input_validation(self):
        client, transport, _ = make_client()
        with self.assertRaises(ValueError):
            client.create_card(LIST_A, "   ")
        with self.assertRaises(ValueError):
            client.create_card(LIST_A, "ok", due="next tuesday")
        with self.assertRaises(ValueError):
            client.update_card(CARD_1)
        with self.assertRaises(ValueError):
            client.update_card(CARD_1, bogus=1)
        with self.assertRaises(ValueError):
            client.update_card(CARD_1, closed="yes")
        with self.assertRaises(ValueError):
            client.set_checklist_item(CHECKLIST, ITEM_1, state="done", card_id=CARD_1)
        with self.assertRaises(ValueError):
            client.board_cards_page(BOARD, before="yesterday")
        with self.assertRaises(ValueError):
            client.add_comment(CARD_1, "x" * (C.MAX_TEXT + 1))
        self.assertEqual(transport.calls, [])


class ErrorMappingTests(unittest.TestCase):
    def one(self, response):
        client, transport, fake = make_client({("GET", "/1/members/me"): response})
        return client, transport, fake

    def test_401_is_auth_error_and_not_retried(self):
        client, transport, _ = self.one(resp(raw=b"invalid token", status=401))
        with self.assertRaises(C.TrelloAuthError):
            client.member()
        self.assertEqual(transport.count(), 1)

    def test_401_permission_message_is_not_found(self):
        client, _, _ = self.one(resp(raw=b"unauthorized card permission requested", status=401))
        with self.assertRaises(C.TrelloNotFound):
            client.member()

    def test_404(self):
        client, _, _ = self.one(resp(raw=b"not found", status=404))
        with self.assertRaises(C.TrelloNotFound):
            client.member()

    def test_5xx_and_malformed_and_network(self):
        client, _, _ = self.one(resp(raw=b"boom", status=502))
        with self.assertRaises(C.TrelloUnavailable):
            client.member()
        client, _, _ = self.one(resp(raw=b"<html>", status=200))
        with self.assertRaises(C.TrelloUnavailable):
            client.member()

        def explode(url, method, params):
            raise TimeoutError("socket timeout")

        fake = FakeTime()
        client = C.TrelloClient(C.Credentials(KEY, TOKEN), transport=explode, clock=fake.clock, sleep=fake.sleep)
        with self.assertRaises(C.TrelloUnavailable):
            client.member()

    def test_400_message_is_scrubbed(self):
        client, _, _ = self.one(resp(raw=f"invalid value for token {TOKEN} and key {KEY}".encode(), status=400))
        with self.assertRaises(C.TrelloBadRequest) as ctx:
            client.member()
        self.assertNotIn(TOKEN, str(ctx.exception))
        self.assertNotIn(KEY, str(ctx.exception))

    def test_429_backoff_then_success(self):
        client, transport, fake = self.one(
            [resp(raw=b"", status=429), resp(raw=b"", status=429), resp({"id": MEMBER, "username": "ada"})]
        )
        transport.routes[("GET", "/1/members/me")] = [
            resp(raw=b"", status=429), resp(raw=b"", status=429), resp({"id": MEMBER, "username": "ada"})
        ]
        self.assertEqual(client.member()["username"], "ada")
        self.assertEqual(transport.count(), 3)
        self.assertEqual(fake.sleeps, [1.0, 2.0])

    def test_429_honours_retry_after(self):
        client, transport, fake = make_client()
        transport.routes[("GET", "/1/members/me")] = [
            resp(raw=b"", status=429, headers={"Retry-After": "3"}),
            resp({"id": MEMBER, "username": "ada"}),
        ]
        client.member()
        self.assertEqual(fake.sleeps, [3.0])

    def test_429_gives_up_after_two_retries(self):
        client, transport, fake = make_client()
        transport.routes[("GET", "/1/members/me")] = resp(raw=b"", status=429)
        with self.assertRaises(C.TrelloRateLimited) as ctx:
            client.member()
        self.assertEqual(transport.count(), 3)  # first try + 2 retries
        self.assertEqual(fake.sleeps, [1.0, 2.0])
        self.assertEqual(ctx.exception.retry_after, 4)

    def test_429_with_long_retry_after_does_not_block(self):
        client, transport, fake = make_client()
        transport.routes[("GET", "/1/members/me")] = resp(raw=b"", status=429, headers={"retry-after": "30"})
        with self.assertRaises(C.TrelloRateLimited) as ctx:
            client.member()
        self.assertEqual(ctx.exception.retry_after, 30)
        self.assertEqual(transport.count(), 1)
        self.assertEqual(fake.sleeps, [])


class CacheTests(unittest.TestCase):
    def test_board_view_ttl_20s(self):
        client, transport, fake = make_client()
        client.board_view(BOARD)
        fake.now += 19
        client.board_view(BOARD)
        self.assertEqual(transport.count(), 5)
        fake.now += 2
        client.board_view(BOARD)
        self.assertEqual(transport.count(), 10)

    def test_card_ttl_10s_and_boards_ttl_60s(self):
        routes = {
            ("GET", f"/1/cards/{CARD_1}"): resp(raw_card(10)),
            ("GET", f"/1/cards/{CARD_1}/actions"): resp([]),
            ("GET", "/1/members/me/boards"): resp([]),
        }
        client, transport, fake = make_client(routes)
        client.card(CARD_1)
        client.boards()
        fake.now += 9
        client.card(CARD_1)
        self.assertEqual(transport.count(path=f"/1/cards/{CARD_1}"), 1)
        fake.now += 2
        client.card(CARD_1)
        self.assertEqual(transport.count(path=f"/1/cards/{CARD_1}"), 2)
        self.assertEqual(transport.count(path="/1/members/me/boards"), 1)  # still inside 60 s
        fake.now += 50
        client.boards()
        self.assertEqual(transport.count(path="/1/members/me/boards"), 2)

    def test_cached_values_are_copies(self):
        client, _, _ = make_client()
        first = client.board_view(BOARD)
        first["cards"].clear()
        self.assertEqual(len(client.board_view(BOARD)["cards"]), 2)

    def test_invalidate_board_and_card(self):
        client, transport, _ = make_client()
        client.board_view(BOARD)
        client.board_view(BOARD)
        self.assertEqual(transport.count(), 5)
        client.invalidate_board(BOARD)
        client.board_view(BOARD)
        self.assertEqual(transport.count(), 10)
        client.invalidate_card(CARD_1)  # the view contains this card
        client.board_view(BOARD)
        self.assertEqual(transport.count(), 15)

    def test_writes_invalidate_cached_reads(self):
        routes = board_routes()
        routes[("POST", f"/1/cards/{CARD_1}/actions/comments")] = resp(
            {"id": oid(61), "date": "2026-10-22T00:00:00.000Z", "data": {"text": "hi"},
             "memberCreator": {"fullName": "Ada Demo"}}
        )
        routes[("PUT", f"/1/cards/{CARD_1}")] = resp(raw_card(10, LIST_B))
        client, transport, _ = make_client(routes)
        client.board_view(BOARD)
        client.add_comment(CARD_1, "hi")
        client.board_view(BOARD)
        self.assertEqual(transport.count(method="GET", path=f"/1/boards/{BOARD}"), 2)
        client.update_card(CARD_1, id_list=LIST_B)
        client.board_view(BOARD)
        self.assertEqual(transport.count(method="GET", path=f"/1/boards/{BOARD}"), 3)

    def test_invalidation_during_inflight_load_is_not_cached(self):
        entered, release = threading.Event(), threading.Event()
        routes = board_routes()
        base = routes[("GET", f"/1/boards/{BOARD}")]

        def slow(params):
            entered.set()
            release.wait(2)
            return base

        routes[("GET", f"/1/boards/{BOARD}")] = slow
        client, transport, _ = make_client(routes)
        worker = threading.Thread(target=client.board_view, args=(BOARD,))
        worker.start()
        self.assertTrue(entered.wait(2))
        client.invalidate_board(BOARD)
        release.set()
        worker.join(3)
        transport.routes[("GET", f"/1/boards/{BOARD}")] = base
        before = transport.count()
        client.board_view(BOARD)
        self.assertEqual(transport.count(), before + 5, "stale in-flight result must not be cached")


class ConcurrencyTests(unittest.TestCase):
    def test_single_flight_shares_one_fanout(self):
        entered, release = threading.Event(), threading.Event()
        routes = board_routes()
        base = routes[("GET", f"/1/boards/{BOARD}")]

        def slow(params):
            entered.set()
            release.wait(3)
            return base

        routes[("GET", f"/1/boards/{BOARD}")] = slow
        client, transport, _ = make_client(routes)
        results = []

        def call():
            results.append(client.board_view(BOARD))

        first = threading.Thread(target=call)
        first.start()
        self.assertTrue(entered.wait(2))
        second = threading.Thread(target=call)
        second.start()
        time.sleep(0.2)  # let the second caller reach the per-key lock
        release.set()
        first.join(3)
        second.join(3)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0], results[1])
        self.assertEqual(transport.count(), 5, "two callers, one upstream fan-out")

    def test_board_view_requests_run_in_parallel(self):
        barrier = threading.Barrier(4, timeout=3)
        seen = []
        lock = threading.Lock()
        routes = board_routes()

        def gated(inner):
            def handler(params):
                with lock:
                    index = len(seen)
                    seen.append(1)
                if index < 4:
                    barrier.wait()  # raises BrokenBarrierError if fan-out were serial
                return inner

            return handler

        for key in list(routes):
            routes[key] = gated(routes[key])
        client, transport, _ = make_client(routes)
        view = client.board_view(BOARD)
        self.assertEqual(len(view["cards"]), 2)
        self.assertEqual(transport.count(), 5)

    def test_board_view_propagates_upstream_error(self):
        routes = board_routes()
        routes[("GET", f"/1/boards/{BOARD}/cards")] = resp(raw=b"nope", status=401)
        client, _, _ = make_client(routes)
        with self.assertRaises(C.TrelloAuthError):
            client.board_view(BOARD)


class RateLimiterTests(unittest.TestCase):
    def test_global_budget_60_per_10s(self):
        routes = {("GET", "/1/search"): resp({"cards": [], "boards": []})}
        client, transport, fake = make_client(routes)
        for i in range(60):
            client.search(f"q{i}")
        self.assertEqual(fake.sleeps, [])
        with self.assertRaises(C.TrelloRateLimited) as ctx:
            client.search("one-too-many")  # frees up in 10 s: longer than the 2 s cap
        self.assertEqual(ctx.exception.retry_after, 10)
        self.assertEqual(fake.sleeps, [])
        self.assertEqual(transport.count(), 60)

    def test_short_wait_is_slept_not_raised(self):
        routes = {("GET", "/1/search"): resp({"cards": [], "boards": []})}
        client, transport, fake = make_client(routes)
        for i in range(60):
            client.search(f"q{i}")
        fake.now += 8.5  # oldest request leaves the window in 1.5 s
        client.search("late")
        self.assertEqual(len(fake.sleeps), 1)
        self.assertAlmostEqual(fake.sleeps[0], 1.5, places=3)
        self.assertEqual(transport.count(), 61)

    def test_members_budget_20_per_10s(self):
        routes = {("GET", "/1/members/me"): resp({"id": MEMBER, "username": "ada"})}
        client, transport, fake = make_client(routes)
        for _ in range(20):
            client._call("member_me")
        with self.assertRaises(C.TrelloRateLimited):
            client._call("member_me")
        self.assertEqual(transport.count(), 20)
        # non-member endpoints still have room under the global cap
        transport.routes[("GET", "/1/search")] = resp({"cards": [], "boards": []})
        client.search("still fine")
        self.assertEqual(transport.count(), 21)
        fake.now += 10.5
        client._call("member_me")
        self.assertEqual(transport.count(), 22)


class WriteTests(unittest.TestCase):
    def test_create_card(self):
        routes = board_routes()
        routes[("POST", "/1/cards")] = resp(raw_card(12, LIST_A, name="Fresh"))
        client, transport, _ = make_client(routes)
        client.board_view(BOARD)
        card = client.create_card(LIST_A, "Fresh", desc="d", due="2026-12-01")
        self.assertEqual(card["name"], "Fresh")
        method, path, params = transport.calls[-1]
        self.assertEqual((method, path), ("POST", "/1/cards"))
        self.assertEqual(
            {k: v for k, v in params.items() if k not in ("key", "token")},
            {"idList": LIST_A, "name": "Fresh", "desc": "d", "due": "2026-12-01"},
        )
        client.board_view(BOARD)
        self.assertEqual(transport.count(method="GET", path=f"/1/boards/{BOARD}"), 2)

    def test_update_card_params(self):
        routes = {("PUT", f"/1/cards/{CARD_1}"): resp(raw_card(10))}
        client, transport, _ = make_client(routes)
        client.update_card(CARD_1, name="New", desc="", due=None, id_list=LIST_B, closed=True, id_labels=[LABEL])
        params = transport.calls[0][2]
        self.assertEqual(params["name"], "New")
        self.assertEqual(params["desc"], "")
        self.assertEqual(params["due"], "null")
        self.assertEqual(params["idList"], LIST_B)
        self.assertEqual(params["closed"], "true")
        self.assertEqual(params["idLabels"], LABEL)

    def test_comment_and_checklist_flow(self):
        routes = {
            ("POST", f"/1/cards/{CARD_1}/actions/comments"): resp(
                {"id": oid(61), "date": "2026-10-22T00:00:00.000Z", "data": {"text": "hello"},
                 "memberCreator": {"username": "ada"}}),
            ("POST", f"/1/cards/{CARD_1}/checklists"): resp({"id": CHECKLIST, "name": "Plan", "idCard": CARD_1}),
            ("POST", f"/1/checklists/{CHECKLIST}/checkItems"): resp({"id": ITEM_1, "name": "Step", "state": "incomplete"}),
            ("PUT", f"/1/cards/{CARD_1}/checkItem/{ITEM_1}"): resp({"id": ITEM_1, "name": "Step", "state": "complete"}),
            ("DELETE", f"/1/checklists/{CHECKLIST}/checkItems/{ITEM_1}"): resp({}),
        }
        client, transport, _ = make_client(routes)
        self.assertEqual(client.add_comment(CARD_1, "hello")["author"], "ada")
        self.assertEqual(client.add_checklist(CARD_1, "Plan"), {"id": CHECKLIST, "name": "Plan", "items": []})
        self.assertEqual(client.add_checklist_item(CHECKLIST, "Step")["state"], "incomplete")
        # the checklist -> card mapping learnt above avoids an extra lookup
        item = client.set_checklist_item(CHECKLIST, ITEM_1, state="complete")
        self.assertEqual(item["state"], "complete")
        self.assertEqual(transport.count(path=f"/1/checklists/{CHECKLIST}"), 0)
        self.assertEqual(transport.calls[-1][2]["state"], "complete")
        self.assertIsNone(client.delete_checklist_item(CHECKLIST, ITEM_1))
        self.assertEqual(transport.calls[-1][0], "DELETE")

    def test_set_item_looks_up_card_when_unknown(self):
        routes = {
            ("GET", f"/1/checklists/{CHECKLIST}"): resp({"id": CHECKLIST, "idCard": CARD_1}),
            ("PUT", f"/1/cards/{CARD_1}/checkItem/{ITEM_1}"): resp({"id": ITEM_1, "name": "Step", "state": "complete"}),
        }
        client, transport, _ = make_client(routes)
        client.set_checklist_item(CHECKLIST, ITEM_1, state="complete")
        self.assertEqual(transport.count(path=f"/1/checklists/{CHECKLIST}"), 1)

    def test_search_shape(self):
        routes = {
            ("GET", "/1/search"): resp(
                {"boards": [{"id": BOARD, "name": "Demo", "url": "https://trello.com/b/Demo1234"}],
                 "cards": [raw_card(10)]}
            )
        }
        client, transport, _ = make_client(routes)
        result = client.search("demo")
        self.assertEqual(result["boards"][0]["name"], "Demo")
        self.assertEqual(result["cards"][0]["id_board"], BOARD)
        self.assertEqual(transport.calls[0][2]["query"], "demo")

    def test_cards_page_next_before(self):
        cards = [raw_card(100 + i) for i in range(C.PAGE_LIMIT)]
        routes = {("GET", f"/1/boards/{BOARD}/cards"): resp(cards)}
        client, transport, _ = make_client(routes)
        page = client.board_cards_page(BOARD, before="2026-12-01T00:00:00Z")
        self.assertEqual(len(page["cards"]), C.PAGE_LIMIT)
        self.assertEqual(page["next_before"], oid(100))
        self.assertEqual(transport.calls[0][2]["before"], "2026-12-01T00:00:00Z")
        transport.routes[("GET", f"/1/boards/{BOARD}/cards")] = resp([raw_card(10)])
        self.assertIsNone(client.board_cards_page(BOARD)["next_before"])


class DefaultTransportTests(unittest.TestCase):
    class FakeResponse:
        status = 200
        headers = {"X-Test": "1"}

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self, n=-1):
            return b"{}"

    def run_transport(self, method, params):
        captured = {}

        class FakeOpener:
            def open(self, request, timeout=None):
                captured["request"] = request
                captured["timeout"] = timeout
                return DefaultTransportTests.FakeResponse()

        with mock.patch("urllib.request.build_opener", return_value=FakeOpener()):
            result = C.default_transport(C.API_BASE + "/1/cards", method, params)
        return captured, result

    def test_get_puts_everything_in_the_query(self):
        captured, result = self.run_transport("GET", {"fields": "name", "key": KEY, "token": TOKEN})
        request = captured["request"]
        self.assertEqual(result[0], 200)
        self.assertEqual(captured["timeout"], 15)
        self.assertIsNone(request.data)
        self.assertIn("fields=name", request.full_url)
        self.assertEqual(request.get_header("User-agent"), "hermes-trello-browser/0.1")

    def test_post_keeps_auth_in_query_and_data_in_body(self):
        captured, _ = self.run_transport("POST", {"name": "a b&c", "key": KEY, "token": TOKEN})
        request = captured["request"]
        self.assertIn("key=", request.full_url)
        self.assertNotIn("name=", request.full_url)
        self.assertEqual(request.data, b"name=a+b%26c")

    def test_refuses_foreign_hosts(self):
        with self.assertRaises(C.TrelloUnavailable):
            C.default_transport("https://example.invalid/1/cards", "GET", {})
        with self.assertRaises(C.TrelloUnavailable):
            C.default_transport("http://api.trello.com/1/cards", "GET", {})


class CredentialsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.home = base / "home"
        self.root = base / "root"  # the app-wide home
        self.profile = base / "profile"  # this request's home
        for d in (self.home, self.root, self.profile):
            d.mkdir()
        for patcher in (
            mock.patch.object(Path, "home", return_value=self.home),
            mock.patch.object(C, "ROOT_HOME", self.root),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.env = {"HERMES_HOME": str(self.profile)}

    def write(self, directory, key="rootkey-1234", token="roottoken-1234"):
        target = directory / "trello-browser"
        target.mkdir(parents=True, exist_ok=True)
        (target / "credentials.json").write_text(json.dumps({"api_key": key, "token": token}))

    def file_of(self, directory):
        return directory / "trello-browser" / "credentials.json"

    # -- resolution ----------------------------------------------------------

    def test_nothing_configured(self):
        creds, source = C.resolve_credentials(self.env)
        self.assertIsNone(creds)
        self.assertIsNone(source)
        self.assertEqual(
            C.credentials_status(self.env),
            {
                "configured": False, "source": None, "active_scope": None, "env_partial": False,
                "app_file": False, "profile_file": False, "profile_overrides": False,
                "profile_is_root": False, "profile_home": str(self.profile),
            },
        )

    def test_env_wins_over_both_files(self):
        self.write(self.profile, "profilekey", "profiletoken")
        self.write(self.root)
        env = {**self.env, "TRELLO_API_KEY": "envkey-1234", "TRELLO_TOKEN": "envtoken-1234"}
        creds, source = C.resolve_credentials(env)
        self.assertEqual((creds.api_key, creds.token, source), ("envkey-1234", "envtoken-1234", "env"))
        status = C.credentials_status(env)
        self.assertEqual((status["source"], status["active_scope"]), ("env", "env"))
        self.assertEqual((status["app_file"], status["profile_file"], status["profile_overrides"]), (True, True, False))

    def test_partial_env_is_ignored_and_reported(self):
        env = {**self.env, "TRELLO_API_KEY": "envkey-1234"}
        self.assertIsNone(C.resolve_credentials(env)[0])
        self.assertTrue(C.credentials_status(env)["env_partial"])

    def test_profile_file_beats_app_file(self):
        self.write(self.profile, "profilekey", "profiletoken")
        self.write(self.root)
        creds, source = C.resolve_credentials(self.env)
        self.assertEqual((creds.api_key, source), ("profilekey", "profile"))
        status = C.credentials_status(self.env)
        self.assertEqual((status["source"], status["active_scope"]), ("profile", "profile"))
        self.assertEqual((status["app_file"], status["profile_file"], status["profile_overrides"]), (True, True, True))

    def test_app_file_used_when_the_profile_has_none(self):
        self.write(self.root, "rootkey-1234", "roottoken-1234")
        creds, source = C.resolve_credentials(self.env)
        self.assertEqual((creds.api_key, source), ("rootkey-1234", "app"))
        status = C.credentials_status(self.env)
        self.assertEqual((status["source"], status["active_scope"]), ("app", "app"))
        self.assertEqual((status["app_file"], status["profile_file"], status["profile_overrides"]), (True, False, False))

    def test_profile_file_alone_is_used(self):
        self.write(self.profile, "profilekey", "profiletoken")
        creds, source = C.resolve_credentials(self.env)
        self.assertEqual((creds.api_key, source), ("profilekey", "profile"))
        status = C.credentials_status(self.env)
        self.assertEqual((status["app_file"], status["profile_file"]), (False, True))

    def test_without_a_separate_profile_the_app_file_is_the_only_file(self):
        env = {"HERMES_HOME": str(self.root)}
        self.write(self.root)
        creds, source = C.resolve_credentials(env)
        self.assertEqual(source, "app")
        status = C.credentials_status(env)
        self.assertEqual(
            (status["profile_is_root"], status["profile_file"], status["profile_overrides"], status["app_file"]),
            (True, False, False, True),
        )

    def test_status_never_contains_secrets(self):
        self.write(self.profile, "profilekey-secret", "profiletoken-secret")
        self.write(self.root, "rootkey-secret", "roottoken-secret")
        dumped = json.dumps(C.credentials_status(self.env))
        for secret in ("profilekey-secret", "profiletoken-secret", "rootkey-secret", "roottoken-secret"):
            self.assertNotIn(secret, dumped)

    def test_corrupt_file_is_treated_as_missing(self):
        target = self.profile / "trello-browser"
        target.mkdir()
        (target / "credentials.json").write_text("{not json")
        self.assertIsNone(C.resolve_credentials(self.env)[0])
        self.assertFalse(C.credentials_status(self.env)["profile_file"])
        self.write(self.root)
        self.assertEqual(C.resolve_credentials(self.env)[1], "app", "a corrupt profile file does not hide the app file")

    # -- saving --------------------------------------------------------------

    def test_save_defaults_to_the_app_scope(self):
        saved = C.save_credentials("newkey-12345", "newtoken-12345", environ=self.env)
        self.assertEqual(saved, {"path": self.file_of(self.root), "scope": "app", "requested_scope": "app"})
        self.assertFalse(self.file_of(self.profile).exists())

    def test_save_by_scope_writes_private_files_and_hides_secrets(self):
        for scope, home in (("app", self.root), ("profile", self.profile)):
            saved = C.save_credentials("newkey-12345", "newtoken-12345", scope=scope, environ=self.env)
            path = saved["path"]
            self.assertEqual((path, saved["scope"], saved["requested_scope"]), (self.file_of(home), scope, scope))
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertEqual(json.loads(path.read_text()), {"api_key": "newkey-12345", "token": "newtoken-12345"})
            self.assertEqual([p.name for p in path.parent.iterdir()], ["credentials.json"], "atomic write leaves no temp file")
        status = C.credentials_status(self.env)
        self.assertEqual(status["source"], "profile")
        self.assertNotIn("newtoken", json.dumps(status))
        self.assertNotIn("newkey", json.dumps(status))

    def test_saving_one_scope_leaves_the_other_alone(self):
        self.write(self.root, "rootkey-1234", "roottoken-1234")
        C.save_credentials("profilekey-1", "profiletoken-1", scope="profile", environ=self.env)
        self.assertEqual(json.loads(self.file_of(self.root).read_text())["api_key"], "rootkey-1234")
        C.save_credentials("rootkey-5678", "roottoken-5678", scope="app", environ=self.env)
        self.assertEqual(json.loads(self.file_of(self.profile).read_text())["api_key"], "profilekey-1")

    def test_profile_scope_degrades_to_the_root_without_a_separate_profile(self):
        env = {"HERMES_HOME": str(self.root)}
        saved = C.save_credentials("newkey-12345", "newtoken-12345", scope="profile", environ=env)
        self.assertEqual(saved, {"path": self.file_of(self.root), "scope": "app", "requested_scope": "profile"})
        self.assertEqual(C.credentials_status(env)["source"], "app")

    def test_save_rejects_unknown_scope_and_garbage_and_writes_nothing(self):
        with self.assertRaises(ValueError):
            C.save_credentials("newkey-12345", "newtoken-12345", scope="everyone", environ=self.env)
        for key, token in (("", "tokentoken1"), ("short", "tokentoken1"), ("has space 1234", "tokentoken1"),
                           ("keykeykey1", "bad\ntoken1234"), (None, "tokentoken1")):
            for scope in ("app", "profile"):
                with self.assertRaises(ValueError):
                    C.save_credentials(key, token, scope=scope, environ=self.env)
        self.assertFalse((self.profile / "trello-browser").exists())
        self.assertFalse((self.root / "trello-browser").exists())

    # -- deleting ------------------------------------------------------------

    def test_delete_only_touches_the_chosen_scope(self):
        C.save_credentials("profilekey-1", "profiletoken-1", scope="profile", environ=self.env)
        C.save_credentials("rootkey-1234", "roottoken-1234", scope="app", environ=self.env)
        self.assertTrue(C.delete_credentials(scope="profile", environ=self.env))
        self.assertFalse(C.delete_credentials(scope="profile", environ=self.env))
        self.assertTrue(self.file_of(self.root).exists())
        self.assertTrue(C.delete_credentials(scope="app", environ=self.env))
        self.assertFalse(self.file_of(self.root).exists())

    def test_delete_defaults_to_the_app_scope(self):
        C.save_credentials("profilekey-1", "profiletoken-1", scope="profile", environ=self.env)
        C.save_credentials("rootkey-1234", "roottoken-1234", scope="app", environ=self.env)
        self.assertTrue(C.delete_credentials(environ=self.env))
        self.assertTrue(self.file_of(self.profile).exists())

    def test_delete_rejects_unknown_scope(self):
        with self.assertRaises(ValueError):
            C.delete_credentials(scope="everyone", environ=self.env)

    def test_delete_profile_without_a_separate_profile_removes_the_app_file(self):
        env = {"HERMES_HOME": str(self.root)}
        self.write(self.root)
        self.assertTrue(C.delete_credentials(scope="profile", environ=env))
        self.assertFalse(self.file_of(self.root).exists())

    # -- homes ----------------------------------------------------------------

    def test_default_home_when_hermes_home_unset(self):
        self.assertEqual(C.effective_home({}), self.home / ".hermes")
        self.assertEqual(C.credentials_path("profile", {}), self.home / ".hermes" / "trello-browser" / "credentials.json")

    def test_effective_home_follows_the_hermes_context_home(self):
        ctx_home = Path(self.tmp.name) / "context-home"
        fake = types.SimpleNamespace(get_hermes_home=lambda: ctx_home)
        with mock.patch.dict(sys.modules, {"hermes_constants": fake}):
            self.assertEqual(C.effective_home(), ctx_home)

    def test_effective_home_without_hermes_uses_the_environment(self):
        with mock.patch.dict(sys.modules, {"hermes_constants": None}):  # makes the import raise ImportError
            with mock.patch.dict(os.environ, {"HERMES_HOME": str(self.profile)}):
                self.assertEqual(C.effective_home(), self.profile)
            env = {k: v for k, v in os.environ.items() if k != "HERMES_HOME"}
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(C.effective_home(), self.home / ".hermes")

    def test_effective_home_survives_a_failing_hermes_lookup(self):
        def boom():
            raise RuntimeError("no home")

        with mock.patch.dict(sys.modules, {"hermes_constants": types.SimpleNamespace(get_hermes_home=boom)}):
            with mock.patch.dict(os.environ, {"HERMES_HOME": str(self.profile)}):
                self.assertEqual(C.effective_home(), self.profile)

    def test_each_request_is_resolved_in_its_own_profile(self):
        """The live (no ``environ``) path: two profiles, two accounts, one shared app account."""
        other = Path(self.tmp.name) / "other-profile"
        other.mkdir()
        self.write(self.profile, "profilekey-A", "profiletoken-A")
        self.write(other, "profilekey-B", "profiletoken-B")
        self.write(self.root, "rootkey-1234", "roottoken-1234")
        current = {"home": self.profile}
        fake = types.SimpleNamespace(get_hermes_home=lambda: current["home"])
        with mock.patch.dict(sys.modules, {"hermes_constants": fake}), mock.patch.dict(os.environ, {}, clear=False):
            for var in ("TRELLO_API_KEY", "TRELLO_TOKEN"):
                os.environ.pop(var, None)
            seen = []
            for home in (self.profile, other, self.profile):
                current["home"] = home
                creds, source = C.resolve_credentials()
                seen.append((creds.api_key, source))
            self.assertEqual(seen, [("profilekey-A", "profile"), ("profilekey-B", "profile"), ("profilekey-A", "profile")])
            current["home"] = Path(self.tmp.name) / "profile-without-file"
            creds, source = C.resolve_credentials()
            self.assertEqual((creds.api_key, source), ("rootkey-1234", "app"))

    def test_root_home_is_captured_from_the_process_home(self):
        raw = str(Path(self.tmp.name) / "process-home")
        with mock.patch.dict(sys.modules, {"hermes_constants": None}), mock.patch.dict(os.environ, {"HERMES_HOME": raw}):
            self.assertEqual(C._capture_root_home(), Path(raw))
        env = {k: v for k, v in os.environ.items() if k != "HERMES_HOME"}
        with mock.patch.dict(sys.modules, {"hermes_constants": None}), mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(C._capture_root_home(), self.home / ".hermes")

    def test_root_home_asks_hermes_for_the_root_of_a_named_profile(self):
        tree_root = Path(self.tmp.name) / "tree-root"
        fake = types.SimpleNamespace(get_default_hermes_root=lambda: tree_root)
        profile_home = str(tree_root / "profiles" / "work")
        with mock.patch.dict(sys.modules, {"hermes_constants": fake}), mock.patch.dict(os.environ, {"HERMES_HOME": profile_home}):
            self.assertEqual(C._capture_root_home(), tree_root)

        def boom():
            raise RuntimeError("no root")

        with mock.patch.dict(sys.modules, {"hermes_constants": types.SimpleNamespace(get_default_hermes_root=boom)}):
            with mock.patch.dict(os.environ, {"HERMES_HOME": profile_home}):
                self.assertEqual(C._capture_root_home(), Path(profile_home))


class SharedClientTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(C.set_transport_override, None)

    def test_not_connected(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(Path, "home", return_value=Path(tmp)), \
                mock.patch.object(C, "ROOT_HOME", Path(tmp) / "root"):
            with self.assertRaises(C.TrelloNotConnected):
                C.shared_client({"HERMES_HOME": str(Path(tmp) / "profile")})

    def test_each_credential_pair_keeps_its_own_client(self):
        C.set_transport_override(FakeTransport())
        env_a = {"TRELLO_API_KEY": "aaaaaaaa", "TRELLO_TOKEN": "bbbbbbbb"}
        env_b = {"TRELLO_API_KEY": "cccccccc", "TRELLO_TOKEN": "dddddddd"}
        a1, _ = C.shared_client(env_a)
        b1, _ = C.shared_client(env_b)
        a2, _ = C.shared_client(env_a)
        b2, _ = C.shared_client(env_b)
        self.assertIsNot(a1, b1)
        self.assertIs(a1, a2, "two profiles on different accounts do not evict each other")
        self.assertIs(b1, b2)

    def test_the_client_pool_is_bounded(self):
        C.set_transport_override(FakeTransport())
        for i in range(C._SHARED_MAX + 3):
            C.shared_client({"TRELLO_API_KEY": f"key-{i:05d}", "TRELLO_TOKEN": f"tok-{i:05d}"})
        self.assertEqual(len(C._shared), C._SHARED_MAX)

    def test_reused_until_credentials_change(self):
        C.set_transport_override(FakeTransport())
        env = {"TRELLO_API_KEY": "aaaaaaaa", "TRELLO_TOKEN": "bbbbbbbb"}
        first, source = C.shared_client(env)
        second, _ = C.shared_client(env)
        self.assertIs(first, second)
        self.assertEqual(source, "env")
        third, _ = C.shared_client({**env, "TRELLO_TOKEN": "cccccccc"})
        self.assertIsNot(first, third)


class SuiteSandboxTests(unittest.TestCase):
    """The guard above is load-bearing: keep it honest."""

    def test_the_suite_never_sees_the_real_home_or_pair(self):
        home = Path(os.environ["HOME"]).resolve()
        hermes_home = Path(os.environ["HERMES_HOME"]).resolve()
        # the redirect is a throwaway directory, not the real account's home
        self.assertTrue(home.is_dir(), home)
        self.assertNotEqual(home, Path.home().anchor)  # never '/'
        self.assertNotIn("trello-browser", str(home.parent.parent), "looks like a real profile home")
        self.assertEqual(hermes_home.parent, home)
        self.assertNotIn("TRELLO_API_KEY", os.environ)
        self.assertNotIn("TRELLO_TOKEN", os.environ)
        # nothing to resolve: an empty environ can never reach the real pair
        creds, source = C.resolve_credentials({})
        self.assertIsNone(creds)
        self.assertIsNone(source)


if __name__ == "__main__":
    unittest.main()
