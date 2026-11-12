"""`GET /v1/settings` and `PATCH /v1/settings`: user preferences and settings."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from yawmi.auth.deps import USER_KINDS, require_kind
from yawmi.db.pool import get_pool
from yawmi.errors import FORBIDDEN, INVALID, UNAUTHORIZED
from yawmi.prefs.models import SettingsOut, SettingsPatch
from yawmi.prefs.store import AsyncpgPrefsStore, PrefsStore

router = APIRouter(
    prefix="/v1",
    tags=["settings"],
    dependencies=[Depends(require_kind(*USER_KINDS))],
    responses={**UNAUTHORIZED, **FORBIDDEN},
)


def get_prefs_store(request: Request) -> PrefsStore:
    """The store injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: PrefsStore | None = getattr(request.app.state, "prefs", None)
    return injected if injected is not None else AsyncpgPrefsStore(get_pool())


PrefsDep = Annotated[PrefsStore, Depends(get_prefs_store)]


@router.get(
    "/settings",
    summary="إعدادات المستخدم",
    response_model=SettingsOut,
)
async def get_settings(store: PrefsDep) -> SettingsOut:
    return await store.get()


@router.patch(
    "/settings",
    summary="تعديل إعدادات المستخدم",
    description=(
        "تتغيّر المفاتيح المرسَلة وحدها. و`null` مقبول لـ`focus_daily_target_min` و"
        "`breath_weekly_target_min` و`breath_prefs` وخانات `day_reminders` فقط. "
        "والكائن المتداخل (`day_reminders` و`goal_columns` و`breath_prefs`) يستبدل المخزَّن كله: "
        "ما يُترك منه يعود إلى افتراضه."
    ),
    response_model=SettingsOut,
    responses={**INVALID},
)
async def patch_settings(patch: SettingsPatch, store: PrefsDep) -> SettingsOut:
    return await store.patch(patch.model_dump(exclude_unset=True))
