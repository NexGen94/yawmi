"""Goal tasks: `GET`/`POST /v1/goals/{ref}/tasks` and `PATCH /v1/goal-tasks/{task_id}` (design §7.1).

A task is a line the user writes under a goal (design §13.1, ruling 2): it is not a Notion page
and nothing is written to Notion. `ref` is an outcome code (`O1` to `O12`, valid even while the
mirror is empty) or the page id of a card or milestone in the mirror; anything else is a 404.
There is no deletion: `archived` closes a task. A direct `done` edit writes `done_at` and the
instant that decides against queued `goal_task_set` events (see `yawmi.goals.tasks_store`).
"""

import re
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path
from fastapi.exceptions import RequestValidationError

from yawmi.auth.deps import USER_KINDS, require_kind
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ErrorDetail
from yawmi.events import models as event_models
from yawmi.goals.deps import GoalsReaderDep, TaskStoreDep
from yawmi.goals.models import GoalTaskIn, GoalTaskList, GoalTaskOut, GoalTaskPatch
from yawmi.goals.reader import GoalsReader
from yawmi.text import is_storable

REF_NOT_FOUND = "لا مخرج ولا بطاقة ولا محطة بهذا المعرّف"
TASK_NOT_FOUND = "المهمة غير موجودة"
EMPTY_PATCH = "لا حقل للتعديل"

_OUTCOME_CODE = re.compile(r"O([1-9]|1[0-2])")

NOT_FOUND_REF: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorDetail, "description": REF_NOT_FOUND},
}
NOT_FOUND_TASK: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorDetail, "description": TASK_NOT_FOUND},
}

router = APIRouter(
    prefix="/v1",
    tags=["goals"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)

Ref = Annotated[str, Path(max_length=128, description="رمز مخرج أو معرّف بطاقة أو محطة")]


async def _require_ref(goals: GoalsReader, ref: str) -> None:
    """404 unless `ref` is an outcome code or a card or milestone page id of the mirror."""
    if not is_storable(ref):
        raise HTTPException(status_code=404, detail=REF_NOT_FOUND)
    if _OUTCOME_CODE.fullmatch(ref):
        return
    if any(c.page_id == ref for c in await goals.cards()) or any(
        m.page_id == ref for m in await goals.milestones()
    ):
        return
    raise HTTPException(status_code=404, detail=REF_NOT_FOUND)


@router.get(
    "/goals/{ref}/tasks",
    summary="مهام هدف",
    description="غير المؤرشفة بترتيب الموضع. `ref` رمز مخرج أو معرّف بطاقة أو محطة، وإلا 404.",
    responses={**NOT_FOUND_REF, **INVALID},
)
async def list_tasks(ref: Ref, goals: GoalsReaderDep, tasks: TaskStoreDep) -> GoalTaskList:
    await _require_ref(goals, ref)
    return GoalTaskList(items=await tasks.list(ref))


@router.post(
    "/goals/{ref}/tasks",
    status_code=201,
    summary="إضافة مهمة إلى هدف",
    description="مهمة مفتوحة بعد آخر مهام الهدف. لا تُكتب في Notion.",
    responses={**NOT_FOUND_REF, **INVALID},
)
async def create_task(
    ref: Ref, body: GoalTaskIn, goals: GoalsReaderDep, tasks: TaskStoreDep
) -> GoalTaskOut:
    await _require_ref(goals, ref)
    return await tasks.create(ref, body.title, body.due_day, event_models.server_now())


@router.patch(
    "/goal-tasks/{task_id}",
    summary="تعديل مهمة أو إنجازها أو أرشفتها",
    description=(
        "حقل واحد على الأقل. `done` يكتب `done_at` ويحسم أمام أحداث `goal_task_set` الأقدم منه. "
        "`due_day: null` يمسح الموعد. لا حذف: الإغلاق بـ`archived`، ويخرج بها من المجاميع."
    ),
    responses={**NOT_FOUND_TASK, **INVALID},
)
async def patch_task(task_id: UUID, body: GoalTaskPatch, tasks: TaskStoreDep) -> GoalTaskOut:
    changes = body.model_dump(include=body.model_fields_set)
    if not changes:
        raise RequestValidationError(
            [{"loc": ("body",), "type": "empty_patch", "msg": EMPTY_PATCH}]
        )
    task = await tasks.patch(task_id, changes, event_models.server_now())
    if task is None:
        raise HTTPException(status_code=404, detail=TASK_NOT_FOUND)
    return task
