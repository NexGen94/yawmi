"""The Notion port for an outside applier (design §7.1 and §11): `GET /v1/notion/changes` and
`POST /v1/notion/changes/{change_id}/result`, with the service token only.

The applier (a later, owner-approved workflow that holds the Notion credential, never this
service) reads the pending changes oldest first, writes each one only if the live value is the
change's `old_value`, and reports back: `ok` (applied, `applied_at` is now), `conflict` (the live
value differed: nothing was written) or a failure with its error. Only a pending change takes a
result, so a result for one cancelled or superseded meanwhile is a 409.
"""

from typing import Annotated, Any, Self
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator
from pydantic_core import PydanticCustomError

from yawmi.auth.deps import require_kind
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED, ErrorDetail
from yawmi.events import models as event_models
from yawmi.goals.deps import EditStoreDep
from yawmi.notion.apply import APPLIER_ERROR
from yawmi.notion.changes import NotionChangeList, change_of
from yawmi.text import StorableText

CHANGE_NOT_FOUND = "التغيير غير موجود"
NOT_PENDING = "التغيير ليس معلّقاً"
INCONSISTENT = "نتيجة ناجحة لا تكون تعارضاً"

RESULT_RESPONSES: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorDetail, "description": CHANGE_NOT_FOUND},
    409: {"model": ErrorDetail, "description": NOT_PENDING},
}


class ChangeResult(BaseModel):
    """`ok: true` applied; `ok: false` with `conflict: true` refused on a live mismatch; `ok:
    false` alone a failure, `error` its text (up to 500 characters)."""

    model_config = ConfigDict(extra="forbid")

    ok: StrictBool
    conflict: StrictBool = False
    error: Annotated[StorableText, Field(max_length=500)] | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.ok and self.conflict:
            raise PydanticCustomError("result_inconsistent", INCONSISTENT)
        return self


router = APIRouter(
    prefix="/v1/notion/changes",
    tags=["notion"],
    dependencies=[Depends(require_kind("service"))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


@router.get(
    "",
    summary="التغييرات المعلّقة لمطبّق Notion (رمز الخدمة فقط)",
    description=(
        "المعلّق بترتيب إنشائه، و`limit` من 1 إلى 100. `old_value` القيمة المتوقعة في Notion: "
        "يقرأ المطبّق القيمة الحية، وإن خالفتها لا يكتب ويرسل `conflict`."
    ),
    responses={**INVALID},
)
async def list_changes(
    edits: EditStoreDep,
    limit: Annotated[int, Query(ge=1, le=100, description="أقصى عدد")] = 20,
) -> NotionChangeList:
    return NotionChangeList(items=[change_of(e) for e in await edits.pending(limit)])


@router.post(
    "/{change_id}/result",
    status_code=204,
    summary="نتيجة تطبيق تغيير (رمز الخدمة فقط)",
    description=(
        "`ok: true` يجعله `applied` ويملأ `applied_at`، و`ok: false` مع `conflict: true` يجعله "
        "`conflict`، و`ok: false` وحده `failed` بنص `error`. غير موجود 404، وغير معلّق 409."
    ),
    responses={**RESULT_RESPONSES, **INVALID},
)
async def post_result(change_id: UUID, body: ChangeResult, edits: EditStoreDep) -> Response:
    if body.ok:
        done = await edits.finish(change_id, "applied", event_models.server_now(), None)
    elif body.conflict:
        done = await edits.finish(change_id, "conflict", None, None)
    else:
        done = await edits.finish(change_id, "failed", None, body.error or APPLIER_ERROR)
    if done is None:
        if await edits.get(change_id) is None:
            raise HTTPException(status_code=404, detail=CHANGE_NOT_FOUND)
        raise HTTPException(status_code=409, detail=NOT_PENDING)
    return Response(status_code=204)
