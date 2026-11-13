"""The grounding of an insight, built on the server (design §10, I-7).

The browser sends the question and the range only. `build_grounding` turns stored rows into the
`context` and the citable `sources` the provider receives, and keeps one `SourceCard` per source
so the cited ones can be shown (`yawmi.ai.cards`). Sources, in this order:

| id | kind | text |
|---|---|---|
| `habit:<code>` | `habit` | «{title}: {done} من {target} هذا {الأسبوع}» |
| `ms:<page_id>` | `milestone` | «{title}، موعدها {date}، {منجزة أو مفتوحة}» |
| `goal:<O-code>` | `outcome` | «{title}: {done} من {total} محطة» |
| `journal:<day>:<part>` | `journal` | the words as written |
| `mood:<day>` | `mood` | «المزاج {score} من 5: {feelings}» |
| `focus:<day>` · `breath:<day>` | `focus` · `breath` | minutes and sessions |
| `mission` · `vision` | `mission` · `vision` | the text, only with `personal_text` |

The memory is a block of its own (`Grounding.memory`, the request's `memory`), outside the
sources and outside `MAX_SOURCES` (fix round 1, I-2): its size is bounded by the memory limits
(`MAX_MEMORY_ITEMS` items of `MAX_MEMORY_TEXT` characters), and each text by `MAX_SOURCE_TEXT`.

| id | kind | text |
|---|---|---|
| `note:<id>` | `memory_note` | a note the user saved (active only), citable like a source |
| `rule:<id>` | `standing_rule` | a lens the user wrote (active only) |

«هذا الأسبوع» is the calendar week (`week_start`), for every habit (I-1): a daily habit counts
the scheduled days from the week's first day to `day` that met its target (for an abstain habit,
those without a slip) against the scheduled days of the whole week; a weekly or monthly habit
its current period. A habit with no scheduled day in its period is no source (no «0 من 0»). The
card's `trend` is the last seven days. Milestones: every open one already due, and those due
from the span's start to `day + 14`; at most 12, the nearest to `day`.

Bounds (I-2): a source text longer than `MAX_SOURCE_TEXT` is cut, on a word boundary when one is
near, and ends with «…». Over `MAX_SOURCES` sources, the four day kinds go first and together
(ruling N-1): the oldest day first, and inside a day in `DAY_DROP_ORDER` (journal, mood, focus,
breath; a morning entry before the evening one), so the provider keeps the latest days of every
kind. Only then the others, kind by kind in `DROP_ORDER` (milestones, «رسالتي» and «رؤيتي»,
outcomes, habits last), each in the order it was added. Cards exist only for kept sources and
for the memory block.

No health metric (`daily_metrics`) is read, so none reaches a provider. Pure but for the reader:
no clock.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

from yawmi.ai.cards import SourceCard
from yawmi.ai.consent import Consent
from yawmi.ai.memory import MemoryItem
from yawmi.ai.reader import GroundingReader, SessionDay
from yawmi.ai.schema import InsightKind, Source
from yawmi.domain.habits import HabitLog, period_progress
from yawmi.domain.periods import WeekStart, is_scheduled, period_bounds
from yawmi.journal.store import JournalRow, MoodRow
from yawmi.prefs.models import SettingsOut
from yawmi.today.assemble import current_cycle, habit_spec, logs_by_habit, logs_window
from yawmi.today.reader import CycleRow, GoalRow, HabitRow, MilestoneRow

Range = Literal["7d", "30d", "cycle"]
RANGE_DAYS = {"7d": 7, "30d": 30}
HABIT_DAYS = 7
MILESTONE_AHEAD_DAYS = 14
MAX_MILESTONES = 12
PERIOD_WORDS = {"day": "الأسبوع", "week": "الأسبوع", "month": "الشهر"}
JOURNAL_LABELS = {"morning": "يومية الصباح", "evening": "يومية المساء"}
JOURNAL_SEPARATOR = " · "
MAX_SOURCES = 60
MAX_SOURCE_TEXT = 500
ELLIPSIS = "…"
WORD_CUT_REACH = 60  # cut at the last space if it lies within this many characters of the cap
DAY_DROP_ORDER = ("journal", "mood", "focus", "breath")  # dropped first, oldest day first
DROP_ORDER = (
    "milestone",
    "mission",
    "vision",
    "outcome",
    "habit",
)
MEMORY_KINDS = {"rule": ("standing_rule", "عدسة"), "note": ("memory_note", "ملاحظة محفوظة")}


@dataclass
class Grounding:
    context: dict[str, Any]
    sources: list[Source]
    cards: list[SourceCard] = field(default_factory=list)
    memory: list[Source] = field(default_factory=list)


def span_for(range_: Range, day: date, cycles: Sequence[CycleRow]) -> tuple[date, date]:
    """`7d` is `[day − 6, day]`, `30d` `[day − 29, day]`, `cycle` from the current cycle's start
    (its review week included); without a current cycle `cycle` is `30d`."""
    if range_ == "cycle":
        cycle = current_cycle(day, cycles)
        if cycle is not None:
            return cycle.start_date, day
        range_ = "30d"
    return day - timedelta(days=RANGE_DAYS[range_] - 1), day


def clip(text: str) -> str:
    """`text` cut to `MAX_SOURCE_TEXT` characters ending with «…» when longer."""
    if len(text) <= MAX_SOURCE_TEXT:
        return text
    cut = text[: MAX_SOURCE_TEXT - len(ELLIPSIS)]
    space = cut.rfind(" ")
    if space >= len(cut) - WORD_CUT_REACH:
        cut = cut[:space].rstrip()
    return cut + ELLIPSIS


def _num(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


class _Builder:
    def __init__(self) -> None:
        self.sources: list[Source] = []
        self.cards: list[SourceCard] = []

    def add(
        self,
        source_id: str,
        kind: str,
        label: str,
        text: str,
        *,
        value: float | None = None,
        unit: str | None = None,
        trend: list[float | None] | None = None,
        day: date | None = None,
    ) -> None:
        text = clip(text)
        self.sources.append(Source(id=source_id, kind=kind, text=text))
        self.cards.append(
            SourceCard(
                source_id=source_id,
                kind=kind,
                label=label,
                value=value,
                unit=unit,
                text=text,
                trend=trend or [],
                day=day,
            )
        )

    def _drop_key(self, i: int) -> tuple[int, date, int, int]:
        """Earlier sorts first, so it is dropped first."""
        kind, day = self.sources[i].kind, self.cards[i].day
        if kind in DAY_DROP_ORDER and day is not None:
            return (0, day, DAY_DROP_ORDER.index(kind), i)
        rank = DROP_ORDER.index(kind) if kind in DROP_ORDER else len(DROP_ORDER)
        return (1, date.min, rank, i)

    def bounded(self) -> tuple[list[Source], list[SourceCard]]:
        """At most `MAX_SOURCES`: the day sources first by day, then `DROP_ORDER`; the rest keep
        their order."""
        excess = len(self.sources) - MAX_SOURCES
        if excess <= 0:
            return self.sources, self.cards
        order = sorted(range(len(self.sources)), key=self._drop_key)
        dropped = set(order[:excess])
        keep = [i for i in range(len(self.sources)) if i not in dropped]
        return [self.sources[i] for i in keep], [self.cards[i] for i in keep]


# --- habits ------------------------------------------------------------------------------------


def _met(row: HabitRow, log: HabitLog | None) -> bool:
    """Whether a day's log reached a daily habit's target (a slip, for an abstain habit)."""
    if log is None or log.status != "done":
        return False
    if row.kind == "boolean":
        return True
    return (log.value or 0) >= float(row.target_per_period)


def _day_value(row: HabitRow, log: HabitLog | None) -> float:
    if log is None or log.status != "done":
        return 0.0
    return 1.0 if row.kind == "boolean" else float(log.value or 0)


def _habit(
    b: _Builder, row: HabitRow, logs: list[HabitLog], day: date, week_start: WeekStart
) -> None:
    spec = habit_spec(row)
    by_day = {log.day: log for log in logs}
    window = [day - timedelta(days=n) for n in range(HABIT_DAYS - 1, -1, -1)]
    trend: list[float | None] = [
        (_day_value(row, by_day.get(d)) if is_scheduled(d, spec) else None) for d in window
    ]
    if row.polarity == "abstain" or row.period == "day":
        week_first, week_last = period_bounds(day, "week", week_start)
        week = [week_first + timedelta(days=n) for n in range((week_last - week_first).days + 1)]
        scheduled = [d for d in week if is_scheduled(d, spec)]
        elapsed = [d for d in scheduled if d <= day]
        if row.polarity == "abstain":
            done = float(sum(1 for d in elapsed if not _met(row, by_day.get(d))))
            trend = [None if v is None else float(v == 0) for v in trend]
        else:
            done = float(sum(1 for d in elapsed if _met(row, by_day.get(d))))
        target = float(len(scheduled))
    else:
        progress = period_progress(spec, logs, day, week_start)
        done, target = progress.done, progress.target
    if target <= 0:
        return  # nothing scheduled in the period: «0 من 0» says nothing
    word = PERIOD_WORDS.get(row.period, "الأسبوع")
    unit = f"من {_num(target)}"
    text = f"{row.title_ar}: {_num(done)} {unit} هذا {word}"
    b.add(f"habit:{row.code}", "habit", row.title_ar, text, value=done, unit=unit, trend=trend)


# --- goals -------------------------------------------------------------------------------------


def _milestones(b: _Builder, rows: Sequence[MilestoneRow], first: date, day: date) -> None:
    last = day + timedelta(days=MILESTONE_AHEAD_DAYS)
    dated = [m for m in rows if m.due_date is not None]
    chosen = [
        m
        for m in dated
        if (not m.done and m.due_date < day) or first <= m.due_date <= last  # type: ignore[operator]
    ]
    nearest = sorted(
        chosen,
        key=lambda m: (abs((m.due_date - day).days), m.due_date, m.page_id),  # type: ignore[operator]
    )[:MAX_MILESTONES]
    for m in sorted(nearest, key=lambda m: (m.due_date, m.page_id)):  # type: ignore[arg-type, return-value]
        state = "منجزة" if m.done else "مفتوحة"
        text = f"{m.title}، موعدها {m.due_date.isoformat()}، {state}"  # type: ignore[union-attr]
        b.add(f"ms:{m.page_id}", "milestone", m.title, text)


def _outcomes(b: _Builder, goals: Sequence[GoalRow], rows: Sequence[MilestoneRow]) -> None:
    for goal in sorted(goals, key=lambda g: (len(g.code), g.code)):
        mine = [m for m in rows if m.outcome_code == goal.code]
        if not mine:
            continue
        done = sum(1 for m in mine if m.done)
        unit = f"من {len(mine)}"
        text = f"{goal.title}: {done} {unit} محطة"
        b.add(f"goal:{goal.code}", "outcome", goal.title, text, value=float(done), unit=unit)


# --- the days ----------------------------------------------------------------------------------


def journal_text(answers: dict[str, Any]) -> str:
    """The words of a journal entry as written, in the order of the form."""
    words: list[str] = []
    for p in answers.get("priorities") or []:
        if isinstance(p, dict) and isinstance(p.get("title"), str):
            words.append(p["title"])
    for key in ("enthusiasm", "win", "learned"):
        if isinstance(answers.get(key), str):
            words.append(answers[key])
    words.extend(g for g in answers.get("gratitude") or [] if isinstance(g, str))
    if isinstance(answers.get("note"), str):
        words.append(answers["note"])
    return JOURNAL_SEPARATOR.join(w.strip() for w in words if w and w.strip())


def _journal(b: _Builder, entries: Sequence[JournalRow]) -> None:
    for e in sorted(entries, key=lambda e: (e.day, e.part != "morning")):
        text = journal_text(e.answers)
        if text:
            label = JOURNAL_LABELS.get(e.part, e.part)
            b.add(f"journal:{e.day.isoformat()}:{e.part}", "journal", label, text, day=e.day)


def _moods(b: _Builder, moods: Sequence[MoodRow]) -> None:
    for m in sorted(moods, key=lambda m: m.day):
        text = f"المزاج {m.score} من 5"
        if m.feelings:
            text += ": " + "، ".join(m.feelings)
        b.add(
            f"mood:{m.day.isoformat()}", "mood", "المزاج", text,
            value=float(m.score), unit="من 5", day=m.day,
        )  # fmt: skip


def _sessions(b: _Builder, kind: str, label: str, days: Sequence[SessionDay]) -> None:
    for s in sorted(days, key=lambda s: s.day):
        minutes = round(s.minutes)
        text = f"{label}: {minutes} دقيقة في {s.sessions} جلسة"
        b.add(
            f"{kind}:{s.day.isoformat()}", kind, label, text,
            value=float(minutes), unit="دقيقة", day=s.day,
        )  # fmt: skip


# --- the whole ---------------------------------------------------------------------------------


async def build_grounding(
    kind: InsightKind,
    day: date,
    span: tuple[date, date],
    reader: GroundingReader,
    prefs: SettingsOut,
    consent: Consent,
    week_start: WeekStart = "sun",
    memory: Sequence[MemoryItem] = (),
) -> Grounding:
    """The context and the sources of one insight of `kind` for `day` over `span`. Every kind
    reads the same sources over its span (the routes choose the span); the active `memory` items
    (lenses and saved notes) go with every kind, as their own block."""
    del kind
    first, last = span
    b = _Builder()

    habit_first = min(logs_window(day, week_start)[0], day - timedelta(days=HABIT_DAYS - 1))
    logs = logs_by_habit(await reader.habit_logs(habit_first, day))
    for row in await reader.habits(day):
        _habit(b, row, logs.get(row.code, []), day, week_start)

    milestones = await reader.milestones()
    _milestones(b, milestones, first, day)
    _outcomes(b, await reader.goals(), milestones)

    _journal(b, await reader.journal(first, last))
    _moods(b, await reader.moods(first, last))
    _sessions(b, "focus", "التركيز", await reader.focus_days(first, last))
    _sessions(b, "breath", "التنفّس", await reader.breath_days(first, last))

    if consent.personal_text:
        if prefs.mission.strip():
            b.add("mission", "mission", "رسالتي", prefs.mission.strip())
        if prefs.vision.strip():
            b.add("vision", "vision", "رؤيتي", prefs.vision.strip())

    block: list[Source] = []
    memory_cards: list[SourceCard] = []
    for item in memory:
        if item.active:
            source_kind, label = MEMORY_KINDS[item.kind]
            text = clip(item.text)
            source_id = f"{item.kind}:{item.id}"
            block.append(Source(id=source_id, kind=source_kind, text=text))
            memory_cards.append(
                SourceCard(
                    source_id=source_id,
                    kind=source_kind,
                    label=label,
                    value=None,
                    unit=None,
                    text=text,
                    trend=[],
                    day=None,
                )
            )

    context: dict[str, Any] = {
        "span": {"first": first.isoformat(), "last": last.isoformat()},
        "style": {"lines": prefs.ai_lines, "tone": prefs.ai_tone},
    }
    sources, cards = b.bounded()
    return Grounding(context=context, sources=sources, cards=[*cards, *memory_cards], memory=block)
