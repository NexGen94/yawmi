"""A fixed-reply insight provider for the local end-to-end suite. Never used in production.

It has the `Provider` protocol of `yawmi.ai.base` (`complete(system, user, schema, model)`), so the
test server can inject `InsightService(FakeProvider(), settings)` into `app.state.insights` and
the AI routes answer without a network call or a key. This folder is not in the container image,
and nothing under `yawmi/` imports it. (The scripted provider of `tests/test_ai.py` is a test
double with its own purpose and is not imported from a tool.)

The reply keeps the rules each kind is checked for (design §10): a `deeper` reply carries one
question and three alternative questions, and a `weekly` reply cites two different `journal:*`
sources when the request holds two.
"""

import json
from typing import Any

# Two fixed lines: what the closure shows. Nouns and numbers only, no praise or blame.
LINES = ("ملخص تجريبي لليوم.", "هذا رد ثابت من مزوّد وهمي للاختبار.")
DEEPER_QUESTION = "ما الذي يستحق التأمل في هذا اليوم؟"
DEEPER_OPTIONS = (
    "ما الذي ساعد اليوم؟",
    "ما الذي عاق اليوم؟",
    "ما الخطوة التالية؟",
)
JOURNAL_PREFIX = "journal:"


class FakeProvider:
    """Replies with `LINES` and cites the first source of the request, if there is one."""

    async def complete(self, system: str, user: str, schema: dict, model: str) -> dict:
        del system, schema, model  # the reply is fixed; only the request payload matters
        payload = _payload(user)
        ids = _source_ids(payload)
        kind = payload.get("kind")
        if kind == "deeper":
            first = ids[:1]
            options = [{"title": t, "source_id": first[0]} for t in DEEPER_OPTIONS] if first else []
            return {
                "lines": [],
                "question": DEEPER_QUESTION,
                "source_ids": first,
                "priorities": options,
            }
        cited = ids[:1]
        if kind == "weekly":
            journals = [i for i in ids if i.startswith(JOURNAL_PREFIX)][:2]
            cited = list(dict.fromkeys([*cited, *journals]))
        return {"lines": list(LINES), "question": None, "source_ids": cited, "priorities": []}


def _payload(user: str) -> dict[str, Any]:
    """The request payload (a repair note may follow it); `{}` when it cannot be read."""
    try:
        payload = json.loads(user.split("\n\n", 1)[0])
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _source_ids(payload: dict[str, Any]) -> list[str]:
    sources = payload.get("sources")
    if not isinstance(sources, list):
        return []
    found = (s.get("id") for s in sources if isinstance(s, dict))
    return [i for i in found if isinstance(i, str)]
