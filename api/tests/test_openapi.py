"""`api/tools/export_openapi.py` and the committed `openapi/openapi.json`.

The committed file is the contract the web client (`openapi-typescript`) and the Swift client
are built against, so it must match the app exactly: `--check` fails on any difference.
"""

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from yawmi.ai.schema import insight_json_schema

API_DIR = Path(__file__).resolve().parents[1]
EXPORTER = API_DIR / "tools" / "export_openapi.py"


def load_exporter() -> ModuleType:
    spec = importlib.util.spec_from_file_location("export_openapi", EXPORTER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def exporter() -> ModuleType:
    return load_exporter()


def test_export_writes_every_required_path(exporter: ModuleType, tmp_path: Path) -> None:
    out = tmp_path / "openapi.json"
    assert exporter.main([], output=out) == 0
    spec = json.loads(out.read_text(encoding="utf-8"))
    assert spec["openapi"].startswith("3.1")
    for path in exporter.REQUIRED_PATHS:
        assert path in spec["paths"], path


def test_required_and_pending_paths_are_the_final_list_of_task_1(exporter: ModuleType) -> None:
    """Together they are the 18 paths of the spec (§ 6.1); none is listed twice."""
    final = {
        "/v1/devices/pair",
        "/v1/auth/refresh",
        "/v1/devices/{device_id}/revoke",
        "/v1/events",
        "/v1/health/live",
        "/v1/health/daily",
        "/v1/today",
        "/v1/overview",
        "/v1/day/close",
        "/v1/ask",
        "/v1/reviews",
        "/v1/notion/refresh",
        "/v1/habits",
        "/v1/habits/{code}",
        "/v1/habits/{code}/progress",
        "/v1/goals/{ref}/to-habit",
        "/v1/push/subscribe",
        "/v1/push/vapid-public-key",
    }
    required, pending = exporter.REQUIRED_PATHS, exporter.PENDING_PATHS
    assert len(final) == 18
    assert set(required).isdisjoint(pending)
    assert len(set(required)) == len(required) and len(set(pending)) == len(pending)
    assert set(required) | set(pending) == final


def test_output_is_deterministic_sorted_lf_with_a_trailing_newline(
    exporter: ModuleType, tmp_path: Path
) -> None:
    first, second = tmp_path / "a.json", tmp_path / "b.json"
    exporter.main([], output=first)
    exporter.main([], output=second)
    raw = first.read_bytes()
    assert raw == second.read_bytes()
    assert b"\r" not in raw
    assert raw.endswith(b"}\n") and not raw.endswith(b"\n\n")
    text = raw.decode("utf-8")
    assert text == json.dumps(json.loads(text), sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def test_check_passes_on_the_committed_file(exporter: ModuleType) -> None:
    """Regenerate with `uv run python -I tools/export_openapi.py` when this fails."""
    assert exporter.main(["--check"]) == 0


def test_the_command_line_takes_no_path(exporter: ModuleType) -> None:
    """The output path is fixed: a path from argv would let the tool read or write anywhere."""
    with pytest.raises(SystemExit):
        exporter.main(["--output", "elsewhere.json"])


def test_check_fails_on_a_stale_or_missing_file(exporter: ModuleType, tmp_path: Path) -> None:
    stale = tmp_path / "openapi.json"
    stale.write_text("{}\n", encoding="utf-8", newline="\n")
    assert exporter.main(["--check"], output=stale) == 1
    assert stale.read_text(encoding="utf-8") == "{}\n"  # --check never writes
    assert exporter.main(["--check"], output=tmp_path / "missing.json") == 1


def test_a_missing_required_path_fails_the_export(
    exporter: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(exporter, "REQUIRED_PATHS", (*exporter.REQUIRED_PATHS, "/v1/nowhere"))
    out = tmp_path / "openapi.json"
    with pytest.raises(SystemExit, match="/v1/nowhere"):
        exporter.main([], output=out)
    assert not out.exists()


def test_422_is_documented_with_the_app_shape(exporter: ModuleType) -> None:
    spec = exporter.build_spec()
    for path in ("/v1/health/daily", "/v1/events", "/v1/devices/pair"):
        ref = spec["paths"][path]["post"]["responses"]["422"]["content"]["application/json"]
        assert ref["schema"]["$ref"].endswith("/ValidationErrorBody")
    body = spec["components"]["schemas"]["ValidationErrorBody"]
    assert set(body["required"]) == {"detail", "errors"}
    # FastAPI's default `{detail: [...]}` body is never what the app sends: it must not appear
    for path, operations in spec["paths"].items():
        for method, operation in operations.items():
            assert "HTTPValidationError" not in json.dumps(operation), (method, path)


def _refs(node: Any) -> list[str]:
    if isinstance(node, dict):
        found = [node["$ref"]] if "$ref" in node else []
        return found + [r for v in node.values() for r in _refs(v)]
    if isinstance(node, list):
        return [r for v in node for r in _refs(v)]
    return []


def _assert_closed(schema: dict[str, Any]) -> None:
    """No `$ref`, and every object requires all of its properties."""
    assert _refs(schema) == []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object" and "properties" in node:
                assert set(node.get("required", [])) == set(node["properties"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(schema)


def test_insight_response_has_no_ref_and_requires_every_property(exporter: ModuleType) -> None:
    """The provider-facing schema is checked now; the spec's copy once task 9b exposes it."""
    _assert_closed(insight_json_schema())
    components = exporter.build_spec().get("components", {}).get("schemas", {})
    if "InsightResponse" in components:  # TODO(9b): becomes unconditional with /v1/day/close
        _assert_closed(components["InsightResponse"])


def _enum(schema: dict[str, Any]) -> list[str]:
    """The string values of an enum property, nullable or not."""
    options = schema.get("anyOf", [schema])
    return sorted(v for o in options for v in o.get("enum", []))


def test_closed_value_sets_are_enums_in_the_contract(exporter: ModuleType) -> None:
    schemas = exporter.build_spec()["components"]["schemas"]
    due = schemas["HabitDue"]["properties"]
    assert _enum(due["kind"]) == ["boolean", "count", "duration"]
    assert _enum(due["period"]) == ["day", "month", "week"]
    assert _enum(due["unit"]) == ["hour", "min", "session"]
    quality = ["low", "missing", "ok"]
    assert _enum(schemas["TodayHealth"]["properties"]["data_quality"]) == quality
    assert _enum(schemas["DailyScoresOut"]["properties"]["data_quality"]) == quality


def test_health_bodies_refuse_unknown_fields(exporter: ModuleType) -> None:
    schemas = exporter.build_spec()["components"]["schemas"]
    assert schemas["DailyMetricsIn"]["additionalProperties"] is False
    assert schemas["ExertionSegment"]["additionalProperties"] is False
    assert "hrv_samples" in schemas["DailyMetricsIn"]["required"]
