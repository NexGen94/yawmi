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

A daily habit counts the scheduled days of the last seven that met its target (for an abstain
habit, the scheduled days without a slip); a weekly or monthly one its current period. No health
metric (`daily_metrics`) is read, so none reaches a provider. Pure but for the reader: no clock.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

from yawmi.ai.cards import SourceCard
from yawmi.ai.consent import Consent
from yawmi.ai.reader import GroundingReader, SessionDay
from yawmi.ai.schema import InsightKind, Source
from yawmi.domain.habits import HabitLog, period_progress
from yawmi.domain.periods import WeekStart, is_scheduled
from yawmi.habits.models import domain_logs
from yawmi.journal.store import JournalRow, MoodRow
from yawmi.prefs.models import SettingsOut
from yawmi.today.assemble import current_cycle, habit_spec, logs_window
from yawmi.today.reader import CycleRow, GoalRow, HabitRow, LogRow, MilestoneRow

Range = Literal["7d", "30d", "cycle"]
RANGE_DAYS = {"7d": 7, "30d": 30}
HABIT_DAYS = 7
MILESTONE_AHEAD_DAYS = 14
MAX_MILESTONES = 12
PERIOD_WORDS = {"day": "الأسبوع", "week": "الأسبوع", "month": "الشهر"}
JOURNAL_LABELS = {"morning": "يومية الصباح", "evening": "يومية المساء"}
JOURNAL_SEPARATOR = " · "


@dataclass
class Grounding:
    context: dict[str, Any]
    sources: list[Source]
    cards: list[SourceCard] = field(default_factory=list)


def span_for(range_: Range, day: date, cycles: Sequence[CycleRow]) -> tuple[date, date]:
    """`7d` is `[day − 6, day]`, `30d` `[day − 29, day]`, `cycle` from the current cycle's start
    (its review week included); without a current cycle `cycle` is `30d`."""
    if range_ == "cycle":
        cycle = current_cycle(day, cycles)
        if cycle is not None:
            return cycle.start_date, day
        range_ = "30d"
    return day - timedelta(days=RANGE_DAYS[range_] - 1), day


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
    scheduled = [d for d in window if is_scheduled(d, spec)]
    trend: list[float | None] = [
        (_day_value(row, by_day.get(d)) if d in scheduled else None) for d in window
    ]
    if row.polarity == "abstain":
        done = float(sum(1 for d in scheduled if not _met(row, by_day.get(d))))
        target = float(len(scheduled))
        trend = [None if v is None else float(v == 0) for v in trend]
    elif row.period == "day":
        done = float(sum(1 for d in scheduled if _met(row, by_day.get(d))))
        target = float(len(scheduled))
    else:
        progress = period_progress(spec, logs, day, week_start)
        done, target = progress.done, progress.target
    word = PERIOD_WORDS.get(row.period, "الأسبوع")
    unit = f"من {_num(target)}"
    text = f"{row.title_ar}: {_num(done)} {unit} هذا {word}"
    b.add(f"habit:{row.code}", "habit", row.title_ar, text, value=done, unit=unit, trend=trend)


# --- goals -------------------------------------------------------------------------------------


def _milestones(b: _Builder, rows: Sequence[MilestoneRow], first: date, day: date) -> None:
    last = day + timedelta(days=MILESTONE_AHEAD_DAYS)
    near = sorted(
        (m for m in rows if m.due_date is not None and first <= m.due_date <= last),
        key=lambda m: (m.due_date, m.page_id),
    )[:MAX_MILESTONES]
    for m in near:
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
) -> Grounding:
    """The context and the sources of one insight of `kind` for `day` over `span`."""
    del kind  # every kind reads the same sources for now; task 19 shapes them per kind
    first, last = span
    b = _Builder()

    habit_first = min(logs_window(day, week_start)[0], day - timedelta(days=HABIT_DAYS - 1))
    logs = _logs_by_habit(await reader.habit_logs(habit_first, day))
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

    context: dict[str, Any] = {
        "span": {"first": first.isoformat(), "last": last.isoformat()},
        "style": {"lines": prefs.ai_lines, "tone": prefs.ai_tone},
    }
    return Grounding(context=context, sources=b.sources, cards=b.cards)


def _logs_by_habit(rows: Sequence[LogRow]) -> dict[str, list[HabitLog]]:
    grouped: dict[str, list[LogRow]] = {}
    for row in rows:
        grouped.setdefault(row.habit_code, []).append(row)
    return {code: domain_logs(group) for code, group in grouped.items()}
