"""FastAPI dependency of the focus and breath routes: the store injected into the app (tests),
else the Postgres one over the lifespan's pool."""

from typing import Annotated

from fastapi import Depends, Request

from yawmi.db.pool import get_pool
from yawmi.focus.store import AsyncpgFocusStore, FocusStore


def get_focus_store(request: Request) -> FocusStore:
    injected: FocusStore | None = getattr(request.app.state, "focus", None)
    return injected if injected is not None else AsyncpgFocusStore(get_pool())


FocusStoreDep = Annotated[FocusStore, Depends(get_focus_store)]
