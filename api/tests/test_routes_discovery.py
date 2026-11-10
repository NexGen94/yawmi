"""Router auto-discovery: every module in `yawmi/routes/` that defines `router` is included.

Adding a route module must never require editing `main.py`, so parallel tasks do not collide
there. The tests drop real throw-away modules into the package path instead of mocking
`pkgutil`, so the discovery and the import are both exercised.
"""

import importlib
import sys
import textwrap
from pathlib import Path

import pytest
from fastapi import FastAPI
from pydantic import SecretStr

from yawmi import routes
from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.main import create_app
from yawmi.routes import include_all
from yawmi.settings import Settings

ROUTER_MODULE = """
from fastapi import APIRouter

router = APIRouter(prefix="/v1/_{name}")


@router.get("/ping")
async def ping() -> dict[str, str]:
    return {{"from": "{name}"}}
"""


def make_settings() -> Settings:
    return Settings(
        database_url="postgresql://yawmi_api@localhost:5432/raqib",
        jwt_secret=SecretStr("test-secret-for-unit-tests-only-0123456789"),
    )


@pytest.fixture
def fake_package(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A temp directory appended to `yawmi.routes.__path__`; its modules are removed afterwards."""
    monkeypatch.setattr(routes, "__path__", [*routes.__path__, str(tmp_path)])
    importlib.invalidate_caches()
    before = set(sys.modules)
    yield tmp_path
    for name in set(sys.modules) - before:
        if name.startswith("yawmi.routes."):
            del sys.modules[name]


def write_router(directory: Path, name: str) -> None:
    source = textwrap.dedent(ROUTER_MODULE).format(name=name)
    (directory / f"{name}.py").write_text(source, encoding="utf-8")


def paths(app: FastAPI) -> list[str]:
    """Every published path, in route order.

    FastAPI 0.162 keeps an included router in `app.routes` as one `_IncludedRouter` without a
    `path`, so the OpenAPI document is the reliable place to look for routes that came from
    `include_router`.
    """
    return list(app.openapi()["paths"])


def test_include_all_registers_a_router_from_a_discovered_module(fake_package: Path) -> None:
    write_router(fake_package, "fake_one")
    app = FastAPI()
    include_all(app)
    assert "/v1/_fake_one/ping" in paths(app)


def test_include_all_includes_every_module_in_name_order(fake_package: Path) -> None:
    write_router(fake_package, "zz_fake")
    write_router(fake_package, "aa_fake")
    app = FastAPI()
    include_all(app)
    registered = paths(app)
    # sorted by module name: `aa_fake` < `devices` < `zz_fake`
    assert (
        registered.index("/v1/_aa_fake/ping")
        < registered.index("/v1/devices/pair")
        < registered.index("/v1/_zz_fake/ping")
    )


def test_include_all_skips_modules_without_a_router(fake_package: Path) -> None:
    (fake_package / "no_router_here.py").write_text("VALUE = 1\n", encoding="utf-8")
    app = FastAPI()
    include_all(app)  # must not raise
    assert "yawmi.routes.no_router_here" in sys.modules  # it was imported, then ignored
    assert not any("no_router_here" in p for p in paths(app))


def test_include_all_is_deterministic(fake_package: Path) -> None:
    write_router(fake_package, "mm_fake")
    first, second = FastAPI(), FastAPI()
    include_all(first)
    include_all(second)
    assert paths(first) == paths(second)


def test_include_all_registers_the_shipped_routes() -> None:
    app = FastAPI()
    include_all(app)
    assert "/v1/devices/pair" in paths(app)
    assert "/v1/auth/refresh" in paths(app)


def test_create_app_keeps_health_and_device_routes() -> None:
    app = create_app(settings=make_settings(), devices=InMemoryDeviceStore())
    registered = paths(app)
    # the health route is declared on the app itself, so it is literally in `app.routes`
    assert "/v1/health/live" in [getattr(route, "path", None) for route in app.routes]
    assert "/v1/health/live" in registered
    assert "/v1/devices/pair" in registered
    assert "/v1/auth/refresh" in registered
    assert "/v1/devices/{device_id}/revoke" in registered


def test_create_app_discovers_a_new_module_without_touching_main(fake_package: Path) -> None:
    write_router(fake_package, "late_fake")
    app = create_app(settings=make_settings(), devices=InMemoryDeviceStore())
    assert "/v1/_late_fake/ping" in paths(app)
