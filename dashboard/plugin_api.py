"""FastAPI router for the Trello Browser pane.

Mounted by the dashboard under ``/api/plugins/trello-browser/``. It inherits the
dashboard's own authentication; nothing here adds or bypasses it. Every Trello
call is proxied through ``trello_api_client`` so the renderer never sees the API
key or the token.
"""

import importlib.util
import logging
import sys
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Body, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict

logger = logging.getLogger("hermes_trello_browser")

_CLIENT_MODULE = "trello_api_client"


def _load_client_module():
    """Load the sibling client file (the dashboard imports this file standalone)."""
    path = Path(__file__).resolve().parent / "trello_api_client.py"
    existing = sys.modules.get(_CLIENT_MODULE)
    if existing is not None and Path(getattr(existing, "__file__", "") or "").resolve() == path:
        return existing
    spec = importlib.util.spec_from_file_location(_CLIENT_MODULE, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[_CLIENT_MODULE] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(_CLIENT_MODULE, None)
        raise
    return module


C = _load_client_module()


# --------------------------------------------------------------------------
# Error mapping
# --------------------------------------------------------------------------


def _error(status, code, message, retry_after=None):
    headers = {"Retry-After": str(retry_after)} if retry_after else None
    return JSONResponse(
        status_code=status,
        content={"error": code, "message": message, "retry_after": retry_after},
        headers=headers,
    )


def _map_exception(exc):
    """Translate an exception into a JSON error response (no stack traces)."""
    if isinstance(exc, C.TrelloNotConnected):
        return _error(424, "not_connected", "Trello is not connected. Add your API key and token.")
    if isinstance(exc, C.TrelloAuthError):
        return _error(401, "credentials_rejected", "Trello rejected the stored API key or token.")
    if isinstance(exc, C.TrelloNotFound):
        return _error(404, "not_found", "That Trello item was not found or is out of reach.")
    if isinstance(exc, C.TrelloRateLimited):
        retry = getattr(exc, "retry_after", None)
        return _error(429, "rate_limited", "Trello is rate-limiting requests. Try again shortly.", retry)
    if isinstance(exc, C.TrelloUnavailable):
        return _error(503, "trello_unavailable", "Trello is unreachable right now.")
    if isinstance(exc, C.TrelloBadRequest):
        return _error(400, "bad_request", str(exc) or "Trello refused the request.")
    if isinstance(exc, ValueError):
        return _error(400, "bad_request", str(exc) or "Invalid request.")
    return None


class _TrelloRoute(APIRoute):
    """Route class that turns every failure into the plugin's JSON error shape."""

    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request):
            try:
                return await original(request)
            except RequestValidationError as exc:
                fields = sorted({".".join(str(p) for p in e.get("loc", ())[1:]) for e in exc.errors()})
                detail = ", ".join(f for f in fields if f) or "body"
                return _error(422, "invalid_request", f"Invalid request fields: {detail}.")
            except Exception as exc:  # noqa: BLE001 - mapped, never leaked
                mapped = _map_exception(exc)
                if mapped is not None:
                    return mapped
                logger.error("trello-browser: unexpected %s", type(exc).__name__)
                return _error(500, "internal_error", "Unexpected error in the Trello backend.")

        return handler


router = APIRouter(route_class=_TrelloRoute)


def _client():
    return C.shared_client()[0]


# --------------------------------------------------------------------------
# Request bodies
# --------------------------------------------------------------------------


class CredentialsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    api_key: str
    token: str


class CardCreateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    list_id: str
    name: str
    desc: Optional[str] = None
    due: Optional[str] = None


class CardPatchBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = None
    desc: Optional[str] = None
    due: Optional[str] = None
    id_list: Optional[str] = None
    closed: Optional[bool] = None
    id_labels: Optional[List[str]] = None


class CommentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str


class NameBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str


class ItemPatchBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Optional[str] = None
    name: Optional[str] = None


# --------------------------------------------------------------------------
# Status and credentials
# --------------------------------------------------------------------------


@router.get("/health")
def health():
    creds, source = C.resolve_credentials()
    if creds is None:
        return {"connected": False, "member": None, "source": None}
    try:
        member = C.shared_client()[0].member()
    except C.TrelloAuthError:
        return {"connected": False, "member": None, "source": source, "error": "credentials_rejected"}
    return {
        "connected": True,
        "member": {k: member[k] for k in ("id", "username", "full_name")},
        "source": source,
    }


@router.get("/credentials")
def credentials_state():
    return C.credentials_status()


@router.post("/credentials")
def credentials_save(body: CredentialsBody):
    C.validate_credential_values(body.api_key, body.token)
    candidate = C.TrelloClient(
        C.Credentials(body.api_key.strip(), body.token.strip()),
        transport=C._transport_override,
    )
    member = candidate.member()  # raises TrelloAuthError on bad credentials
    C.save_credentials(body.api_key, body.token)
    status = C.credentials_status()
    return {
        "connected": True,
        "member": {k: member[k] for k in ("id", "username", "full_name")},
        "source": status["source"],
        "shadowed_by_env": status["source"] == "env",
    }


@router.delete("/credentials", status_code=204, response_class=Response)
def credentials_delete():
    C.delete_credentials()
    return Response(status_code=204)


# --------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------


@router.get("/boards")
def boards():
    return _client().boards()


@router.get("/boards/{board_id}/view")
def board_view(board_id: str):
    return _client().board_view(board_id)


@router.get("/boards/{board_id}/cards")
def board_cards(board_id: str, before: Optional[str] = None):
    return _client().board_cards_page(board_id, before)


@router.get("/cards/{card_id}")
def card_detail(card_id: str):
    return _client().card(card_id)


@router.get("/cards/{card_id}/attachments")
def card_attachments(card_id: str):
    return _client().attachments(card_id)


# --------------------------------------------------------------------------
# Writes
# --------------------------------------------------------------------------


@router.post("/cards", status_code=201)
def card_create(body: CardCreateBody):
    return _client().create_card(body.list_id, body.name, body.desc, body.due)


@router.patch("/cards/{card_id}")
def card_patch(card_id: str, body: CardPatchBody = Body(...)):
    fields = body.model_dump(exclude_unset=True)
    return _client().update_card(card_id, **fields)


@router.post("/cards/{card_id}/comments", status_code=201)
def card_comment(card_id: str, body: CommentBody):
    return _client().add_comment(card_id, body.text)


@router.post("/cards/{card_id}/checklists", status_code=201)
def checklist_add(card_id: str, body: NameBody):
    return _client().add_checklist(card_id, body.name)


@router.post("/checklists/{checklist_id}/items", status_code=201)
def checklist_item_add(checklist_id: str, body: NameBody):
    return _client().add_checklist_item(checklist_id, body.name)


@router.patch("/checklists/{checklist_id}/items/{item_id}")
def checklist_item_patch(checklist_id: str, item_id: str, body: ItemPatchBody):
    fields = body.model_dump(exclude_unset=True)
    return _client().set_checklist_item(
        checklist_id, item_id, state=fields.get("state"), name=fields.get("name")
    )


@router.delete("/checklists/{checklist_id}/items/{item_id}", status_code=204, response_class=Response)
def checklist_item_delete(checklist_id: str, item_id: str):
    _client().delete_checklist_item(checklist_id, item_id)
    return Response(status_code=204)
