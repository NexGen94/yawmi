"""Contract of one insight: the request, the response and the schema sent to providers.

`InsightResponse` is the single internal contract. Pydantic enforces it strictly on our side
(including `max_length`); `insight_json_schema()` derives the provider-facing JSON schema from
it and reduces it to the lowest common denominator that every provider accepts: every property
required, `additionalProperties: false`, no `$ref`, and none of the min/max keywords.
"""

import copy
from datetime import date
from functools import lru_cache
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

InsightKind = Literal["morning", "evening", "weekly", "ask", "deeper"]

# Keywords that are not part of the common denominator (or are only noise for a provider).
_DROPPED_KEYWORDS = frozenset(
    {
        "title",
        "default",
        "examples",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minProperties",
        "maxProperties",
        "uniqueItems",
    }
)


class Source(BaseModel):
    """One citable fact handed to the model. The model may cite only these ids."""

    id: str
    kind: str
    text: str


class InsightRequest(BaseModel):
    kind: InsightKind
    day: date
    locale: str = "ar"
    context: dict[str, Any] = Field(default_factory=dict)
    sources: list[Source] = Field(default_factory=list)
    question: str | None = None

    @model_validator(mode="after")
    def _ask_needs_a_question(self) -> Self:
        if self.kind == "ask" and not (self.question and self.question.strip()):
            raise ValueError("kind 'ask' requires a non-empty question")
        return self


class Priority(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(description="عنوان الأولوية في جملة اسمية قصيرة")
    source_id: str = Field(description="معرّف مصدر من المصادر المعطاة فقط")


class InsightResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lines: list[str] = Field(max_length=2, description="سطران كحد أقصى")
    question: str | None = Field(description="سؤال واحد على الأكثر، أو null")
    source_ids: list[str] = Field(description="معرّفات المصادر المعطاة التي استند إليها الرد")
    priorities: list[Priority] = Field(max_length=3, description="ثلاث أولويات كحد أقصى")


def _reduce(node: Any, defs: dict[str, Any]) -> Any:
    """Inline `$ref`s, drop non-common keywords, close every object and require all fields."""
    if isinstance(node, list):
        return [_reduce(item, defs) for item in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        resolved = _reduce(defs[node["$ref"].rsplit("/", 1)[-1]], defs)
        siblings = {k: v for k, v in node.items() if k != "$ref"}
        return {**resolved, **_reduce(siblings, defs)}

    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "$defs" or key in _DROPPED_KEYWORDS:
            continue
        if key == "properties":
            # Property *names* are data, not keywords: a field called "title" must survive.
            out[key] = {name: _reduce(sub, defs) for name, sub in value.items()}
        else:
            out[key] = _reduce(value, defs)
    if "properties" in out:
        out["required"] = list(out["properties"])
        out["additionalProperties"] = False
    return out


@lru_cache(maxsize=1)
def _built_schema() -> dict[str, Any]:
    raw = InsightResponse.model_json_schema()
    return _reduce(raw, raw.get("$defs", {}))


def insight_json_schema() -> dict[str, Any]:
    """The provider-facing JSON schema of `InsightResponse` (a fresh copy on every call)."""
    return copy.deepcopy(_built_schema())
