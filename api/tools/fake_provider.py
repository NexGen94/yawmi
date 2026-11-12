"""A fixed-reply insight provider for the local end-to-end suite. Never used in production.

It has the `Provider` protocol of `yawmi.ai.base` (`complete(system, user, schema, model)`), so the
test server can inject `InsightService(FakeProvider(), settings)` into `app.state.insights` and
`POST /v1/day/close` answers without a network call or a key. This folder is not in the container
image, and nothing under `yawmi/` imports it. (The scripted provider of `tests/test_ai.py` is a
test double with its own purpose and is not imported from a tool.)
"""

import json
from typing import Any

# Two fixed lines: what the closure shows. Nouns and numbers only, no praise or blame.
LINES = ("ملخص تجريبي لليوم.", "هذا رد ثابت من مزوّد وهمي للاختبار.")


class FakeProvider:
    """Replies with `LINES` and cites the first source of the request, if there is one."""

    async def complete(self, system: str, user: str, schema: dict, model: str) -> dict:
        return {
            "lines": list(LINES),
            "question": None,
            "source_ids": _first_source_ids(user),
            "priorities": [],
        }


def _first_source_ids(user: str) -> list[str]:
    """The id of the first source in the request payload (a repair note may follow it)."""
    payload: Any
    try:
        payload = json.loads(user.split("\n\n", 1)[0])
    except ValueError:
        return []
    sources = payload.get("sources") if isinstance(payload, dict) else None
    if not isinstance(sources, list) or not sources:
        return []
    first = sources[0]
    source_id = first.get("id") if isinstance(first, dict) else None
    return [source_id] if isinstance(source_id, str) else []
