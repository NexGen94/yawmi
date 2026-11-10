"""The shared error module: one source for the error bodies, no cross-imports between routes."""

import ast
from pathlib import Path

from yawmi.text import is_storable

ROUTES = Path(__file__).resolve().parents[1] / "yawmi" / "routes"


def test_no_route_module_imports_from_another_route_module() -> None:
    """`ErrorDetail` and friends live in `yawmi.errors`; routes never import one another."""
    for path in ROUTES.glob("*.py"):
        if path.name == "__init__.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                assert not node.module.startswith("yawmi.routes"), (path.name, node.module)


def test_storable_text() -> None:
    assert is_storable("نص عادي")
    assert is_storable("😀")
    assert not is_storable("a\x00b")
    assert not is_storable("a" + chr(0xD800))
    assert not is_storable(chr(0xDFFF))
