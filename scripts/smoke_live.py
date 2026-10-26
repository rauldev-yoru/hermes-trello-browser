#!/usr/bin/env python3
"""Live smoke test: run the plugin's client against a real Trello board.

Creates one card, comments on it, adds a checklist item, moves it and archives
it again — so it leaves nothing behind but an archived card.

    export TRELLO_API_KEY=... TRELLO_TOKEN=...
    python3 scripts/smoke_live.py --board <board_id>
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "trello_api_client", ROOT / "dashboard" / "trello_api_client.py")
assert spec and spec.loader
client_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_mod)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--board", required=True, help="board id to smoke against")
    args = ap.parse_args()

    credentials, source = client_mod.resolve_credentials()
    if credentials is None:
        print("no credentials: set TRELLO_API_KEY / TRELLO_TOKEN", file=sys.stderr)
        return 2
    print(f"credentials: source={source}")

    client = client_mod.TrelloClient(credentials)

    t = time.monotonic()
    me = client.member()
    print(f"member: {me['username']}  ({(time.monotonic() - t) * 1000:.0f} ms)")

    t = time.monotonic()
    view = client.board_view(args.board)
    print(f"view cold: {len(view['lists'])} lists, {len(view['cards'])} cards "
          f"({(time.monotonic() - t) * 1000:.0f} ms)")
    t = time.monotonic()
    client.board_view(args.board)
    print(f"view warm: {(time.monotonic() - t) * 1000:.0f} ms")

    if not view["lists"]:
        print("board has no lists; seed it first (scripts/seed_demo_board.py)", file=sys.stderr)
        return 1

    target = view["lists"][0]
    card = client.create_card(target["id"], "[smoke] created by smoke_live.py",
                              desc="Safe to archive: this card is created by the smoke test.")
    print(f"create: ok ({card['short_link']})")
    client.add_comment(card["id"], "smoke comment")
    checklist = client.add_checklist(card["id"], "Smoke")
    item = client.add_checklist_item(checklist["id"], "step 1")
    client.set_checklist_item(checklist["id"], item["id"], state="complete", card_id=card["id"])
    print("comment + checklist item: ok")

    if len(view["lists"]) > 1:
        client.update_card(card["id"], id_list=view["lists"][1]["id"])
        print("move: ok")

    detail = client.card(card["id"])
    assert detail["card"]["closed"] is False
    assert len(detail["comments"]) == 1
    assert detail["checklists"][0]["items"][0]["state"] == "complete"
    print(f"re-read: comments={len(detail['comments'])} "
          f"items={[i['state'] for i in detail['checklists'][0]['items']]}")

    archived = client.update_card(card["id"], closed=True)
    print(f"archive: ok (closed={archived['closed']})")
    print("SMOKE OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
