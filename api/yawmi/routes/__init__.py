"""Route modules, discovered automatically.

Convention: every module in this package that defines a `router` (an `APIRouter`) is included
by `include_all`, which `create_app()` calls. To add routes, add a module here: `main.py` is
never edited, so tasks running in parallel do not collide there.
"""

import importlib
import pkgutil

from fastapi import FastAPI


def include_all(app: FastAPI) -> None:
    """Import every submodule of this package and include its `router`, if it has one.

    Modules are visited in name order, so the route table is the same on every start. A module
    without a `router` (a helper) is imported and otherwise ignored.
    """
    for info in sorted(pkgutil.iter_modules(__path__), key=lambda module: module.name):
        module = importlib.import_module(f"{__name__}.{info.name}")
        router = getattr(module, "router", None)
        if router is not None:
            app.include_router(router)
