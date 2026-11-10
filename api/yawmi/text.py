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
PAYLOAD_TEXT_INVALID = "نص الحمولة غير صالح"


def is_storable(text: str) -> bool:
    """`True` when `text` is valid UTF-8 text without NUL."""
    if "\x00" in text:
        return False
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def check_text(
    value: object, code: str = "payload_text_invalid", message: str = PAYLOAD_TEXT_INVALID
) -> None:
    """Refuse NUL and lone surrogates anywhere in `value`, raising `PydanticCustomError(code)`.

    Walks dicts (keys and values) and lists of any depth; other values are ignored. The walk
    is iterative so a deeply nested value cannot exhaust the interpreter stack. Events pass
    `payload_text_invalid` (the default); the pair and AI routes use `text_invalid`.
    """
    stack: list[object] = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            for key, inner in item.items():
                stack.append(key)
                stack.append(inner)
        elif isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, str) and not is_storable(item):
            raise PydanticCustomError(code, message)


def _storable(text: str) -> str:
    if not is_storable(text):
        raise PydanticCustomError("text_invalid", TEXT_INVALID)
    return text


StorableText = Annotated[str, AfterValidator(_storable)]
"""A `str` field that refuses NUL and lone surrogates with a 422 (`text_invalid`)."""
