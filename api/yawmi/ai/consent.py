"""Consent to send data to the AI provider (design §10, §7.1, §7.6), and the gate on AI routes.

One row per provider in `yawmi.ai_consents`. A consent stands while `revoked_at` is null; a
withdrawal sets `revoked_at` (the row is never deleted), and a new consent for the same provider
clears it in the same row. The gate reads the consent of `settings.ai_provider`, so changing the
provider drops the consent with it. `personal_text` is the separate switch for «رسالتي» and
«رؤيتي» (and later the deep reason): off unless granted.

`require_consent` is a dependency of every route that calls a provider. It raises
`ConsentRequired`; a router built with `route_class=ConsentRoute` turns that into the module's
error body (`detail` plus `errors[0].type == "ai_consent_required"`), as `main.py` is never edited.
"""

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Protocol
from uuid import UUID

import asyncpg
from fastapi import Depends, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from yawmi.auth.deps import SettingsDep
from yawmi.db.pool import get_pool

AiProvider = Literal["anthropic", "deepseek"]

# Every user-visible message of this module (checked for gendered wording by the tests).
MSG_CONSENT_REQUIRED = "لا موافقة سارية على إرسال البيانات إلى مزوّد الذكاء الحالي"
MSG_PROVIDER_MISMATCH = "المزوّد المذكور ليس المزوّد الحالي"
CONSENT_REQUIRED = "ai_consent_required"
PROVIDER_MISMATCH = "provider_mismatch"


@dataclass(frozen=True)
class Consent:
    provider: str
    personal_text: bool
    granted_at: datetime
    revoked_at: datetime | None = None
    device_id: UUID | None = None

    @property
    def standing(self) -> bool:
        return self.revoked_at is None


class ConsentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: AiProvider = Field(description="المزوّد الحالي، وغيره 409 `provider_mismatch`")
    personal_text: StrictBool = Field(
        default=False, description="إرسال «رسالتي» و«رؤيتي» أيضاً، ومغلق افتراضاً"
    )


class ConsentOut(BaseModel):
    provider: AiProvider = Field(description="المزوّد الحالي")
    granted: bool = Field(description="موافقة سارية لهذا المزوّد")
    personal_text: bool = Field(description="«رسالتي» و«رؤيتي» مشمولتان")
    granted_at: datetime | None = Field(description="وقت الموافقة السارية، أو `null`")


def consent_out(provider: AiProvider, consent: Consent | None) -> ConsentOut:
    if consent is None or not consent.standing:
        return ConsentOut(provider=provider, granted=False, personal_text=False, granted_at=None)
    return ConsentOut(
        provider=provider,
        granted=True,
        personal_text=consent.personal_text,
        granted_at=consent.granted_at,
    )


class ConsentStore(Protocol):
    async def get(self, provider: str) -> Consent | None: ...

    async def grant(
        self, provider: str, personal_text: bool, device_id: UUID | None, now: datetime
    ) -> Consent:
        """Insert, or renew the provider's row in place (clearing `revoked_at`)."""
        ...

    async def revoke(self, provider: str, now: datetime) -> Consent | None:
        """Set `revoked_at` on a standing consent; the row stays."""
        ...


class InMemoryConsentStore:
    def __init__(self) -> None:
        self.rows: dict[str, Consent] = {}

    @staticmethod
    def granted(provider: str, now: datetime, personal_text: bool = False) -> Consent:
        return Consent(provider, personal_text, now)

    async def get(self, provider: str) -> Consent | None:
        return self.rows.get(provider)

    async def grant(
        self, provider: str, personal_text: bool, device_id: UUID | None, now: datetime
    ) -> Consent:
        self.rows[provider] = Consent(provider, personal_text, now, None, device_id)
        return self.rows[provider]

    async def revoke(self, provider: str, now: datetime) -> Consent | None:
        row = self.rows.get(provider)
        if row is not None and row.standing:
            row = self.rows[provider] = Consent(
                row.provider, row.personal_text, row.granted_at, now, row.device_id
            )
        return row


_COLUMNS = "provider, personal_text, granted_at, revoked_at, device_id"
GET_CONSENT = f"SELECT {_COLUMNS} FROM yawmi.ai_consents WHERE provider = $1"
GRANT_CONSENT = (
    "INSERT INTO yawmi.ai_consents (provider, personal_text, granted_at, revoked_at, device_id)"
    " VALUES ($1, $2, $3, NULL, $4)"
    " ON CONFLICT (provider) DO UPDATE SET personal_text = EXCLUDED.personal_text,"
    " granted_at = EXCLUDED.granted_at, revoked_at = NULL, device_id = EXCLUDED.device_id"
    f" RETURNING {_COLUMNS}"
)
REVOKE_CONSENT = (
    "UPDATE yawmi.ai_consents SET revoked_at = $2 WHERE provider = $1 AND revoked_at IS NULL"
)


def _consent(row: asyncpg.Record) -> Consent:
    return Consent(
        row["provider"],
        row["personal_text"],
        row["granted_at"],
        row["revoked_at"],
        row["device_id"],
    )


class AsyncpgConsentStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get(self, provider: str) -> Consent | None:
        row = await self._pool.fetchrow(GET_CONSENT, provider)
        return None if row is None else _consent(row)

    async def grant(
        self, provider: str, personal_text: bool, device_id: UUID | None, now: datetime
    ) -> Consent:
        row = await self._pool.fetchrow(GRANT_CONSENT, provider, personal_text, now, device_id)
        assert row is not None
        return _consent(row)

    async def revoke(self, provider: str, now: datetime) -> Consent | None:
        await self._pool.execute(REVOKE_CONSENT, provider, now)
        return await self.get(provider)


def get_consent_store(request: Request) -> ConsentStore:
    """The store injected into the app (tests), else Postgres over the lifespan's pool."""
    injected: ConsentStore | None = getattr(request.app.state, "ai_consent", None)
    return injected if injected is not None else AsyncpgConsentStore(get_pool())


ConsentStoreDep = Annotated[ConsentStore, Depends(get_consent_store)]


class ConsentRequired(Exception):
    """No standing consent for the configured provider."""


def problem(
    status: int, detail: str, code: str, loc: list[str | int] | None = None
) -> JSONResponse:
    """The AI routes' coded error, in the `ValidationErrorBody` shape (`yawmi.errors`): `detail`
    and one `errors` item carrying the code. `code` is ours, never text from a provider."""
    body = {"detail": detail, "errors": [{"loc": loc or ["body"], "type": code}]}
    return JSONResponse(status_code=status, content=body)


async def require_consent(store: ConsentStoreDep, settings: SettingsDep) -> Consent:
    """The standing consent of `settings.ai_provider`; `ConsentRequired` without one."""
    consent = await store.get(settings.ai_provider)
    if consent is None or not consent.standing:
        raise ConsentRequired
    return consent


ConsentDep = Annotated[Consent, Depends(require_consent)]


class ConsentRoute(APIRoute):
    """Answers `ConsentRequired` (raised while solving dependencies) with a 403 and its code."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def route_handler(request: Request) -> Response:
            try:
                return await handler(request)
            except ConsentRequired:
                return problem(403, MSG_CONSENT_REQUIRED, CONSENT_REQUIRED)

        return route_handler


def now_utc() -> datetime:
    return datetime.now(UTC)
