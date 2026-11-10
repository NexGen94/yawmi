"""FastAPI application: app factory, lifespan, request-id/access-log middleware, health."""

import logging
import re
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from yawmi import __version__
from yawmi.auth.deps import DeviceStore
from yawmi.auth.pg_store import AsyncpgDeviceStore
from yawmi.db.pool import create_pool, set_pool
from yawmi.routes import include_all
from yawmi.settings import Settings
from yawmi.settings import settings as load_settings

access_log = logging.getLogger("yawmi.access")

_REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")


def printable(text: str) -> str:
    """`text` with every non-printable character replaced by `?`.

    `scope["path"]` is percent-decoded, so a request for `/x%0Afake` carries a real newline: logged
    as is, it would forge a second log line. `str.isprintable` is false for all control characters
    and for the Unicode line/paragraph separators, so it covers more than line feeds.
    """
    return text if text.isprintable() else "".join(c if c.isprintable() else "?" for c in text)


class RequestIdMiddleware:
    """Tag every response with `X-Request-Id` and write one access-log line per request.

    The line carries method, path, status, duration and request id: never query strings,
    headers, cookies or bodies (request bodies are not logged anywhere). The path is logged with
    its non-printable characters neutralised (see `printable`), so it cannot forge log lines.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = Headers(scope=scope).get("x-request-id")
        # Echo a client id only when it is short and safe to log; otherwise mint our own.
        request_id = incoming if incoming and _REQUEST_ID.fullmatch(incoming) else str(uuid.uuid4())
        scope.setdefault("state", {})["request_id"] = request_id
        status = 500
        started = time.perf_counter()

        async def send_with_request_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message.setdefault("headers", [])
                MutableHeaders(scope=message)["X-Request-Id"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            access_log.info(
                "%s %s -> %s %.1fms id=%s",
                scope["method"],
                printable(scope["path"]),
                status,
                elapsed_ms,
                request_id,
            )


class Live(BaseModel):
    ok: bool


async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    """Arabic summary plus where/what failed; the offending input is never echoed back."""
    errors = [{"loc": list(error["loc"]), "type": error["type"]} for error in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": "طلب غير صالح", "errors": errors})


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    pool = None
    reminders = None
    if app.state.use_db:
        config: Settings = app.state.settings or load_settings()
        if config.database_url:
            pool = await create_pool(config.database_url)
            set_pool(pool)
            app.state.devices = AsyncpgDeviceStore(pool)
            if config.push_enabled:
                # imported here so that with push off pywebpush and aiohttp are never loaded
                from yawmi.push.scheduler import start_reminders

                try:
                    reminders = app.state.reminder_loop = start_reminders(pool, config)
                except Exception:
                    set_pool(None)
                    await pool.close()
                    raise
    try:
        yield
    finally:
        if reminders is not None:
            await reminders.stop()
        if pool is not None:
            set_pool(None)
            await pool.close()


def create_app(*, settings: Settings | None = None, devices: DeviceStore | None = None) -> FastAPI:
    """Build the app.

    Production calls it with no arguments: settings come from `YAWMI_*` at startup and the
    lifespan opens the Postgres pool. Tests pass `settings` and an in-memory `devices` store,
    which also switches `app.state.use_db` off so no database is ever touched.
    """
    app = FastAPI(title="yawmi-api", version=__version__, lifespan=_lifespan)
    app.state.settings = settings
    app.state.devices = devices
    app.state.use_db = devices is None
    app.add_middleware(RequestIdMiddleware)
    app.add_exception_handler(RequestValidationError, _validation_error)  # type: ignore[arg-type]
    include_all(app)

    @app.get("/v1/health/live", tags=["health"], summary="فحص الحياة (بلا مصادقة)")
    async def health_live() -> Live:
        return Live(ok=True)

    return app


app = create_app()


def run() -> None:
    """Console entry point (`uv run yawmi-api`)."""
    import uvicorn

    uvicorn.run(
        app, host="0.0.0.0", port=8000
    )  # bind all interfaces: the container is fronted by a proxy
