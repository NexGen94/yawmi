"""In-memory `DeviceStore`: for tests and local experiments, never for production."""

import hmac
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from uuid import UUID, uuid4

from yawmi.auth.deps import Device, PairingCode


def _utc_now() -> datetime:
    return datetime.now(UTC)


class InMemoryDeviceStore:
    """Single-process store with the same semantics as the SQL one.

    `clock` is public so tests can move time without patching globals.
    """

    def __init__(self, clock: Callable[[], datetime] = _utc_now) -> None:
        self.clock = clock
        self._codes: dict[str, tuple[PairingCode, bool]] = {}  # code -> (row, used)
        self._devices: dict[UUID, Device] = {}

    async def add_pairing_code(self, code: str, kind: str, expires_at: datetime) -> bool:
        if code in self._codes:
            return False
        self._codes[code] = (PairingCode(code=code, kind=kind, expires_at=expires_at), False)
        return True

    async def consume_pairing_code(self, code: str) -> PairingCode | None:
        entry = self._codes.get(code)
        if entry is None:
            return None
        row, used = entry
        if used or row.expires_at <= self.clock():
            return None
        self._codes[code] = (row, True)
        return row

    async def create_device(self, name: str, kind: str, refresh_hash: str) -> UUID:
        device_id = uuid4()
        self._devices[device_id] = Device(
            id=device_id,
            name=name,
            kind=kind,
            refresh_hash=refresh_hash,
            paired_at=self.clock(),
            revoked_at=None,
        )
        return device_id

    async def get_device(self, device_id: UUID) -> Device | None:
        return self._devices.get(device_id)

    async def rotate_refresh(self, device_id: UUID, old_hash: str, new_hash: str) -> bool:
        device = self._devices.get(device_id)
        if device is None or device.revoked_at is not None or device.refresh_hash is None:
            return False
        if not hmac.compare_digest(device.refresh_hash, old_hash):
            return False
        self._devices[device_id] = replace(device, refresh_hash=new_hash)
        return True

    async def revoke(self, device_id: UUID) -> bool:
        device = self._devices.get(device_id)
        if device is None:
            return False
        self._devices[device_id] = replace(
            device,
            refresh_hash=None,
            revoked_at=device.revoked_at or self.clock(),
        )
        return True
