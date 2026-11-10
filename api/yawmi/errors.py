"""Shared error bodies and OpenAPI response entries, imported by every route module.

Two shapes exist, and only two:

* `ErrorDetail` `{"detail": "<Arabic>"}` for 400/401/403/404/409.
* `ValidationErrorBody` `{"detail": "طلب غير صالح", "errors": [{"loc": [...], "type": "<code>"}]}`
  for every 422; the handler that writes it is `yawmi.main._validation_error`. The offending
  input is never echoed back.

Route modules import these from here, never from one another, so no route module depends on
another one's internals.
"""

from typing import Any

from pydantic import BaseModel


class ErrorDetail(BaseModel):
    detail: str


class ValidationErrorItem(BaseModel):
    loc: list[str | int]
    type: str


class ValidationErrorBody(BaseModel):
    detail: str
    errors: list[ValidationErrorItem]


def validation_response(description: str = "طلب غير صالح") -> dict[str, Any]:
    """The 422 entry for `responses=`: documents the app's real 422 body, not FastAPI's."""
    return {"model": ValidationErrorBody, "description": description}


UNAUTHORIZED: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorDetail, "description": "غير مصرّح"},
}
FORBIDDEN: dict[int | str, dict[str, Any]] = {
    403: {"model": ErrorDetail, "description": "غير مسموح"},
}
INVALID: dict[int | str, dict[str, Any]] = {422: validation_response()}
