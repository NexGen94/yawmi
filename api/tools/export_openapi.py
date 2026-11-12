"""Write `openapi/openapi.json` from the FastAPI app, deterministically.

Run from `api/`:  uv run python -I tools/export_openapi.py          (write)
                  uv run python -I tools/export_openapi.py --check  (compare, never write)

The output is committed: the web client generates its types from it (`openapi-typescript`) and
the Swift client is contract-tested against it. Keys are sorted, indentation is two spaces, text
is UTF-8 (Arabic kept as is), line endings are LF and the file ends with one newline, so the same
app always gives the same bytes on every platform. `--check` exits 1 when the committed file is
missing or differs; the test suite runs it.

Every path in `REQUIRED_PATHS` must be in the spec or nothing is written. The final list of
task 1 has 18 paths; those whose routes are not merged yet are in `PENDING_PATHS`, and each
task moves its own paths across when it adds the routes (a test keeps the two lists together
equal to the final 18).
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from yawmi.auth.memory_store import InMemoryDeviceStore
from yawmi.main import create_app

OUTPUT = Path(__file__).resolve().parents[2] / "openapi" / "openapi.json"

REQUIRED_PATHS: tuple[str, ...] = (
    "/v1/health/live",
    "/v1/devices/pair",
    "/v1/auth/refresh",
    "/v1/auth/logout",
    "/v1/devices/{device_id}/revoke",
    "/v1/events",
    "/v1/health/daily",
    "/v1/today",
    "/v1/overview",
    "/v1/day/close",
    "/v1/ask",
    "/v1/reviews",
    "/v1/habits",
    "/v1/habits/{code}",
    "/v1/habits/{code}/progress",
    "/v1/habit-logs",
    "/v1/journal",
    "/v1/mood",
    "/v1/goals/{ref}/to-habit",
    "/v1/push/subscribe",
    "/v1/push/vapid-public-key",
    "/v1/settings",
    "/v1/indicators",
    "/v1/indicators/{subject_kind}/{subject_ref}",
)

# Not built yet. The task that adds a route moves its path to REQUIRED_PATHS and regenerates
# openapi.json in its own pull request (the --check test fails otherwise).
PENDING_PATHS: tuple[str, ...] = (
    # no owning task yet in the plan (calls n8n)
    "/v1/notion/refresh",
)


def build_spec() -> dict[str, Any]:
    """The app's OpenAPI document. The in-memory store only keeps the app off the database."""
    return create_app(devices=InMemoryDeviceStore()).openapi()


def render(spec: dict[str, Any]) -> str:
    return json.dumps(spec, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None, *, output: Path = OUTPUT) -> int:
    """Write (or with `--check` compare) the spec. The command line only ever touches `OUTPUT`;
    `output` exists for tests, so no path is taken from the command line."""
    parser = argparse.ArgumentParser(
        description=f"Export the OpenAPI spec of yawmi-api to {OUTPUT}."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare with the committed file and exit 1 on a difference",
    )
    args = parser.parse_args(argv)

    spec = build_spec()
    missing = [path for path in REQUIRED_PATHS if path not in spec.get("paths", {})]
    if missing:
        raise SystemExit(f"required paths missing from the app: {', '.join(missing)}")
    text = render(spec)

    if args.check:
        current = output.read_bytes() if output.is_file() else None
        if current != text.encode("utf-8"):
            print(f"{output} is stale: run tools/export_openapi.py", file=sys.stderr)
            return 1
        print(f"{output} is up to date")
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {output} ({len(spec['paths'])} paths)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
