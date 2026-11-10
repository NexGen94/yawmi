"""`yawmi-admin`: operator commands, run on the server by hand.

    uv run yawmi-admin pair-code --kind iphone|watch|web
    uv run yawmi-admin service-token --name <name> [--ttl-hours N] [--dry-run]

`pair-code` prints an 8-digit, single-use pairing code valid for 10 minutes. It inserts into
`yawmi.pairing_codes` through `YAWMI_DATABASE_URL` (see `AsyncpgDeviceStore`).

`service-token` registers a `service` device (for the scheduler and for `POST
/v1/devices/{id}/revoke`) and prints its access token on one line, and nothing else, on stdout.
Access tokens are stateless, so revoking the device row does not cut the token short: to
invalidate every outstanding token, rotate `YAWMI_JWT_SECRET`. There is no refresh token.
"""

import argparse
import asyncio
import secrets
import sys
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from yawmi.auth.deps import DeviceStore
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.auth.pg_store import AsyncpgDeviceStore
from yawmi.auth.tokens import issue_access, new_refresh
from yawmi.db.pool import create_pool
from yawmi.settings import settings

CODE_TTL = timedelta(minutes=10)
PAIRABLE_KINDS = ("iphone", "watch", "web")
MAX_ATTEMPTS = 10

DEFAULT_SERVICE_TTL_HOURS = 8760  # one year
MAX_SERVICE_TTL_HOURS = 43800  # five years: the plan's horizon, and far from datetime overflow
MAX_NAME_LENGTH = 100  # same bound as `PairRequest.name`


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


def _checked_name(name: str) -> str:
    name = name.strip()
    if not 1 <= len(name) <= MAX_NAME_LENGTH:
        raise ValueError(f"الاسم من 1 إلى {MAX_NAME_LENGTH} حرفاً")
    return name


def _checked_ttl_hours(hours: int) -> int:
    if not 1 <= hours <= MAX_SERVICE_TTL_HOURS:
        raise ValueError(f"المدة من 1 إلى {MAX_SERVICE_TTL_HOURS} ساعة")
    return hours


async def issue_service_token(
    store: DeviceStore, name: str, *, secret: str, ttl_hours: int = DEFAULT_SERVICE_TTL_HOURS
) -> str:
    """Register a `service` device named `name` and return an access token for it.

    The token is the only credential: the row's refresh hash comes from a random token that is
    thrown away here, so no refresh token exists and `/v1/auth/refresh` can never succeed for it.
    """
    name = _checked_name(name)
    ttl_hours = _checked_ttl_hours(ttl_hours)
    _discarded_raw, discarded_hash = new_refresh()
    device_id = await store.create_device(name, "service", discarded_hash)
    return issue_access(device_id, "service", secret, ttl_hours * 3600)


def _name_arg(value: str) -> str:
    try:
        return _checked_name(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def _ttl_hours_arg(value: str) -> int:
    try:
        hours = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("المدة عدد صحيح من الساعات") from None
    try:
        return _checked_ttl_hours(hours)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="yawmi-admin", description="أدوات إدارة خدمة يومي")
    commands = parser.add_subparsers(dest="command", required=True)
    pair_code = commands.add_parser("pair-code", help="توليد كود إقران لمرة واحدة صالح 10 دقائق")
    pair_code.add_argument(
        "--kind", required=True, choices=PAIRABLE_KINDS, help="نوع الجهاز المراد إقرانه"
    )
    service_token = commands.add_parser(
        "service-token", help="إنشاء جهاز خدمة وطباعة رمز وصوله (سطر واحد، بلا رمز تحديث)"
    )
    service_token.add_argument(
        "--name", required=True, type=_name_arg, help="اسم الجهاز، مثل n8n-scheduler"
    )
    service_token.add_argument(
        "--ttl-hours",
        type=_ttl_hours_arg,
        default=DEFAULT_SERVICE_TTL_HOURS,
        help=f"صلاحية الرمز بالساعات (الافتراضي {DEFAULT_SERVICE_TTL_HOURS}، الأقصى {MAX_SERVICE_TTL_HOURS})",
    )
    service_token.add_argument(
        "--dry-run",
        action="store_true",
        help="بلا قاعدة بيانات: يُنشأ الجهاز في الذاكرة فقط (الرمز يبقى موقّعاً بالسر الحقيقي)",
    )
    return parser


async def _pair_code(kind: str) -> str:
    pool = await create_pool(settings().database_url, min_size=1, max_size=1)
    try:
        return await issue_pairing_code(AsyncpgDeviceStore(pool), kind)
    finally:
        await pool.close()


async def _service_token(name: str, ttl_hours: int, *, dry_run: bool) -> str:
    config = settings()
    secret = config.jwt_secret.get_secret_value()
    if dry_run:
        return await issue_service_token(
            InMemoryDeviceStore(), name, secret=secret, ttl_hours=ttl_hours
        )
    pool = await create_pool(config.database_url, min_size=1, max_size=1)
    try:
        return await issue_service_token(
            AsyncpgDeviceStore(pool), name, secret=secret, ttl_hours=ttl_hours
        )
    finally:
        await pool.close()


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    if args.command == "service-token":
        try:
            token = asyncio.run(_service_token(args.name, args.ttl_hours, dry_run=args.dry_run))
        except Exception as exc:  # noqa: BLE001  # class name only: messages may carry connection details
            print(f"تعذّر إنشاء رمز الخدمة ({type(exc).__name__})", file=sys.stderr)
            return 1
        print(token)  # stdout carries only the token, so it can be piped
        if args.dry_run:
            print("تشغيل تجريبي: لم يُسجَّل جهاز في قاعدة البيانات", file=sys.stderr)
        else:
            print(
                f"سُجّل جهاز الخدمة، والرمز صالح {args.ttl_hours} ساعة، ولا يُعرض مرة ثانية",
                file=sys.stderr,
            )
        return 0
    try:
        code = asyncio.run(_pair_code(args.kind))
    except Exception as exc:  # noqa: BLE001  # class name only: messages may carry connection details
        print(f"تعذّر توليد الكود ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(code)  # stdout carries only the code, so it can be piped
    print("الكود صالح 10 دقائق ولاستخدام واحد", file=sys.stderr)
    return 0
