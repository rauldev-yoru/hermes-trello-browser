#!/usr/bin/env python3
"""Seed a board with synthetic demo content (lists, labels, cards, checklists, comments).

Useful for local development, screenshots and live smoke tests. Everything it
creates is fake: no real project, client or person is referenced.

    export TRELLO_API_KEY=... TRELLO_TOKEN=...
    python3 scripts/seed_demo_board.py --create-board "Trello Browser Demo"
    python3 scripts/seed_demo_board.py --board <board_id>
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

BASE = "https://api.trello.com/1"

LABELS = [("bug", "red"), ("onboarding", "blue"), ("copy", "yellow"),
          ("design", "purple"), ("a11y", "green")]

CARDS = [
    ("Onboarding — step 2 has no way out when cancelling", "In progress", ["bug", "onboarding"], 0,
     "Pressing **Cancel** on step 2 closes the modal but leaves the session half-done.\n\n"
     "Reproducible on Safari; on Chrome only after navigating back.",
     [("QA", ["Reproduce on Safari", "Inspect the cancel handler",
              "Reset the session state", "Add a regression test"], 2)],
     ["Still failing on build 3.4", "Looking into it today"]),
    ("Search empty state has no copy", "In progress", ["copy"], 3,
     "The no-results screen has neither text nor a suggested action.",
     [("Copy", ["Write the proposal", "Design review", "Ship it"], 3)], []),
    ("Export the report to CSV", "Backlog", ["design"], None,
     "Users want to download the monthly report from the orders table.",
     [], ["Columns and encoding still undefined"]),
    ("Migrate tooltips to the new component", "In progress", ["design", "copy"], 7,
     "14 tooltips still use the old implementation.",
     [("Migration", ["Inventory usages", "Table", "Forms", "Delete the old one"], 0)], []),
    ("AA contrast on the secondary button", "Review", ["a11y"], None,
     "The secondary button border does not reach 3:1 against the elevated surface.",
     [], ["Measured 2.4:1", "Proposal: bump the stroke one step"]),
    ("Unify date formatting", "Done", [], -2,
     "Every date in the app uses the same formatter and timezone.",
     [("Wrap-up", ["Shared formatter", "Migrate views", "Tests"], 3)], ["Shipped in build 3.4"]),
]


def make_caller(api_key, token):
    def call(method: str, path: str, **params) -> dict:
        url = f"{BASE}{path}?" + urllib.parse.urlencode({"key": api_key, "token": token})
        data = None
        if method != "GET":
            data = json.dumps(params).encode()
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json",
                                              "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read()
        return json.loads(body) if body else {}

    return call


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--board", help="existing (empty) board id to seed")
    ap.add_argument("--create-board", metavar="NAME", help="create a board first")
    args = ap.parse_args()

    key = os.environ.get("TRELLO_API_KEY", "").strip()
    token = os.environ.get("TRELLO_TOKEN", "").strip()
    if not key or not token:
        print("TRELLO_API_KEY and TRELLO_TOKEN must be set", file=sys.stderr)
        return 2
    if not args.board and not args.create_board:
        print("pass --board <id> or --create-board <name>", file=sys.stderr)
        return 2

    call = make_caller(key, token)
    board = args.board
    if args.create_board:
        board = call("POST", "/boards", name=args.create_board, defaultLists="false")["id"]
        print(f"board: {board} ({args.create_board})")

    labels = {}
    for name, color in LABELS:
        labels[name] = call("POST", f"/boards/{board}/labels", name=name, color=color)["id"]

    lists = {}
    for name in ["Backlog", "In progress", "Review", "Done"]:
        lists[name] = call("POST", "/lists", idBoard=board, name=name, pos="bottom")["id"]

    stamp = time.time()
    for name, list_name, lbls, due_offset, desc, checklists, comments in CARDS:
        payload = {"idList": lists[list_name], "name": name, "desc": desc}
        if due_offset is not None:
            payload["due"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z",
                                           time.gmtime(stamp + due_offset * 86400))
        if lbls:
            payload["idLabels"] = ",".join(labels[x] for x in lbls)
        card = call("POST", "/cards", **payload)
        for cl_name, items, done in checklists:
            cl = call("POST", f"/cards/{card['id']}/checklists", name=cl_name)
            for i, item in enumerate(items):
                ci = call("POST", f"/checklists/{cl['id']}/checkItems", name=item)
                if i < done:
                    call("PUT", f"/cards/{card['id']}/checkItem/{ci['id']}", state="complete")
        for text in comments:
            call("POST", f"/cards/{card['id']}/actions/comments", text=text)
        print(f"  {card['shortLink']}  [{list_name}]  {name}")
        time.sleep(0.15)

    print(f"done: 4 lists, {len(labels)} labels, {len(CARDS)} cards on board {board}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
