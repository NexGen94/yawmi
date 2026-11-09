"""asyncpg connection pool: created in the app lifespan, read through `get_pool()`."""

import asyncpg

_pool: asyncpg.Pool | None = None


async def create_pool(dsn: str, *, min_size: int = 1, max_size: int = 5) -> asyncpg.Pool:
    """Open a pool whose connections use schema `yawmi` and UTC (`timestamptz` always)."""
    return await asyncpg.create_pool(
        dsn,
        min_size=min_size,
        max_size=max_size,
        server_settings={"search_path": "yawmi", "timezone": "UTC"},
    )


def set_pool(pool: asyncpg.Pool | None) -> None:
    """Store (or clear, with `None`) the pool created in the app lifespan."""
    global _pool
    _pool = pool


def get_pool() -> asyncpg.Pool:
    """Return the pool stored by `set_pool`; fail loudly if the lifespan has not set one."""
    if _pool is None:
        raise RuntimeError("database pool is not initialised: call set_pool() in the app lifespan")
    return _pool
