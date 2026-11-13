"""`FakeNotionApplier`: the applier contract on a dict, for tests and local runs. No network.

`live` holds the value Notion would return for each `(page_id, field)`. The fake reads it, refuses
when it differs from the change's `old_value` (a conflict, nothing written), fails on request for
a page in `fail_on` and on a page it does not know, and otherwise writes the new value.
"""

from dataclasses import dataclass, field

from yawmi.notion.apply import ApplyResult
from yawmi.notion.changes import NotionChange

FAILED = "تعذّر الوصول إلى الصفحة"
NO_PAGE = "الصفحة غير موجودة"


@dataclass
class FakeNotionApplier:
    live: dict[tuple[str, str], object] = field(default_factory=dict)
    calls: list[NotionChange] = field(default_factory=list)
    fail_on: set[str] = field(default_factory=set)

    async def apply(self, change: NotionChange) -> ApplyResult:
        self.calls.append(change)
        key = (change.page_id, change.field)
        if change.page_id in self.fail_on:
            return ApplyResult(ok=False, error=FAILED)
        if key not in self.live:
            return ApplyResult(ok=False, error=NO_PAGE)
        if self.live[key] != change.old_value:
            return ApplyResult(ok=False, conflict=True)
        self.live[key] = change.new_value
        return ApplyResult(ok=True)
