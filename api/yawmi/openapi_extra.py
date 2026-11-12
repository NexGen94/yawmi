"""Extra named Pydantic schemas published into OpenAPI `components.schemas`."""

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel
from pydantic.json_schema import models_json_schema

from yawmi.ai.schema import InsightResponse
from yawmi.events.project import (
    BreathEndedPayload,
    EveningAnswers,
    FocusEndedPayload,
    FocusStartedPayload,
    GoalTaskSetPayload,
    HabitLoggedPayload,
    HabitMarkPayload,
    JournalSavedPayload,
    MoodLoggedPayload,
    MorningAnswers,
)

REF_TEMPLATE = "#/components/schemas/{model}"

EXTRA_SCHEMAS: tuple[type[BaseModel], ...] = (
    HabitLoggedPayload,
    HabitMarkPayload,
    FocusStartedPayload,
    FocusEndedPayload,
    BreathEndedPayload,
    JournalSavedPayload,
    MorningAnswers,
    EveningAnswers,
    MoodLoggedPayload,
    GoalTaskSetPayload,
    InsightResponse,
)


def install_extra_schemas(app: FastAPI) -> None:
    """Wrap `app.openapi` so every model in `EXTRA_SCHEMAS` (and its sub-models) is in `components.schemas`."""
    default_openapi = app.openapi

    def custom_openapi() -> dict[str, Any]:
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = default_openapi()
        _, top = models_json_schema(
            [(model, "validation") for model in EXTRA_SCHEMAS],
            ref_template=REF_TEMPLATE,
        )
        schemas = schema.setdefault("components", {}).setdefault("schemas", {})
        for name, definition in top.get("$defs", {}).items():
            if name in schemas:
                assert schemas[name] == definition, (
                    f"Schema collision for '{name}' with different definitions: "
                    f"{schemas[name]!r} != {definition!r}"
                )
            else:
                schemas[name] = definition
        app.openapi_schema = schema
        return schema

    app.openapi = custom_openapi  # type: ignore[method-assign]
