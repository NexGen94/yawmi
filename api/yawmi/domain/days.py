"""The local calendar day of an instant.

The plan's day is the `Asia/Riyadh` day (UTC+3, no daylight saving). `day_key` is the single
place that turns an instant into a day, so the server and the clients agree on day boundaries;
the shared test vectors for it are generated from this function.
"""

from datetime import date, datetime
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TZ = "Asia/Riyadh"


@lru_cache(maxsize=64)
def _zone(tz: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        # ValueError: malformed key (absolute or `..` path); OSError: a directory, not a zone
        raise ValueError(f"unknown tz: {tz!r}") from None


def is_valid_tz(tz: str) -> bool:
    """Whether `tz` names an IANA zone this process can load."""
    try:
        _zone(tz)
    except ValueError:
        return False
    return True


def day_key(instant: datetime, tz: str) -> date:
    """The calendar day `instant` falls on in `tz`.

    The instant must be timezone-aware: a naive datetime would silently take the server's zone,
    so it is refused. The day follows the instant, not the offset it was written with.
    """
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError("instant must be timezone-aware")
    return instant.astimezone(_zone(tz)).date()
