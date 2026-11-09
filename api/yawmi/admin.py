"""`yawmi-admin`: operator commands, run on the server by hand.

    uv run yawmi-admin pair-code --kind iphone|watch|web

prints an 8-digit, single-use pairing code valid for 10 minutes. It inserts into
`yawmi.pairing_codes` through `YAWMI_DATABASE_URL` (see `AsyncpgDeviceStore`).
"""

import argparse
import asyncio
import secrets
import sys
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from yawmi.auth.deps import DeviceStore
from yawmi.auth.pg_store import AsyncpgDeviceStore
from yawmi.db.pool import create_pool
from yawmi.settings import settings

CODE_TTL = timedelta(minutes=10)
PAIRABLE_KINDS = ("iphone", "watch", "web")
MAX_ATTEMPTS = 10


def generate_code() -> str:
    """Eight random digits, leading zeros kept."""
    return f"{secrets.randbelow(10**8):08d}"


async def issue_pairing_code(store: DeviceStore, kind: str, *, now: datetime | None = None) -> str:
    """Create a code for `kind` that expires `CODE_TTL` after `now`, retrying on a collision."""
    if kind not in PAIRABLE_KINDS:
        raise ValueError(f"نوع غير قابل للإقران: {kind}")
    expires_at = (now or datetime.now(UTC)) + CODE_TTL
    for _ in range(MAX_ATTEMPTS):
        code = generate_code()
        if await store.add_pairing_code(code, kind, expires_at):
            return code
    raise RuntimeError("تعذّر توليد كود غير مكرر")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="yawmi-admin", description="أدوات إدارة خدمة يومي")
    commands = parser.add_subparsers(dest="command", required=True)
    pair_code = commands.add_parser("pair-code", help="توليد كود إقران لمرة واحدة صالح 10 دقائق")
    pair_code.add_argument(
        "--kind", required=True, choices=PAIRABLE_KINDS, help="نوع الجهاز المراد إقرانه"
    )
    return parser


async def _pair_code(kind: str) -> str:
    pool = await create_pool(settings().database_url, min_size=1, max_size=1)
    try:
        return await issue_pairing_code(AsyncpgDeviceStore(pool), kind)
    finally:
        await pool.close()


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    try:
        code = asyncio.run(_pair_code(args.kind))
    except Exception as exc:  # noqa: BLE001  # class name only: messages may carry connection details
        print(f"تعذّر توليد الكود ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(code)  # stdout carries only the code, so it can be piped
    print("الكود صالح 10 دقائق ولاستخدام واحد", file=sys.stderr)
    return 0
