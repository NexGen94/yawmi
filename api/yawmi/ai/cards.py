"""Source cards: what the server shows under an insight, built from the sources it cited.

`InsightResponse` is the provider's contract and does not change (design §10, I-9): the provider
never sees `cards`. The server keeps one `SourceCard` per source it handed the provider, and the
reply's citations pick the cards (`cards_for`). `days` is derived, never stored (R-6): the
distinct non-empty card days in ascending order (`days_of`), for a fresh reply and a stored row
alike.
"""

from collections.abc import Sequence
from datetime import date, datetime
from typing import TYPE_CHECKING
from uuid import UUID

from pydantic import BaseModel, Field

from yawmi.ai.schema import InsightResponse, Priority

if TYPE_CHECKING:
    from yawmi.ai.grounding import Grounding


class SourceCard(BaseModel):
    """One cited source as the screen shows it."""

    source_id: str = Field(description="معرّف المصدر كما أُرسل إلى المزوّد")
    kind: str = Field(description="نوع المصدر: habit أو milestone أو outcome أو journal أو …")
    label: str = Field(description="اسم قصير للبطاقة")
    value: float | None = Field(description="الرقم الرئيس إن وُجد")
    unit: str | None = Field(description="ما يلي الرقم، مثل «من 7»")
    text: str = Field(description="نص المصدر كما أُرسل")
    trend: list[float | None] = Field(description="قيم الأيام السبعة الأخيرة للعادة، وإلا فارغة")
    day: date | None = Field(description="يوم المصدر إن كان ليوم واحد")


class GroundedInsight(InsightResponse):
    """A validated reply with the cards of the sources it cited and their days."""

    cards: list[SourceCard] = Field(description="بطاقات المصادر المستشهد بها، بترتيب الاستشهاد")
    days: list[date] = Field(description="أيام البطاقات المختلفة غير الفارغة، تصاعدياً")


class InsightOut(GroundedInsight):
    """A stored insight: the grounded reply plus its identity."""

    id: UUID
    kind: str
    day: date
    created_at: datetime


class DeeperOut(BaseModel):
    """The go-deeper reply (design §7.1): one question and up to three alternative questions.
    Never stored. The provider returns the alternatives in `priorities`; the route moves them."""

    question: str = Field(description="سؤال التأمل، حتى 200 حرف")
    options: list[Priority] = Field(
        max_length=3, description="حتى ثلاثة أسئلة بديلة: العنوان حتى 80 حرفاً، ومعه مصدره"
    )
    source_ids: list[str] = Field(description="مصادر السؤال الأول")


def days_of(cards: Sequence[SourceCard]) -> list[date]:
    """The distinct non-empty `day` values of `cards`, ascending."""
    return sorted({c.day for c in cards if c.day is not None})


def cited_ids(response: InsightResponse) -> list[str]:
    """Every source id the reply cites (its `source_ids`, then its priorities'), once each."""
    ids = [*response.source_ids, *(p.source_id for p in response.priorities)]
    return list(dict.fromkeys(ids))


def cards_for(source_ids: Sequence[str], grounding: "Grounding") -> list[SourceCard]:
    """The grounding's cards for `source_ids`, in citation order, once each; unknown ids drop."""
    by_id = {c.source_id: c for c in grounding.cards}
    return [by_id[i] for i in dict.fromkeys(source_ids) if i in by_id]


def grounded(response: InsightResponse, cards: Sequence[SourceCard]) -> GroundedInsight:
    return GroundedInsight(**response.model_dump(), cards=list(cards), days=days_of(cards))
