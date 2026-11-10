"""Postgres `DeviceStore` over asyncpg.

UNTESTED AGAINST A DATABASE: written against the task 3 schema (`yawmi.devices`,
`yawmi.pairing_codes`) and covered only by wiring tests with a fake pool. Run it for real once
the schema is loaded (see the PR notes).

Every statement is atomic on its own (one `UPDATE ... RETURNING`), so two concurrent refreshes
with the same token cannot both succeed and a pairing code cannot be consumed twice.
"""

from collections.abc import Mapping
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from yawmi.auth.deps import Device, PairingCode

_ADD_PAIRING_CODE = """
INSERT INTO yawmi.pairing_codes (code, kind, expires_at)
VALUES ($1, $2, $3)
ON CONFLICT (code) DO NOTHING
"""

_CONSUME_PAIRING_CODE = """
UPDATE yawmi.pairing_codes
SET used_at = now()
WHERE code = $1 AND used_at IS NULL AND expires_at > now()
RETURNING code, kind, expires_at
"""

_CREATE_DEVICE = """
INSERT INTO yawmi.devices (id, name, kind, refresh_hash, paired_at)
VALUES ($1, $2, $3, $4, now())
"""

_GET_DEVICE = """
SELECT id, name, kind, refresh_hash, paired_at, revoked_at
FROM yawmi.devices
WHERE id = $1
"""

_ROTATE_REFRESH = """
UPDATE yawmi.devices
SET refresh_hash = $3
WHERE id = $1 AND refresh_hash = $2 AND revoked_at IS NULL
"""

_REVOKE = """
UPDATE yawmi.devices
SET revoked_at = COALESCE(revoked_at, now()), refresh_hash = NULL
WHERE id = $1
"""

# Same transaction as _REVOKE: a revoked device keeps no Web Push subscription.
_DROP_PUSH = "DELETE FROM yawmi.push_subscriptions WHERE device_id = $1"


def affected_rows(command_tag: str) -> int:
    """Row count from an asyncpg command tag: `UPDATE 1` -> 1, `INSERT 0 1` -> 1."""
    return int(command_tag.rsplit(" ", 1)[-1])


def device_from_row(row: Mapping[str, Any]) -> Device:
    return Device(
        id=row["id"],
        name=row["name"],
        kind=row["kind"],
        refresh_hash=row["refresh_hash"],
        paired_at=row["paired_at"],
        revoked_at=row["revoked_at"],
    )


class AsyncpgDeviceStore:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def add_pairing_code(self, code: str, kind: str, expires_at: datetime) -> bool:
        tag = await self._pool.execute(_ADD_PAIRING_CODE, code, kind, expires_at)
        return affected_rows(tag) == 1

    async def consume_pairing_code(self, code: str) -> PairingCode | None:
        row = await self._pool.fetchrow(_CONSUME_PAIRING_CODE, code)
        if row is None:
            return None
        return PairingCode(code=row["code"], kind=row["kind"], expires_at=row["expires_at"])

    async def create_device(self, name: str, kind: str, refresh_hash: str) -> UUID:
        device_id = uuid4()
        await self._pool.execute(_CREATE_DEVICE, device_id, name, kind, refresh_hash)
        return device_id

    async def get_device(self, device_id: UUID) -> Device | None:
        row = await self._pool.fetchrow(_GET_DEVICE, device_id)
        return None if row is None else device_from_row(row)

    async def rotate_refresh(self, device_id: UUID, old_hash: str, new_hash: str) -> bool:
        tag = await self._pool.execute(_ROTATE_REFRESH, device_id, old_hash, new_hash)
        return affected_rows(tag) == 1

    async def revoke(self, device_id: UUID) -> bool:
        async with self._pool.acquire() as conn, conn.transaction():
            tag = await conn.execute(_REVOKE, device_id)
            await conn.execute(_DROP_PUSH, device_id)
        return affected_rows(tag) == 1
