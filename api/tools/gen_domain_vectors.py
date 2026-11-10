"""مولّد متجهات النطاق المشتركة `contracts/domain-vectors/v1/*.json`.

    uv run python -I tools/gen_domain_vectors.py            # من api/: يكتب الملفات المختلفة
    uv run python -I tools/gen_domain_vectors.py --check    # لا يكتب؛ يفشل عند أي فرق
    uv run python -I tools/gen_domain_vectors.py --init     # يسمح بإنشاء ملف ملتزَم مفقود

المدخلات من `vector_cases.py`، و`expect` يُحسب من التنفيذ المرجعي (`yawmi.domain.days` و
`periods` و`habits` و`scores`) وحده؛ لا قيمة تُكتب يدوياً. الملفات بمفاتيح مرتبة ومسافتين
وUTF-8 وLF وسطر أخير فارغ. مجلد الإخراج ثابت من موقع هذا الملف ولا يُمرَّر من سطر الأوامر؛
الاختبارات تمرّره إلى `generate()` و`main()` برمجياً.

الحارس (يعمل في الوضعين، ويفحص الملفات الأربعة عشر كلها قبل أن يكتب أيّها): يفشل إن:
- غاب ملف ملتزَم (خط الأساس) ولم يُطلب `--init`؛
- حُذف معرّف ملتزَم من `vector_cases.py`؛
- تغيّر `input` لمعرّف ملتزَم؛
- تغيّر `expect` (أو `tol`) لمعرّف ملتزَم و`RULES_VERSION` لم يُرفع فوق ما في الملف؛
- خالف ناتجٌ قيمةً مثبّتة (`pin`) من المواصفة.

الكتابة ذرّية: ملف مؤقت بجوار الهدف ثم استبدال، فلا يبقى ملف مكتوب جزئياً.

`sys.path.insert` أدناه لازم: السكربت يُشغَّل بـ`-I` (مجلد السكربت لا يُضاف إلى `sys.path`)
و`tools/` ليس حزمة مثبّتة، فبدونه لا يُستورد `vector_cases`. المسار مشتق من `__file__` لا من
أي مدخل خارجي.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import vector_cases
from vector_cases import CASES, FUNCTIONS, RULES_VERSION, Case

from yawmi.domain import scores
from yawmi.domain.days import day_key
from yawmi.domain.habits import (
    HabitLog,
    HabitSpec,
    adherence,
    challenge_progress,
    goal_prefill,
    period_progress,
    streak,
    strength,
)
from yawmi.domain.periods import end_day, is_scheduled, period_bounds

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "contracts" / "domain-vectors" / "v1"


class VectorError(Exception):
    """خرق لقاعدة ثبات المتجهات."""


# ---------------------------------------------------------------- فك المدخلات


def _date(value: str | None) -> date | None:
    return None if value is None else date.fromisoformat(value)


def _spec(raw: dict[str, Any]) -> HabitSpec:
    return HabitSpec(
        kind=raw["kind"],
        unit=raw["unit"],
        target_per_period=float(raw["target_per_period"]),
        period=raw["period"],
        schedule_kind=raw["schedule_kind"],
        weekday_mask=raw["weekday_mask"],
        every_n=raw["every_n"],
        anchor_day=_date(raw["anchor_day"]),
        start_day=date.fromisoformat(raw["start_day"]),
        end_day=_date(raw["end_day"]),
    )


def _logs(raw: list[dict[str, Any]]) -> list[HabitLog]:
    return [
        HabitLog(
            day=date.fromisoformat(log["day"]),
            value=None if log["value"] is None else float(log["value"]),
            status=log["status"],
        )
        for log in raw
    ]


def _habit_args(inp: dict[str, Any]) -> tuple[HabitSpec, list[HabitLog], date, str]:
    return (
        _spec(inp["habit"]),
        _logs(inp["logs"]),
        date.fromisoformat(inp["today"]),
        inp["week_start"],
    )


# ---------------------------------------------------------------- تطبيق المرجع


def _encode(value: Any) -> Any:
    """ناتج المرجع إلى JSON: التواريخ نصوص ISO، وفئات البيانات كائنات، والأزواج (start, end) كائن."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise VectorError(f"ناتج غير منتهٍ: {value!r}")
        return value
    if isinstance(value, date):
        return value.isoformat()
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: _encode(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, tuple) and len(value) == 2 and all(isinstance(v, date) for v in value):
        return {"start": value[0].isoformat(), "end": value[1].isoformat()}
    raise VectorError(f"ناتج لا يُرمَّز: {value!r}")


def apply(function: str, inp: dict[str, Any]) -> Any:
    """يطبّق الدالة المرجعية على مدخلات حالة ويعيد قيمة `expect.value` بصيغة JSON."""
    match function:
        case "day_key":
            instant = datetime.fromisoformat(inp["instant"])
            result: Any = day_key(instant, inp["tz"])
        case "period_bounds":
            result = period_bounds(date.fromisoformat(inp["day"]), inp["period"], inp["week_start"])
        case "is_scheduled":
            result = is_scheduled(date.fromisoformat(inp["day"]), _spec(inp["habit"]))
        case "end_day":
            result = end_day(date.fromisoformat(inp["start"]), inp["duration_days"])
        case "period_progress":
            result = period_progress(*_habit_args(inp))
        case "strength":
            result = strength(*_habit_args(inp))
        case "streak":
            result = streak(*_habit_args(inp))
        case "challenge_progress":
            result = challenge_progress(*_habit_args(inp))
        case "adherence":
            result = adherence(*_habit_args(inp))
        case "goal_prefill":
            result = goal_prefill(
                float(inp["goal_target"]),
                float(inp["current"]),
                date.fromisoformat(inp["today"]),
                date.fromisoformat(inp["deadline"]),
                inp["period"],
                inp["week_start"],
            )
        case "baseline":
            result = scores.baseline([float(v) for v in inp["values"]], log=inp["log"])
        case "recovery":
            result = scores.recovery(
                float(inp["z_hrv"]),
                float(inp["z_rhr"]),
                float(inp["z_sleep"]),
                float(inp["penalty"]),
            )
        case "trimp":
            result = scores.trimp(
                float(inp["minutes"]), float(inp["hr_reserve"]), female=inp["female"]
            )
        case "strain":
            result = scores.strain(float(inp["trimp_total"]))
        case _:
            raise VectorError(f"دالة غير معروفة: {function!r}")
    return _encode(result)


# ---------------------------------------------------------------- قاعدة المقارنة


def close(actual: Any, expect: Any, tol: float) -> bool:
    """قاعدة المقارنة في الاتفاق: تطابق تام للصحيحة والنصوص والمنطقية وnull، و`|Δ| ≤ tol` للكسور.

    الصحيح لا يقبل كسراً ولا منطقياً، والكسر يقبل صحيحاً ضمن الهامش ولا يقبل منطقياً. الكائنات
    بالمفاتيح نفسها وكل حقل بقاعدته، والمصفوفات بالطول نفسه عنصراً عنصراً.
    """
    if isinstance(expect, bool) or expect is None or isinstance(expect, str):
        return type(actual) is type(expect) and actual == expect
    if isinstance(actual, bool):
        return False
    if isinstance(expect, int):
        return isinstance(actual, int) and actual == expect
    if isinstance(expect, float):
        return isinstance(actual, (int, float)) and abs(actual - expect) <= tol
    if isinstance(expect, dict):
        return (
            isinstance(actual, dict)
            and actual.keys() == expect.keys()
            and all(close(actual[k], expect[k], tol) for k in expect)
        )
    if isinstance(expect, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expect)
            and all(close(a, e, tol) for a, e in zip(actual, expect, strict=True))
        )
    return False


# ---------------------------------------------------------------- البناء


def _case_doc(function: str, case: Case) -> dict[str, Any]:
    value = apply(function, case.input)
    if case.pin is not None:
        pinned, tol = case.pin
        if not close(value, pinned, tol):
            raise VectorError(
                f"{case.id}: الناتج {value!r} يخالف القيمة المثبّتة {pinned!r} (±{tol})"
            )
    doc: dict[str, Any] = {
        "id": case.id,
        "input": case.input,
        "expect": {"value": value},
        "source": case.source,
    }
    if case.tol is not None:
        doc["tol"] = case.tol
    return doc


def build(function: str) -> dict[str, Any]:
    """محتوى ملف دالة واحدة (قبل التحويل إلى نص)."""
    return {
        "rulesVersion": RULES_VERSION,
        "function": function,
        "cases": [_case_doc(function, case) for case in CASES[function]],
    }


def render(doc: dict[str, Any]) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, allow_nan=False)


# ---------------------------------------------------------------- الحارس


def _guard(function: str, old: dict[str, Any], new: dict[str, Any]) -> None:
    """يرفع `VectorError` إن خالف الملف الجديد قاعدة الثبات تجاه الملف الملتزَم."""
    old_version = old.get("rulesVersion", 0)
    if new["rulesVersion"] < old_version:
        raise VectorError(
            f"{function}: rulesVersion {new['rulesVersion']} أقل من الملتزَم {old_version}"
        )
    old_cases = {case["id"]: case for case in old.get("cases", [])}
    new_cases = {case["id"]: case for case in new["cases"]}
    for case_id in old_cases:
        if case_id not in new_cases:
            raise VectorError(f"{function}: حُذف معرّف ملتزَم {case_id}")
    for case_id, case in new_cases.items():
        committed = old_cases.get(case_id)
        if committed is None:
            continue
        if _canonical(committed["input"]) != _canonical(case["input"]):
            raise VectorError(f"{case_id}: تغيّر input لمعرّف ملتزَم")
        same_expect = _canonical(committed["expect"]) == _canonical(
            case["expect"]
        ) and committed.get("tol") == case.get("tol")
        if not same_expect and new["rulesVersion"] <= old_version:
            raise VectorError(
                f"{case_id}: تغيّر expect دون رفع rulesVersion (الملتزَم {old_version})"
            )


def _plan(out_dir: Path, init: bool) -> list[tuple[Path, bytes]]:
    """يبني الملفات الأربعة عشر ويحرسها كلها، ويعيد ما يختلف عن الملتزَم `(المسار, النص)`."""
    pending: list[tuple[Path, bytes]] = []
    for function in FUNCTIONS:
        path = out_dir / f"{function}.json"
        new_doc = json.loads(render(build(function)))  # مرور بـJSON لتوحيد الأعداد
        text = render(new_doc).encode("utf-8")
        if path.exists():
            _guard(function, json.loads(path.read_text(encoding="utf-8")), new_doc)
            if path.read_bytes() == text:
                continue
        elif not init:
            raise VectorError(f"{path.name}: لا ملف ملتزَم في {out_dir} (استعمل --init لإنشائه)")
        pending.append((path, text))
    return pending


def _write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_bytes(data)
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def generate(out_dir: Path = DEFAULT_OUT, check: bool = False, init: bool = False) -> list[str]:
    """يحرس الملفات الأربعة عشر ثم يكتب المختلف منها (أو يبلّغ عنه في `check`). يعيد أسماءها.

    `init` يسمح بإنشاء ملف ملتزَم مفقود (المجلد أول مرة، أو ملف دالة جديدة)؛ بدونه الملف المفقود
    خط أساس محذوف فيفشل. الحارس يكتمل على كل الملفات قبل أول كتابة، والكتابة ذرّية.
    """
    pending = _plan(out_dir, init)
    if not check and pending:
        out_dir.mkdir(parents=True, exist_ok=True)
        for path, text in pending:
            _write_atomic(path, text)
    return [path.name for path, _ in pending]


def main(argv: list[str] | None = None, out_dir: Path = DEFAULT_OUT) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="لا يكتب؛ يفشل إن اختلف أي ملف")
    mode.add_argument("--init", action="store_true", help="يسمح بإنشاء ملف ملتزَم مفقود")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(
            encoding="utf-8", errors="replace"
        )  # الرسائل عربية ولو كانت الطرفية cp1252
    try:
        changed = generate(out_dir, check=args.check, init=args.init)
    except VectorError as exc:
        print(f"خرق: {exc}")
        return 1
    total = sum(len(cases) for cases in CASES.values())
    if args.check:
        if changed:
            print("ملفات مختلفة عن المولّد: " + ", ".join(changed))
            return 1
        print(
            f"المتجهات مطابقة: {len(FUNCTIONS)} ملفاً و{total} حالة (rulesVersion {RULES_VERSION})"
        )
        return 0
    if changed:
        print("كُتبت: " + ", ".join(changed))
    else:
        print("لا تغيير")
    print(f"{len(FUNCTIONS)} ملفاً و{total} حالة (rulesVersion {RULES_VERSION}) في {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())


__all__ = [
    "FUNCTIONS",
    "RULES_VERSION",
    "VectorError",
    "apply",
    "build",
    "close",
    "generate",
    "main",
    "render",
    "vector_cases",
]
