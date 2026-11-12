"""Journal and mood read store and shared date-range validation."""

from datetime import date

from fastapi.exceptions import RequestValidationError

from yawmi.events.project import EARLIEST, LATEST

MAX_RANGE_DAYS = 400

_DAY_OUT_OF_RANGE = "اليوم خارج النطاق المعقول"
_INVALID_RANGE = "نهاية المدى تسبق بدايته"
_RANGE_TOO_LARGE = "المدى يتجاوز 400 يوم"


def check_date_range(first: date, last: date) -> tuple[date, date]:
    """Validate `[first, last]` is within `[EARLIEST, LATEST)` and spans at most 400 days."""
    for name, value in (("from", first), ("to", last)):
        if not EARLIEST.date() <= value < LATEST.date():
            raise RequestValidationError(
                [{"loc": ("query", name), "type": "day_out_of_range", "msg": _DAY_OUT_OF_RANGE}]
            )
    if last < first:
        raise RequestValidationError(
            [{"loc": ("query", "to"), "type": "invalid_range", "msg": _INVALID_RANGE}]
        )
    if (last - first).days > MAX_RANGE_DAYS:
        raise RequestValidationError(
            [{"loc": ("query", "to"), "type": "range_too_large", "msg": _RANGE_TOO_LARGE}]
        )
    return first, last
