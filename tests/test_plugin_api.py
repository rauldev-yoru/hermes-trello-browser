"""Tests for dashboard/plugin_api.py through FastAPI's TestClient. No network."""

import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_trello_client import (  # noqa: E402 - shared fixtures live next to the client tests
    BOARD, CARD_1, CHECKLIST, ITEM_1, KEY, LIST_A, LIST_B, TOKEN,
    C, FakeTransport, board_routes, oid, raw_card, resp,
)

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError:  # pragma: no cover - the dashboard venv always has both
    FastAPI = None

ROOT = Path(__file__).resolve().parents[1]
ERROR_KEYS = {"error", "message", "retry_after"}


def load_plugin_api():
    name = "hermes_dashboard_plugin_trello-browser"
    spec = importlib.util.spec_from_file_location(name, ROOT / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # the dashboard registers it before exec as well
    spec.loader.exec_module(module)
    return module


@unittest.skipIf(FastAPI is None, "fastapi / httpx not installed")
class PluginApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.home = base / "home"
        self.hermes = base / "profile"
        self.home.mkdir()
        self.hermes.mkdir()
        # Isolate from any real credential on the machine running the suite.
        patcher = mock.patch.object(Path, "home", return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {"HERMES_HOME": str(self.hermes)})
        env.start()
        self.addCleanup(env.stop)
        for var in ("TRELLO_API_KEY", "TRELLO_TOKEN"):
            os.environ.pop(var, None)

        self.api = load_plugin_api()
        self.transport = FakeTransport(board_routes())
        C.set_transport_override(self.transport)
        self.addCleanup(C.set_transport_override, None)

        app = FastAPI()
        app.include_router(self.api.router, prefix="/api/plugins/trello-browser")
        self.http = TestClient(app, raise_server_exceptions=False)
        self.base = "/api/plugins/trello-browser"

    # -- helpers -----------------------------------------------------------

    def connect_env(self):
        os.environ["TRELLO_API_KEY"] = KEY
        os.environ["TRELLO_TOKEN"] = TOKEN

    def get(self, path, **kw):
        return self.http.get(self.base + path, **kw)

    def assert_error(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        body = response.json()
        self.assertEqual(set(body), ERROR_KEYS)
        self.assertEqual(body["error"], code)
        self.assertNotIn("Traceback", response.text)
        self.assertNotIn(TOKEN, response.text)
        return body

    # -- health / credentials ----------------------------------------------

    def test_health_not_connected(self):
        response = self.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"connected": False, "member": None, "source": None})

    def test_health_connected(self):
        self.connect_env()
        self.transport.routes[("GET", "/1/members/me")] = resp(
            {"id": oid(20), "username": "ada", "fullName": "Ada Demo", "initials": "AD"}
        )
        body = self.get("/health").json()
        self.assertEqual(
            body,
            {"connected": True, "member": {"id": oid(20), "username": "ada", "full_name": "Ada Demo"}, "source": "env"},
        )

    def test_health_with_rejected_credentials(self):
        self.connect_env()
        self.transport.routes[("GET", "/1/members/me")] = resp(raw=b"invalid token", status=401)
        response = self.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["connected"], False)
        self.assertEqual(response.json()["error"], "credentials_rejected")

    def test_credentials_state_never_leaks(self):
        self.connect_env()
        response = self.get("/credentials")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["configured"], True)
        self.assertEqual(response.json()["source"], "env")
        self.assertNotIn(TOKEN, response.text)
        self.assertNotIn(KEY, response.text)

    def test_post_credentials_validates_then_writes_private_file(self):
        self.transport.routes[("GET", "/1/members/me")] = resp({"id": oid(20), "username": "ada", "fullName": "Ada Demo"})
        response = self.http.post(self.base + "/credentials", json={"api_key": KEY, "token": TOKEN})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["member"]["username"], "ada")
        self.assertEqual(response.json()["source"], "file")
        self.assertNotIn(TOKEN, response.text)
        path = self.hermes / "trello-browser" / "credentials.json"
        self.assertEqual(json.loads(path.read_text()), {"api_key": KEY, "token": TOKEN})
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        # the validation call used the submitted pair
        self.assertEqual(self.transport.calls[0][2]["token"], TOKEN)
        # stored credentials are now live for ordinary routes
        self.assertEqual(self.get("/boards/%s/view" % BOARD).status_code, 200)

    def test_post_credentials_rejected_writes_nothing(self):
        self.transport.routes[("GET", "/1/members/me")] = resp(raw=b"invalid token", status=401)
        response = self.http.post(self.base + "/credentials", json={"api_key": KEY, "token": TOKEN})
        self.assert_error(response, 401, "credentials_rejected")
        self.assertFalse((self.hermes / "trello-browser").exists())

    def test_post_credentials_bad_shape(self):
        response = self.http.post(self.base + "/credentials", json={"api_key": "x", "token": TOKEN})
        self.assert_error(response, 400, "bad_request")
        response = self.http.post(self.base + "/credentials", json={"api_key": KEY})
        self.assert_error(response, 422, "invalid_request")
        response = self.http.post(self.base + "/credentials", json={"api_key": KEY, "token": TOKEN, "extra": 1})
        self.assert_error(response, 422, "invalid_request")
        self.assertEqual(self.transport.calls, [])

    def test_delete_credentials(self):
        C.save_credentials(KEY, TOKEN)
        response = self.http.delete(self.base + "/credentials")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")
        self.assertFalse((self.hermes / "trello-browser" / "credentials.json").exists())
        self.assertEqual(self.http.delete(self.base + "/credentials").status_code, 204)

    # -- reads --------------------------------------------------------------

    def test_requires_connection(self):
        for path in ("/boards", f"/boards/{BOARD}/view", f"/cards/{CARD_1}", f"/cards/{CARD_1}/attachments"):
            self.assert_error(self.get(path), 424, "not_connected")

    def test_boards(self):
        self.connect_env()
        self.transport.routes[("GET", "/1/members/me/boards")] = resp(
            [{"id": BOARD, "name": "Demo", "url": "https://trello.com/b/Demo1234", "closed": False, "starred": True}]
        )
        self.assertEqual(
            self.get("/boards").json(),
            [{"id": BOARD, "name": "Demo", "url": "https://trello.com/b/Demo1234", "closed": False, "starred": True}],
        )

    def test_board_view(self):
        self.connect_env()
        body = self.get(f"/boards/{BOARD}/view").json()
        self.assertEqual(set(body), {"board", "lists", "cards", "members", "labels"})
        self.assertEqual(len(body["cards"]), 2)
        self.assertEqual(self.transport.count(), 5)

    def test_cards_page(self):
        self.connect_env()
        self.transport.routes[("GET", f"/1/boards/{BOARD}/cards")] = resp([raw_card(10)])
        body = self.get(f"/boards/{BOARD}/cards", params={"before": "2026-12-01T00:00:00Z"}).json()
        self.assertEqual(body["next_before"], None)
        self.assertEqual(body["cards"][0]["id"], CARD_1)
        self.assert_error(self.get(f"/boards/{BOARD}/cards", params={"before": "soon"}), 400, "bad_request")

    def test_card_detail_and_attachments(self):
        self.connect_env()
        card = raw_card(10)
        card.update(desc="Body", checklists=[], attachments=[])
        self.transport.routes[("GET", f"/1/cards/{CARD_1}")] = resp(card)
        self.transport.routes[("GET", f"/1/cards/{CARD_1}/actions")] = resp([])
        self.transport.routes[("GET", f"/1/cards/{CARD_1}/attachments")] = resp(
            [{"id": oid(50), "name": "a", "url": "https://example.invalid/a", "bytes": 5, "mimeType": "text/plain", "isUpload": False}]
        )
        self.assertEqual(self.get(f"/cards/{CARD_1}").json()["desc"], "Body")
        self.assertEqual(
            self.get(f"/cards/{CARD_1}/attachments").json(),
            [{"id": oid(50), "name": "a", "url": "https://example.invalid/a", "is_upload": False, "bytes": 5, "mime": "text/plain"}],
        )

    # -- writes -------------------------------------------------------------

    def test_create_and_patch_card(self):
        self.connect_env()
        self.transport.routes[("POST", "/1/cards")] = resp(raw_card(12, LIST_A, name="Fresh"))
        self.transport.routes[("PUT", f"/1/cards/{CARD_1}")] = resp(raw_card(10, LIST_B))
        created = self.http.post(self.base + "/cards", json={"list_id": LIST_A, "name": "Fresh", "due": "2026-12-01"})
        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(created.json()["name"], "Fresh")
        patched = self.http.patch(
            self.base + f"/cards/{CARD_1}", json={"id_list": LIST_B, "due": None, "closed": False, "id_labels": []}
        )
        self.assertEqual(patched.status_code, 200, patched.text)
        params = self.transport.calls[-1][2]
        self.assertEqual((params["idList"], params["due"], params["closed"]), (LIST_B, "null", "false"))
        self.assertNotIn("name", params, "unset fields must not be sent")

    def test_patch_rejects_unknown_and_empty(self):
        self.connect_env()
        self.assert_error(self.http.patch(self.base + f"/cards/{CARD_1}", json={"bogus": 1}), 422, "invalid_request")
        self.assert_error(self.http.patch(self.base + f"/cards/{CARD_1}", json={}), 400, "bad_request")
        self.assertEqual(self.transport.calls, [])

    def test_comment_and_checklist_routes(self):
        self.connect_env()
        t = self.transport.routes
        t[("POST", f"/1/cards/{CARD_1}/actions/comments")] = resp(
            {"id": oid(61), "date": "2026-10-22T00:00:00.000Z", "data": {"text": "hello"}, "memberCreator": {"username": "ada"}}
        )
        t[("POST", f"/1/cards/{CARD_1}/checklists")] = resp({"id": CHECKLIST, "name": "Plan", "idCard": CARD_1})
        t[("POST", f"/1/checklists/{CHECKLIST}/checkItems")] = resp({"id": ITEM_1, "name": "Step", "state": "incomplete"})
        t[("PUT", f"/1/cards/{CARD_1}/checkItem/{ITEM_1}")] = resp({"id": ITEM_1, "name": "Step", "state": "complete"})
        t[("DELETE", f"/1/checklists/{CHECKLIST}/checkItems/{ITEM_1}")] = resp({})
        self.assertEqual(self.http.post(self.base + f"/cards/{CARD_1}/comments", json={"text": "hello"}).status_code, 201)
        made = self.http.post(self.base + f"/cards/{CARD_1}/checklists", json={"name": "Plan"})
        self.assertEqual(made.json(), {"id": CHECKLIST, "name": "Plan", "items": []})
        added = self.http.post(self.base + f"/checklists/{CHECKLIST}/items", json={"name": "Step"})
        self.assertEqual(added.json()["id"], ITEM_1)
        item = self.http.patch(self.base + f"/checklists/{CHECKLIST}/items/{ITEM_1}", json={"state": "complete"})
        self.assertEqual(item.json()["state"], "complete")
        gone = self.http.delete(self.base + f"/checklists/{CHECKLIST}/items/{ITEM_1}")
        self.assertEqual((gone.status_code, gone.content), (204, b""))
        bad = self.http.patch(self.base + f"/checklists/{CHECKLIST}/items/{ITEM_1}", json={"state": "done"})
        self.assert_error(bad, 400, "bad_request")

    # -- error mapping ------------------------------------------------------

    def test_invalid_ids_are_400(self):
        self.connect_env()
        self.assert_error(self.get("/cards/not-an-id"), 400, "bad_request")
        self.assert_error(self.get("/boards/..%20x/view"), 400, "bad_request")
        self.assertEqual(self.get("/boards/..%2f..%2fetc/view").status_code, 404)  # never routed
        self.assertEqual(self.transport.calls, [])

    def test_upstream_errors_map_to_contract(self):
        self.connect_env()
        path = ("GET", f"/1/cards/{CARD_1}/attachments")
        cases = [
            (resp(raw=b"invalid token", status=401), 401, "credentials_rejected"),
            (resp(raw=b"nope", status=404), 404, "not_found"),
            (resp(raw=b"oops", status=500), 503, "trello_unavailable"),
        ]
        for response, status, code in cases:
            self.transport.routes[path] = response
            self.assert_error(self.get(f"/cards/{CARD_1}/attachments"), status, code)

    def test_rate_limited_carries_retry_after(self):
        self.connect_env()
        self.transport.routes[("GET", f"/1/cards/{CARD_1}/attachments")] = resp(
            raw=b"", status=429, headers={"Retry-After": "30"}
        )
        response = self.get(f"/cards/{CARD_1}/attachments")
        body = self.assert_error(response, 429, "rate_limited")
        self.assertEqual(body["retry_after"], 30)
        self.assertEqual(response.headers.get("retry-after"), "30")

    def test_unexpected_exception_hides_internals(self):
        self.connect_env()

        def explode(url, method, params):
            raise RuntimeError(f"secret detail {TOKEN}")

        C.set_transport_override(explode)
        with self.assertLogs("hermes_trello_browser", level="ERROR") as logs:
            response = self.get(f"/cards/{CARD_1}/attachments")
        self.assertNotIn(TOKEN, "\n".join(logs.output))
        body = self.assert_error(response, 500, "internal_error")
        self.assertNotIn("secret detail", response.text)
        self.assertIsNone(body["retry_after"])

    def test_routes_are_synchronous_and_unauthenticated_by_the_plugin(self):
        import inspect

        for route in self.api.router.routes:
            self.assertFalse(inspect.iscoroutinefunction(route.endpoint), route.path)
            self.assertEqual(route.dependant.dependencies, [], f"{route.path} must not add auth")


if __name__ == "__main__":
    unittest.main()
