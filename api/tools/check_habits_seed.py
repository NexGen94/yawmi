"""Check `api/db/seed/habits.json` against the acceptance criteria of `GOAL-2031.md`.

    python -I api/tools/check_habits_seed.py --goal "<plan repo>/GOAL-2031.md"

Prints «لا خروق» and exits 0, or one «خرق: ...» line per violation and exits 1:

* a habit's `ac_ref` is not a criterion line (`- [ ] AC7.4: ...`) in the goal file;
* the habit's target disagrees with the number in that line: «285 دقيقة» (a weekly duration),
  «جلستا محادثة» or «مبادرتان» (the Arabic dual: two), «5 أيام من 7» (a weekly boolean: five),
  a weekly boolean with no day count (once a week), a daily boolean (once a day);
* the habit's `outcome` is not the outcome of its criterion (AC7.4 belongs to O7).

Standard library only, so it runs under `-I` without the project installed. Habits without an
`ac_ref` (such as `breathing`) are not tied to a criterion and are skipped.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

DEFAULT_HABITS = Path(__file__).resolve().parents[1] / "db" / "seed" / "habits.json"

_CRITERION = re.compile(r"^\s*-\s*\[[ xX]\]\s*(AC\d+\.\d+)\s*:\s*(.*)$")
_AC_REF = re.compile(r"AC(\d+)\.\d+")
_DAYS_OF_SEVEN = re.compile(r"(\d+)\s*(?:أيام|ايام|يوم)\s*من\s*7")
_MINUTES = re.compile(r"(\d+)\s*(?:دقيقة|دقائق)")
_HOURS = re.compile(r"(\d+)\s*(?:ساعة|ساعات)")
_COUNTED = re.compile(r"(\d+)\s*(?:جلسات|جلسة|مبادرات|مبادرة|مرات|مرة)")
_DUAL = re.compile(r"جلستا|جلستان|جلستين|مبادرتان|مبادرتين|مرتان|مرتين")
_ARABIC_INDIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")


def parse_criteria(goal_text: str) -> dict[str, str]:
    """Map each `- [ ] ACn.m:` line of the goal file to its text (digits normalised to ASCII)."""
    criteria: dict[str, str] = {}
    for line in goal_text.splitlines():
        match = _CRITERION.match(line)
        if match:
            criteria.setdefault(match.group(1), match.group(2).translate(_ARABIC_INDIC_DIGITS))
    return criteria


def expected_targets(habit: dict[str, Any], text: str) -> set[int] | None:
    """The target(s) the criterion text allows for `habit`, or None when no rule applies."""
    kind, period, unit = habit["kind"], habit["period"], habit.get("unit")
    if kind == "boolean" and period == "day":
        return {1}
    if kind == "boolean" and period == "week":
        days = {int(n) for n in _DAYS_OF_SEVEN.findall(text)}
        return days or {1}
    if kind == "duration" and period == "week":
        pattern = _HOURS if unit == "hour" else _MINUTES
        return {int(n) for n in pattern.findall(text)} or None
    if kind == "count" and period == "week":
        found = {int(n) for n in _COUNTED.findall(text)}
        if _DUAL.search(text):
            found.add(2)
        return found or None
    return None


def _shown(number: float) -> str:
    return str(int(number)) if float(number).is_integer() else str(number)


def check(habits: list[dict[str, Any]], goal_text: str) -> list[str]:
    """Every violation, as a «خرق: ...» line; empty when the seed agrees with the goal file."""
    criteria = parse_criteria(goal_text)
    violations: list[str] = []
    for habit in habits:
        code, ac_ref = habit["code"], habit.get("ac_ref")
        if ac_ref is None:
            continue
        ac_match = _AC_REF.fullmatch(ac_ref)
        if ac_match and habit.get("outcome") != f"O{ac_match.group(1)}":
            violations.append(
                f"خرق: {code}: outcome {habit.get('outcome')} لا يطابق معيار {ac_ref}"
            )
        if ac_ref not in criteria:
            violations.append(f"خرق: {code}: ac_ref {ac_ref} غائب (لا سطر `- [ ] {ac_ref}:`)")
            continue
        allowed = expected_targets(habit, criteria[ac_ref])
        target = habit["target_per_period"]
        if allowed is None:
            violations.append(f"خرق: {code}: لا رقم في سطر {ac_ref} يُستخرج منه الهدف")
        elif float(target) not in {float(n) for n in allowed}:
            wanted = " أو ".join(str(n) for n in sorted(allowed))
            violations.append(f"خرق: {code}: الهدف {_shown(target)} يخالف {wanted} في سطر {ac_ref}")
    return violations


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # Arabic output on any console
    parser = argparse.ArgumentParser(description="Check the habits seed against GOAL-2031.md.")
    parser.add_argument("--goal", type=Path, required=True, help="path to GOAL-2031.md")
    parser.add_argument("--habits", type=Path, default=DEFAULT_HABITS, help="habits.json to check")
    args = parser.parse_args(argv)

    try:
        goal_text = args.goal.read_text(encoding="utf-8-sig")
        habits = json.loads(args.habits.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(f"خرق: تعذّرت قراءة الملف: {error}")
        return 1

    violations = check(habits, goal_text)
    if violations:
        print("\n".join(violations))
        return 1
    print("لا خروق")
    return 0


if __name__ == "__main__":
    sys.exit(main())
