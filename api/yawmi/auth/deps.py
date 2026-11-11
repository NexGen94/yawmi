"""Auth dependencies and the `DeviceStore` contract.

`DeviceStore` is the only persistence seam of the auth layer: production uses
`AsyncpgDeviceStore` (Postgres), tests use `InMemoryDeviceStore`. The app keeps the store on
`app.state.devices` and routes read it through `get_devices`.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated, Protocol
from uuid import UUID

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from yawmi.auth.tokens import AccessClaims, AuthError, verify_access
from yawmi.settings import Settings
from yawmi.settings import settings as load_settings

UNAUTHORIZED_MESSAGE = "غير مصرّح"
FORBIDDEN_MESSAGE = "غير مسموح"


@dataclass(frozen=True)
class PairingCode:
    code: str
    kind: str
    expires_at: datetime


@dataclass(frozen=True)
class Device:
    id: UUID
    name: str
    kind: str
    refresh_hash: str | None
    paired_at: datetime
    revoked_at: datetime | None


class DeviceStore(Protocol):
    """Devices and one-time pairing codes."""

    async def add_pairing_code(self, code: str, kind: str, expires_at: datetime) -> bool:
        """Store a new code; `False` if that code string already exists."""
        ...

    async def consume_pairing_code(self, code: str) -> PairingCode | None:
        """Atomically mark `code` used and return it; `None` if unknown, used or expired."""
        ...

    async def create_device(self, name: str, kind: str, refresh_hash: str) -> UUID:
        """Insert a paired device holding the hash of its first refresh token."""
        ...

    async def get_device(self, device_id: UUID) -> Device | None: ...

    async def rotate_refresh(
        self, device_id: UUID, old_hash: str, new_hash: str, *, max_age: timedelta
    ) -> bool:
        """Swap the refresh hash iff `old_hash` is current, the device is not revoked and the
        hash was issued (paired or last rotated) less than `max_age` ago; restart that clock."""
        ...

    async def revoke(self, device_id: UUID) -> bool:
        """Revoke the device and drop its refresh hash; `False` only if it does not exist."""
        ...


def unauthorized(*, bearer: bool = True) -> HTTPException:
    headers = {"WWW-Authenticate": "Bearer"} if bearer else None
    return HTTPException(status_code=401, detail=UNAUTHORIZED_MESSAGE, headers=headers)


def forbidden() -> HTTPException:
    return HTTPException(status_code=403, detail=FORBIDDEN_MESSAGE)


def get_settings(request: Request) -> Settings:
    """Settings injected into the app (tests), else the process-wide environment settings."""
    injected: Settings | None = getattr(request.app.state, "settings", None)
    return injected if injected is not None else load_settings()


def get_devices(request: Request) -> DeviceStore:
    store: DeviceStore | None = getattr(request.app.state, "devices", None)
    if store is None:
        raise RuntimeError("device store is not initialised: create the app with create_app()")
    return store


SettingsDep = Annotated[Settings, Depends(get_settings)]
DevicesDep = Annotated[DeviceStore, Depends(get_devices)]

_bearer = HTTPBearer(auto_error=False, description="رمز وصول الجهاز")


async def current_device(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    settings: SettingsDep,
) -> AccessClaims:
    """Verify the Bearer access token; 401 `غير مصرّح` when missing, invalid or expired."""
    if credentials is None:
        raise unauthorized()
    try:
        return verify_access(credentials.credentials, settings.jwt_secret.get_secret_value())
    except AuthError:
        raise unauthorized() from None


CurrentDevice = Annotated[AccessClaims, Depends(current_device)]


def require_kind(*kinds: str):
    """Dependency factory: the authenticated device must be one of `kinds`, else 403 `غير مسموح`."""

    async def dependency(claims: CurrentDevice) -> AccessClaims:
        if claims.kind not in kinds:
            raise forbidden()
        return claims

    return dependency
