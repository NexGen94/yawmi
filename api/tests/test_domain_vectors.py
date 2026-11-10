"""المتجهات المشتركة `contracts/domain-vectors/v1/*.json` تطابق التنفيذ المرجعي، والمولّد يحرس ثباتها.

كل ملف من الأربعة عشر يُحمَّل، وتُفحص صيغته وفرادة معرّفاته، ثم تُطبَّق الدالة المرجعية على كل
`input` وتُقارن النتيجة بـ`expect` بقواعد الاتفاق: تطابق تام للأعداد الصحيحة والنصوص والقيم
المنطقية، و`|Δ| ≤ tol` (أو `1e-9` إن لم يُحدَّد) للكسور. ثم يُفحص حارس المولّد: تغيير `expect`
لمعرّف ملتزَم دون رفع `rulesVersion` يفشل، وكذلك تغيير `input` أو حذف معرّف.
"""

import importlib.util
import json
import math
import re
import shutil
from pathlib import Path
from types import ModuleType

import pytest

API_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = API_DIR.parent
VECTORS_DIR = REPO_DIR / "contracts" / "domain-vectors" / "v1"
GENERATOR = API_DIR / "tools" / "gen_domain_vectors.py"

_ID = re.compile(r"^(?P<fn>[a-z_]+)-(?P<n>\d{3})$")


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gen = _load("gen_domain_vectors", GENERATOR)
FUNCTIONS: tuple[str, ...] = gen.FUNCTIONS
RULES_VERSION: int = gen.RULES_VERSION


def _read(fn: str) -> dict:
    return json.loads((VECTORS_DIR / f"{fn}.json").read_text(encoding="utf-8"))


def _all_cases() -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for fn in FUNCTIONS:
        path = VECTORS_DIR / f"{fn}.json"
        if not path.exists():
            continue
        out.extend((fn, case) for case in _read(fn)["cases"])
    return out


def _is_primitive_json(value: object) -> bool:
    """بدائيات JSON فقط: نصوص وأعداد منتهية وقيم منطقية وnull، ومصفوفات وكائنات منها."""
    if value is None or isinstance(value, (str, bool)):
        return True
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_primitive_json(v) for v in value)
    if isinstance(value, dict):
        return all(isinstance(k, str) and _is_primitive_json(v) for k, v in value.items())
    return False


def _close(actual: object, expect: object, tol: float) -> bool:
    """قواعد المقارنة في الاتفاق: تطابق تام إلا للكسور فـ`|Δ| ≤ tol`."""
    if isinstance(expect, bool) or expect is None or isinstance(expect, str):
        return type(actual) is type(expect) and actual == expect
    if isinstance(expect, int):
        return isinstance(actual, int) and not isinstance(actual, bool) and actual == expect
    if isinstance(expect, float):
        return (
            isinstance(actual, (int, float))
            and not isinstance(actual, bool)
            and abs(actual - expect) <= tol
        )
    if isinstance(expect, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expect)
            and all(_close(a, e, tol) for a, e in zip(actual, expect, strict=True))
        )
    if isinstance(expect, dict):
        return (
            isinstance(actual, dict)
            and actual.keys() == expect.keys()
            and all(_close(actual[k], expect[k], tol) for k in expect)
        )
    return False


# ---------------------------------------------------------------- الصيغة


def test_fourteen_vector_files_exist():
    assert len(FUNCTIONS) == 14
    missing = [fn for fn in FUNCTIONS if not (VECTORS_DIR / f"{fn}.json").exists()]
    assert missing == []


@pytest.mark.parametrize("fn", FUNCTIONS)
def test_file_format(fn):
    doc = _read(fn)
    assert doc.keys() == {"rulesVersion", "function", "cases"}
    assert doc["rulesVersion"] == RULES_VERSION
    assert doc["function"] == fn
    assert isinstance(doc["cases"], list) and doc["cases"]
    for case in doc["cases"]:
        assert (
            {"id", "input", "expect", "source"}
            <= case.keys()
            <= {
                "id",
                "input",
                "expect",
                "source",
                "tol",
            }
        )
        match = _ID.match(case["id"])
        assert match is not None and match.group("fn") == fn, case["id"]
        assert isinstance(case["input"], dict) and _is_primitive_json(case["input"])
        assert set(case["expect"].keys()) == {"value"} and _is_primitive_json(case["expect"])
        assert isinstance(case["source"], str) and case["source"]
        if "tol" in case:
            assert isinstance(case["tol"], float) and 0 < case["tol"] < 1
        for key in case["input"]:
            assert re.fullmatch(r"[a-z][a-z0-9_]*", key), key


def test_ids_are_unique_across_all_files():
    ids = [case["id"] for _, case in _all_cases()]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize("fn", FUNCTIONS)
def test_file_is_canonical_text(fn):
    """مفاتيح مرتبة ومسافتان وLF وسطر أخير فارغ: ما يكتبه المولّد حرفياً."""
    raw = (VECTORS_DIR / f"{fn}.json").read_bytes()
    assert b"\r" not in raw
    text = raw.decode("utf-8")
    assert text == gen.render(json.loads(text))


# ---------------------------------------------------------------- المطابقة مع المرجع


@pytest.mark.parametrize(
    ("fn", "case"), _all_cases(), ids=lambda c: c["id"] if isinstance(c, dict) else c
)
def test_case_matches_reference(fn, case):
    actual = gen.apply(fn, case["input"])
    tol = case.get("tol", 1e-9)
    assert _close(actual, case["expect"]["value"], tol), (actual, case["expect"]["value"])


def test_pinned_reference_values_hold():
    """القيم المعلنة في المواصفة (Loop 0.7980 @30 ...) تطابق ما في الملفات ضمن هامشها."""
    by_id = {case["id"]: case for _, case in _all_cases()}
    pinned = [(fn, c) for fn, cases in gen.vector_cases.CASES.items() for c in cases if c.pin]
    assert pinned
    for fn, c in pinned:
        value, tol = c.pin
        got = by_id[c.id]["expect"]["value"]
        assert _close(got, value, tol), (c.id, got, value)


# ---------------------------------------------------------------- الحالات الإلزامية


def _inputs(fn: str) -> list[dict]:
    return [case["input"] for case in _read(fn)["cases"]]


def _text(fn: str) -> str:
    return json.dumps(_inputs(fn), ensure_ascii=False)


def test_mandatory_cases_are_present():
    day_key_instants = {i["instant"] for i in _inputs("day_key")}
    assert {"2026-11-09T20:59:59Z", "2026-11-09T21:00:00Z"} <= day_key_instants
    assert "2028-02-29" in _text("period_bounds")
    for fn in ("period_bounds", "streak", "goal_prefill"):
        assert {i["week_start"] for i in _inputs(fn)} == {"sat", "sun", "mon"}, fn
    assert {"2026-11-30", "2026-12-31", "2028-02-29", "2027-02-28"} <= {
        str(v) for i in _inputs("period_bounds") for v in (i["day"],)
    } | {
        case["expect"]["value"]["end"]
        for case in _read("period_bounds")["cases"]
        if isinstance(case["expect"]["value"], dict)
    }
    statuses = {
        log["status"] for fn in ("strength", "streak") for i in _inputs(fn) for log in i["logs"]
    }
    assert {"skip", "vacation", "missed"} <= statuses
    assert any(i["habit"]["schedule_kind"] == "every_n_days" for i in _inputs("is_scheduled"))
    assert any(
        i["habit"]["end_day"] is not None and i["today"] > i["habit"]["end_day"]
        for i in _inputs("challenge_progress")
    )
    assert any(
        i["habit"]["end_day"] is not None and i["today"] == i["habit"]["end_day"]
        for i in _inputs("challenge_progress")
    )
    assert {c.pin[0] for c in gen.vector_cases.CASES["strength"] if c.pin} >= {
        0.7980,
        0.9592,
        0.9918,
    }


# ---------------------------------------------------------------- حارس المولّد


@pytest.fixture
def committed(tmp_path: Path) -> Path:
    out = tmp_path / "v1"
    shutil.copytree(VECTORS_DIR, out)
    return out


def _rewrite(path: Path, mutate) -> None:
    doc = json.loads(path.read_text(encoding="utf-8"))
    mutate(doc)
    path.write_text(gen.render(doc), encoding="utf-8", newline="\n")


def test_generator_is_idempotent_against_committed_files(committed):
    assert gen.generate(committed, check=True) == []
    assert gen.generate(committed) == []


def test_generator_refuses_changed_expect_without_version_bump(committed):
    def mutate(doc):
        doc["cases"][0]["expect"]["value"] = "1999-01-01"

    _rewrite(committed / "end_day.json", mutate)
    with pytest.raises(gen.VectorError, match="تغيّر expect دون رفع rulesVersion"):
        gen.generate(committed)


def test_generator_accepts_changed_expect_when_version_was_bumped(committed):
    def mutate(doc):
        doc["rulesVersion"] = RULES_VERSION - 1
        doc["cases"][0]["expect"]["value"] = "1999-01-01"

    _rewrite(committed / "end_day.json", mutate)
    assert gen.generate(committed) == ["end_day.json"]
    assert json.loads((committed / "end_day.json").read_text("utf-8")) == _read("end_day")


def test_generator_refuses_changed_input_for_committed_id(committed):
    def mutate(doc):
        doc["cases"][0]["input"]["duration_days"] = 999

    _rewrite(committed / "end_day.json", mutate)
    with pytest.raises(gen.VectorError, match="تغيّر input لمعرّف ملتزَم"):
        gen.generate(committed)


def test_generator_refuses_dropped_committed_id(committed):
    def mutate(doc):
        doc["cases"].append(
            {
                "id": "end_day-999",
                "input": {"start": "2026-01-01", "duration_days": 1},
                "expect": {"value": "2026-01-01"},
                "source": "معرّف ملتزَم لم يعد في vector_cases",
            }
        )

    _rewrite(committed / "end_day.json", mutate)
    with pytest.raises(gen.VectorError, match="حُذف معرّف ملتزَم"):
        gen.generate(committed)


def test_check_mode_reports_any_drift_without_writing(committed):
    def mutate(doc):
        doc["cases"][0]["source"] = "مصدر مختلف"

    _rewrite(committed / "strain.json", mutate)
    before = (committed / "strain.json").read_bytes()
    assert gen.generate(committed, check=True) == ["strain.json"]
    assert (committed / "strain.json").read_bytes() == before
    assert gen.generate(committed) == ["strain.json"]
    assert (committed / "strain.json").read_bytes() == (VECTORS_DIR / "strain.json").read_bytes()


def test_main_check_exit_codes(committed, capsys):
    assert gen.main(["--check", "--out", str(committed)]) == 0
    (committed / "trimp.json").unlink()
    assert gen.main(["--check", "--out", str(committed)]) == 1
    assert "trimp.json" in capsys.readouterr().out
