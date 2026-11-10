"""Text that Postgres can store: no NUL character and no lone surrogate.

Python's JSON parser turns the escapes `\\u0000` and `\\ud800` into real characters. Neither can be
written to a `text` column (NUL is refused by Postgres, a lone surrogate cannot be UTF-8
encoded), so without a check they surface as a driver error, a 500, at insert time. Request
models refuse them at the door instead, as a 422 of type `text_invalid`.
"""

from typing import Annotated

from pydantic import AfterValidator
from pydantic_core import PydanticCustomError

TEXT_INVALID = "النص يحوي محرفاً لا يمكن حفظه"


def is_storable(text: str) -> bool:
    """`True` when `text` is valid UTF-8 text without NUL."""
    if "\x00" in text:
        return False
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _storable(text: str) -> str:
    if not is_storable(text):
        raise PydanticCustomError("text_invalid", TEXT_INVALID)
    return text


StorableText = Annotated[str, AfterValidator(_storable)]
"""A `str` field that refuses NUL and lone surrogates with a 422 (`text_invalid`)."""
