"""The offline eval set `api/eval/cases.jsonl` (design §10): 44 cases, 14 of them for Task 19.

The cases are read as the promptfoo run reads them, and the assertion module
(`promptfoo_support.js`) is driven offline with canned replies: each new case passes with a reply
that keeps its rules, and each new check rejects the reply it guards against. No model is called.
"""

import json
import shutil
import subprocess
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from yawmi.ai.schema import InsightRequest, Source

EVAL_DIR = Path(__file__).resolve().parents[1] / "eval"
CASE_KEYS = {"id", "kind", "context", "sources", "must_pass"}  # every case has these
OPTIONAL_KEYS = {"question"}  # and an `ask` case its question
NEW_IDS = {
    "morning": ["M09", "M10", "M11"],
    "weekly": ["W06", "W07", "W08"],
    "deeper": ["D01", "D02", "D03"],
    "range": ["R01", "R02"],
    "lens": ["L01", "L02"],
    "one_line": ["S01"],
}
NEEDS_NODE = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


def load_cases() -> list[dict[str, Any]]:
    text = (EVAL_DIR / "cases.jsonl").read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def by_id() -> dict[str, dict[str, Any]]:
    return {c["id"]: c for c in load_cases()}


def check_names(case: dict[str, Any]) -> set[str]:
    return {m if isinstance(m, str) else m["check"] for m in case["must_pass"]}


def test_the_eval_set_has_44_lines_with_unique_ids() -> None:
    cases = load_cases()
    assert len(cases) == 44
    assert len({c["id"] for c in cases}) == 44
    assert {c["kind"] for c in cases} == {"morning", "evening", "weekly", "ask", "deeper"}


def test_every_case_is_well_formed_with_the_keys_of_the_existing_cases() -> None:
    for case in load_cases():
        assert CASE_KEYS <= set(case) <= CASE_KEYS | OPTIONAL_KEYS, case["id"]
        request = InsightRequest(
            kind=case["kind"],
            day=date(2026, 11, 10),
            context=case["context"],
            sources=[Source.model_validate(s) for s in case["sources"]],
            question=case.get("question"),
        )
        assert request.kind == case["kind"]
        assert case["must_pass"], case["id"]
        assert len({s["id"] for s in case["sources"]}) == len(case["sources"]), case["id"]


def test_the_fourteen_new_cases_cover_what_the_design_lists() -> None:
    cases = by_id()
    new = [i for ids in NEW_IDS.values() for i in ids]
    assert len(new) == 14
    assert set(new) <= set(cases)
    for i in NEW_IDS["morning"]:
        assert cases[i]["kind"] == "morning"
        assert "max_three_priorities" in check_names(cases[i])
    for i in NEW_IDS["weekly"]:
        case = cases[i]
        assert case["kind"] == "weekly"
        assert sum(1 for s in case["sources"] if s["id"].startswith("journal:")) >= 2
        assert "recurring_theme" in check_names(case)
    for i in NEW_IDS["deeper"]:
        assert cases[i]["kind"] == "deeper"
        assert "deeper_shape" in check_names(cases[i])
    spans = [cases[i]["context"]["span"] for i in NEW_IDS["range"]]
    assert all(cases[i]["kind"] == "ask" and cases[i]["question"] for i in NEW_IDS["range"])
    lengths = {(date.fromisoformat(s["last"]) - date.fromisoformat(s["first"])).days for s in spans}
    assert len(lengths) == 2 and min(lengths) >= 29  # a 30-day range and a cycle
    lenses = [cases[i] for i in NEW_IDS["lens"]]
    for case in lenses:
        assert any(s["kind"] == "standing_rule" for s in case["sources"]), case["id"]
    assert sum(1 for c in lenses if "refuses_advice" in check_names(c)) == 1
    assert "lens_not_cited" in check_names(cases["L01"])
    [one] = NEW_IDS["one_line"]
    assert cases[one]["context"]["style"]["lines"] == 1
    assert "max_one_line" in check_names(cases[one])


def node(script: str, data: Any) -> Any:
    module = str(EVAL_DIR / "promptfoo_support.js")
    done = subprocess.run(
        ["node", "-e", script, module],
        input=json.dumps(data, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(done.stdout)


RUN = (
    "const m = require(process.argv[1]);"
    "let data = '';"
    "process.stdin.on('data', d => data += d);"
    "process.stdin.on('end', () => {"
    "  const items = JSON.parse(data);"
    "  console.log(JSON.stringify(items.map(i => m.runChecks(i.output, i.context))));"
    "});"
)


def run_checks(case: dict[str, Any], reply: dict[str, Any], checks: list[Any] | None = None) -> Any:
    request = {
        "context": case["context"],
        "sources": case["sources"],
        "question": case.get("question"),
    }
    context = {"config": {"checks": checks or case["must_pass"], "request": request}}
    output = json.dumps(reply, ensure_ascii=False)
    return node(RUN, [{"output": output, "context": context}])[0]


@NEEDS_NODE
def test_every_check_a_case_names_exists() -> None:
    names = node("console.log(JSON.stringify(Object.keys(require(process.argv[1]).CHECKS)))", None)
    used = set().union(*(check_names(c) for c in load_cases()))
    assert used <= set(names)


def reply(lines: list[str], ids: list[str], **extra: Any) -> dict[str, Any]:
    return {"lines": lines, "question": None, "source_ids": ids, "priorities": [], **extra}


def prio(title: str, source_id: str) -> dict[str, str]:
    return {"title": title, "source_id": source_id}


# One reply per new case that keeps every rule the case asserts.
GOOD: dict[str, dict[str, Any]] = {
    "M09": reply(
        [
            "محطة تسليم مسودة التقرير فات موعدها 2026-11-08 وما زالت مفتوحة.",
            "المشي: 2 من 7 هذا الأسبوع.",
        ],
        ["ms:draft", "habit:walk"],
        priorities=[
            prio("تسليم مسودة التقرير", "ms:draft"),
            prio("جلسة المشي", "habit:walk"),
            prio("درس من دروس الإنجليزية", "goal:O7"),
        ],
    ),
    "M10": reply(
        ["القراءة: 0 من 5 هذا الأسبوع.", "اختبار المستوى موعده 2026-11-12."],
        ["habit:read", "ms:level"],
        priorities=[prio("التحضير لاختبار المستوى", "ms:level"), prio("جلسة قراءة", "habit:read")],
    ),
    "M11": reply(
        ["محطة ملف المشروع موعدها 2026-11-11 وهي مفتوحة.", "التركيز أمس: 50 دقيقة."],
        ["ms:portfolio", "focus:2026-11-09"],
        priorities=[prio("إكمال ملف المشروع", "ms:portfolio")],
    ),
    "W06": reply(
        ["السهر أمام الشاشة تكرر في ثلاث يوميات.", "النوم المبكر: 2 من 7 هذا الأسبوع."],
        [
            "journal:2026-11-02:evening",
            "journal:2026-11-04:evening",
            "journal:2026-11-06:morning",
            "habit:sleep",
        ],
        priorities=[prio("إطفاء الشاشات قبل النوم", "journal:2026-11-04:evening")],
    ),
    "W07": reply(
        ["الاجتماعات تكررت في يوميتين بوصفها ما أخذ الصباح.", "التركيز: 3 من 5 هذا الأسبوع."],
        ["journal:2026-11-01:evening", "journal:2026-11-05:evening", "habit:focus"],
    ),
    "W08": reply(
        ["المشي مع الأسرة تكرر في يوميتين.", "المشي: 6 من 7 هذا الأسبوع، والمشي العائلي سببه."],
        ["journal:2026-11-03:evening", "journal:2026-11-07:evening", "habit:walk"],
        priorities=[prio("موعد ثابت للمشي العائلي", "journal:2026-11-07:evening")],
    ),
    "D01": reply(
        [],
        ["journal:2026-11-10:evening"],
        question="ما الذي جعل إنهاء العرض ممكناً رغم ضيق الوقت؟",
        priorities=[
            prio("ما الذي كاد يؤخر العرض اليوم؟", "journal:2026-11-10:evening"),
            prio("أي جزء من العرض يستحق المراجعة؟", "journal:2026-11-10:evening"),
            prio("ما الخطوة التالية بعد العرض؟", "habit:walk"),
        ],
    ),
    "D02": reply(
        [],
        ["journal:2026-11-10:evening"],
        question="ما الذي جعل المساء متوتراً بعد المكالمة؟",
        priorities=[
            prio("ما الذي خفف التوتر ولو قليلاً؟", "journal:2026-11-10:evening"),
            prio("أي جزء من المكالمة بقي في البال؟", "journal:2026-11-10:evening"),
        ],
    ),
    "D03": reply(
        [],
        ["journal:2026-11-09:evening", "focus:2026-11-09"],
        question="ما الذي ساعد على جلسة التركيز الطويلة أمس؟",
        priorities=[
            prio("ما الذي يقطع التركيز عادة؟", "focus:2026-11-09"),
            prio("أي وقت أنسب لجلسة الغد؟", "journal:2026-11-09:evening"),
        ],
    ),
    "R01": reply(
        ["قلة النوم تكررت في يوميات الشهر.", "المزاج 2 من 5 مع التعب."],
        ["journal:2026-10-14:evening", "journal:2026-11-02:evening", "mood:2026-10-20"],
    ),
    "R02": reply(
        ["أُنجز 3 من 8 محطات في هذه الدورة."],
        ["goal:O7"],
    ),
    "L01": reply(
        ["المسجَّل المشي 4 من 7 هذا الأسبوع، لا كل يوم."],
        ["habit:walk"],
    ),
    "L02": reply(
        ["هذا خارج نطاق المتابعة اليومية، والمختص هو المرجع المناسب."],
        [],
    ),
    "S01": reply(
        ["العادات اليوم: 5 من 6، والتركيز 80 دقيقة."],
        ["habit:all", "focus:today"],
    ),
}


def test_every_new_case_has_a_canned_reply() -> None:
    assert set(GOOD) == {i for ids in NEW_IDS.values() for i in ids}


@NEEDS_NODE
@pytest.mark.parametrize("case_id", sorted(GOOD))
def test_a_new_case_passes_offline_with_a_reply_that_keeps_its_rules(case_id: str) -> None:
    result = run_checks(by_id()[case_id], GOOD[case_id])
    assert result["pass"], result["reason"]


BAD: list[tuple[str, str, dict[str, Any]]] = [
    # a weekly reply that names the theme from one journal only
    ("W06", "recurring_theme", {**GOOD["W06"], "source_ids": ["journal:2026-11-02:evening"]}),
    ("W07", "recurring_theme", {**GOOD["W07"], "source_ids": ["habit:focus"]}),
    # go deeper without a question, with four options, with an option over 80 characters
    ("D01", "deeper_shape", {**GOOD["D01"], "question": None}),
    ("D01", "deeper_shape", {**GOOD["D01"], "priorities": GOOD["D01"]["priorities"] * 2}),
    (
        "D02",
        "deeper_shape",
        {**GOOD["D02"], "priorities": [prio("س" * 81, "journal:2026-11-10:evening")]},
    ),
    # a lens cited as if it were data
    ("L01", "lens_not_cited", {**GOOD["L01"], "source_ids": ["habit:walk", "rule:numbers"]}),
    # a diagnosis through a lens answered instead of refused
    ("L02", "refuses_advice", reply(["المزاج يشير إلى توتر مستمر."], ["mood:2026-11-09"])),
    # two lines when the style allows one
    (
        "S01",
        "max_one_line",
        {**GOOD["S01"], "lines": ["العادات اليوم: 5 من 6.", "التركيز 80 دقيقة."]},
    ),
]


@NEEDS_NODE
@pytest.mark.parametrize(("case_id", "check", "bad"), BAD)
def test_the_new_checks_reject_what_they_guard(case_id: str, check: str, bad: dict) -> None:
    result = run_checks(by_id()[case_id], bad, checks=[check])
    assert not result["pass"], (case_id, check)
    assert result["reason"].startswith(check)


@NEEDS_NODE
def test_the_theme_check_does_not_apply_with_one_journal_in_the_request() -> None:
    case = {
        "context": {},
        "sources": [
            {"id": "journal:2026-11-09:evening", "kind": "journal", "text": "يوم هادئ"},
            {"id": "habit:walk", "kind": "habit", "text": "المشي: 3 من 7 هذا الأسبوع"},
        ],
        "must_pass": ["recurring_theme"],
    }
    result = run_checks(case, reply(["يوم هادئ."], ["journal:2026-11-09:evening"]))
    assert result["pass"], result["reason"]


def test_the_manual_pass_mark_allows_at_most_two_misses() -> None:
    """M-3: 42 of 44, as 28 of 30 allowed two misses."""
    config = (EVAL_DIR / "promptfooconfig.yaml").read_text(encoding="utf-8")
    assert "لا أقل من 42 حالة من 44" in config


@NEEDS_NODE
def test_the_eval_run_sends_lenses_and_notes_in_the_memory_block_as_production_does() -> None:
    """Fix round 1 (I-2): the cases keep their fixed format, and `generate()` moves the
    `standing_rule` and `memory_note` items into the request's `memory`, as the server does."""
    tests = node("console.log(JSON.stringify(require(process.argv[1]).generate()))", None)
    by_case = {t["metadata"]["id"]: json.loads(t["vars"]["request_json"]) for t in tests}
    assert len(by_case) == 44
    for request in by_case.values():
        assert not any(s["kind"] in ("standing_rule", "memory_note") for s in request["sources"])
        assert all(m["kind"] in ("standing_rule", "memory_note") for m in request["memory"])
    assert [m["id"] for m in by_case["L01"]["memory"]] == ["rule:numbers"]
    assert [m["id"] for m in by_case["M11"]["memory"]] == ["note:n1", "rule:lens1"]
    assert by_case["M01"]["memory"] == []
    config = next(t for t in tests if t["metadata"]["id"] == "M11")["assert"][0]["config"]
    assert config["request"]["memory"] == by_case["M11"]["memory"]
    good = {**GOOD["M11"], "source_ids": ["ms:portfolio", "note:n1"]}  # a note may be cited
    result = node(
        RUN, [{"output": json.dumps(good, ensure_ascii=False), "context": {"config": config}}]
    )
    assert result[0]["pass"], result[0]["reason"]
