"""The applier port and the apply loop (design §11).

`NotionApplier` writes one property of one page. Its contract: read the live value, and if it is
not `change.old_value`, write nothing and return `ApplyResult(ok=False, conflict=True)`. So an
edit made against a value that changed in Notion since is never written over it silently.

`apply_pending` runs the pending edits oldest first. Before calling the applier it makes a cheap
check on the base value (the latest applied value while the mirror has not caught up, else the
mirror's): if that already differs from the edit's `old_value`, the edit is a `conflict` and the
applier is not called. The live check stays the applier's, since the mirror lags behind Notion.

Only a pending edit takes a result: one cancelled or superseded during the call keeps its state.
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from yawmi.goals.edits_store import EditStore
from yawmi.goals.reader import GoalsReader
from yawmi.notion.changes import GoalEditOut, NotionChange, base_value, change_of

log = logging.getLogger(__name__)

APPLIER_ERROR = "تعذّر التطبيق"


@dataclass(frozen=True)
class ApplyResult:
    ok: bool
    conflict: bool = False
    error: str | None = None


class NotionApplier(Protocol):
    async def apply(self, change: NotionChange) -> ApplyResult:
        """Write `change.new_value` iff the live value is `change.old_value` (else a conflict)."""
        ...


@dataclass(frozen=True)
class ApplySummary:
    applied: int
    failed: int
    conflicts: int


async def _mirror_fields(mirror: GoalsReader) -> Mapping[tuple[str, str], tuple[object, object]]:
    """`(target_kind, page_id)` to `(row, notion_edited_at)` for every mirror row."""
    out: dict[tuple[str, str], tuple[object, object]] = {}
    for m in await mirror.milestones():
        out[("milestone", m.page_id)] = (m, m.notion_edited_at)
    for c in await mirror.cards():
        out[("card", c.page_id)] = (c, c.notion_edited_at)
    return out


async def _call(applier: NotionApplier, edit: GoalEditOut) -> ApplyResult:
    try:
        return await applier.apply(change_of(edit))
    except Exception as exc:  # noqa: BLE001  # one failing edit must not stop the others
        log.warning("applier failed on edit %s: %s", edit.id, type(exc).__name__)
        return ApplyResult(ok=False, error=APPLIER_ERROR)


async def apply_pending(
    edits: EditStore,
    mirror: GoalsReader,
    applier: NotionApplier,
    now: datetime,
    limit: int = 20,
) -> ApplySummary:
    """Apply up to `limit` pending edits in creation order and record each result."""
    pending = await edits.pending(limit)
    if not pending:
        return ApplySummary(0, 0, 0)
    rows = await _mirror_fields(mirror)
    history = await edits.current()
    applied = failed = conflicts = 0
    for edit in pending:
        row, edited_at = rows.get((edit.target_kind, edit.page_id), (None, None))
        mine = [e for e in history if (e.page_id, e.field) == (edit.page_id, edit.field)]
        base = base_value(
            getattr(row, edit.field, None) if row is not None else None,
            edited_at,  # type: ignore[arg-type]
            mine,
        )
        if base != edit.old_value:
            if await edits.finish(edit.id, "conflict", None, None) is not None:
                conflicts += 1
            continue
        result = await _call(applier, edit)
        if result.ok:
            done = await edits.finish(edit.id, "applied", now, None)
            if done is not None:
                applied += 1
                history.append(done)
        elif result.conflict:
            if await edits.finish(edit.id, "conflict", None, None) is not None:
                conflicts += 1
        elif await edits.finish(edit.id, "failed", None, result.error or APPLIER_ERROR) is not None:
            failed += 1
    return ApplySummary(applied=applied, failed=failed, conflicts=conflicts)
