"""API shapes of the goals read model (design §7.4 and §7.6).

`GoalsOut` is the whole picture of the plan: outcomes, cycles, milestones and cards, read from
the Notion mirror (`raqib.*`) with the habits, tasks and indicators of this service laid over
them, and the goal edits over the mirror's values (design §11): `pending` names the fields of a
page whose shown value is a pending edit, and `pending_edits` counts the pending edits. The mirror
is empty until the Notion sync is deployed: every list is then empty and `synced_at` is `null`.
"""

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from yawmi.habits.models import Day, Title
from yawmi.today.assemble import CardHabit, MilestoneOut

IndicatorSource = Literal["milestones", "linked_habits", "tasks"]
IndicatorDisplay = Literal["ring", "bar", "number", "sparkline"]


class GoalIndicatorValue(BaseModel):
    """The indicator of an outcome or a card, computed (design §9.3).

    `value` and `target` are the numbers the display shows («2 من 5»): done and total for
    milestones and tasks (a stored target replaces the total), a percentage of 100 for linked
    habits. `completion` is 0 to 1. Both are `null` when there is nothing to measure yet.
    """

    source: IndicatorSource
    value: float | None
    target: float | None
    completion: float | None
    display: IndicatorDisplay = "ring"
    custom: bool = Field(default=False, description="مخزَّن بتخصيص من المستخدم لا افتراضي")


class KpiLatest(BaseModel):
    day: date
    value: float


class KpiOut(BaseModel):
    code: str
    name: str
    unit: str
    direction: str
    target: float | None
    frequency: str
    latest: KpiLatest | None


class CycleOut(BaseModel):
    cycle_no: int
    stage_no: int
    start_date: date
    end_date: date
    review_start: date
    review_end: date
    theme: str
    gate: str


class MilestoneFull(BaseModel):
    page_id: str
    title: str
    outcome_code: str | None
    card_page_ids: list[str]
    cycle_no: int | None
    due_date: date | None
    done: bool
    criterion: str | None
    evidence: str | None
    notion_edited_at: datetime | None
    overdue_days: int | None = Field(description="أيام التأخر عن الموعد لمحطة مفتوحة فات موعدها")
    pending: list[str] = Field(description="الحقول التي قيمتها المعروضة تعديل معلّق")


class CardFull(BaseModel):
    page_id: str
    title: str
    status: str | None
    outcome_codes: list[str]
    target_date: date | None = Field(description="من خاصية «المستهدف» في Notion إن كانت تاريخاً")
    next_step: str | None = Field(description="من خاصية «الخطوة التالية» في Notion")
    notion_edited_at: datetime | None
    habits: list[CardHabit]
    habits_adherence_avg: float | None
    milestones_total: int
    milestones_done: int
    tasks_total: int
    tasks_done: int
    indicator: GoalIndicatorValue
    pending: list[str] = Field(description="الحقول التي قيمتها المعروضة تعديل معلّق")


class GoalOutcome(BaseModel):
    code: str
    title: str
    track: str
    target_date: date
    acceptance: str
    status: str
    milestones_total: int
    milestones_done: int
    milestones_due: int = Field(description="محطاتها التي حان موعدها حتى اليوم")
    completion: float | None = Field(description="المحطات المنجزة ÷ كلها، أو null بلا محطات")
    next_milestone: MilestoneOut | None
    habits: list[CardHabit]
    indicator: GoalIndicatorValue
    kpis: list[KpiOut]


class GoalsOut(BaseModel):
    outcomes: list[GoalOutcome]
    cycles: list[CycleOut]
    milestones: list[MilestoneFull]
    cards: list[CardFull]
    synced_at: datetime | None = Field(description="آخر مزامنة لمرآة Notion، أو null إن كانت فارغة")
    pending_edits: int = Field(description="عدد التعديلات المعلّقة التي لم تصل Notion")


class PaceReading(BaseModel):
    day: date
    value: float


class PaceOut(BaseModel):
    """The pace line of an outcome (design §9.4); `days_left` is negative after the due day."""

    basis: Literal["kpi", "milestones"]
    kpi_code: str | None
    unit: str | None
    start_day: date
    start_value: float
    due_day: date
    target_value: float
    today: date
    current_value: float | None
    expected_today: float
    projected_end: float | None
    on_pace: bool | None
    days_left: int
    readings: list[PaceReading]


class GoalTaskIn(BaseModel):
    """A task of a goal: the user's own small list, not a Notion page (design §13.1, ruling 2)."""

    model_config = ConfigDict(extra="forbid")

    title: Title
    due_day: Day | None = None


class GoalTaskPatch(BaseModel):
    """The fields to change, at least one. `due_day: null` clears the due day. No deletion:
    `archived` closes a task, and an archived task leaves the totals."""

    model_config = ConfigDict(extra="forbid")

    title: Title = None  # type: ignore[assignment]
    due_day: Day | None = None
    done: StrictBool = None  # type: ignore[assignment]
    archived: StrictBool = None  # type: ignore[assignment]
    position: StrictInt = Field(default=None, ge=0, le=100_000)  # type: ignore[assignment]


class GoalTaskOut(BaseModel):
    id: UUID
    goal_ref: str
    title: str
    due_day: date | None
    done_at: datetime | None
    position: int
    archived: bool


class GoalTaskList(BaseModel):
    items: list[GoalTaskOut]
