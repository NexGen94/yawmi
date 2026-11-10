"""المتجهات المشتركة `contracts/domain-vectors/v1/*.json` تطابق التنفيذ المرجعي، والمولّد يحرس ثباتها.

كل ملف من الأربعة عشر يُحمَّل، وتُفحص صيغته وفرادة معرّفاته، ثم تُطبَّق الدالة المرجعية على كل
`input` وتُقارن النتيجة بـ`expect` بقواعد الاتفاق: تطابق تام للأعداد الصحيحة والنصوص والقيم
المنطقية، و`|Δ| ≤ tol` (أو `1e-9` إن لم يُحدَّد) للكسور. ثم يُفحص حارس المولّد: تغيير `expect`
لمعرّف ملتزَم دون رفع `rulesVersion` يفشل، وكذلك تغيير `input` أو حذف معرّف أو غياب ملف ملتزَم
(إلا بـ`--init`)، والكتابة ذرّية فلا يترك فشل الحارس ملفاً مكتوباً جزئياً.

`gen_domain_vectors` يُستورد استيراداً عادياً: `pythonpath = ["tools"]` في `pyproject.toml`.
"""

import json
import math
import re
import shutil
from pathlib import Path

import gen_domain_vectors as gen
import pytest

API_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = API_DIR.parent
VECTORS_DIR = REPO_DIR / "contracts" / "domain-vectors" / "v1"

FUNCTIONS: tuple[str, ...] = gen.FUNCTIONS
RULES_VERSION: int = gen.RULES_VERSION
close = gen.close  # قاعدة المقارنة الواحدة في الاتفاق، من المولّد نفسه

_ID = re.compile(r"^(?P<fn>[a-z_]+)-(?P<n>\d{3})$")
WEEK_START_FUNCTIONS = (
    "period_bounds",
    "period_progress",
    "strength",
    "streak",
    "challenge_progress",
    "adherence",
    "goal_prefill",
)


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


# ---------------------------------------------------------------- قاعدة المقارنة


@pytest.mark.parametrize(
    ("actual", "expect", "ok"),
    [
        (3, 3, True),
        (3.0, 3, False),  # الصحيح يحتاج صحيحاً
        (True, 1, False),  # المنطقي ليس صحيحاً
        (3, 3.0, True),  # الكسر يقبل صحيحاً ضمن الهامش
        (True, 1.0, False),  # ولا يقبل منطقياً
        (3.0 + 5e-10, 3.0, True),
        (3.0 + 2e-9, 3.0, False),
        ("a", "a", True),
        (None, None, True),
        ({"a": 1}, {"a": 1, "b": 2}, False),
    ],
)
def test_close_rules(actual, expect, ok):
    assert close(actual, expect, 1e-9) is ok


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
    assert isinstance(doc["cases"], list)
    assert doc["cases"]
    required = {"id", "input", "expect", "source"}
    for case in doc["cases"]:
        assert required <= case.keys()
        assert case.keys() <= required | {"tol"}
        match = _ID.match(case["id"])
        assert match is not None, case["id"]
        assert match.group("fn") == fn, case["id"]
        assert isinstance(case["input"], dict)
        assert _is_primitive_json(case["input"])
        assert set(case["expect"].keys()) == {"value"}
        assert _is_primitive_json(case["expect"])
        assert isinstance(case["source"], str)
        assert case["source"]
        if "tol" in case:
            assert isinstance(case["tol"], float)
            assert case["tol"] > 0
            assert case["tol"] < 1
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
    assert close(actual, case["expect"]["value"], tol), (actual, case["expect"]["value"])


def test_pinned_reference_values_hold():
    """القيم المعلنة في المواصفة (Loop 0.7980 @30 ...) تطابق ما في الملفات ضمن هامشها."""
    by_id = {case["id"]: case for _, case in _all_cases()}
    pinned = [(fn, c) for fn, cases in gen.vector_cases.CASES.items() for c in cases if c.pin]
    assert pinned
    for fn, c in pinned:
        value, tol = c.pin
        got = by_id[c.id]["expect"]["value"]
        assert close(got, value, tol), (c.id, got, value)


# ---------------------------------------------------------------- الحالات الإلزامية


def _inputs(fn: str) -> list[dict]:
    return [case["input"] for case in _read(fn)["cases"]]


def _text(fn: str) -> str:
    return json.dumps(_inputs(fn), ensure_ascii=False)


def test_mandatory_cases_are_present():
    day_key_instants = {i["instant"] for i in _inputs("day_key")}
    assert {"2026-11-09T20:59:59Z", "2026-11-09T21:00:00Z"} <= day_key_instants
    assert any(re.search(r"\d{2}:\d{2}:\d{2}\.\d+Z$", i) for i in day_key_instants)  # أجزاء الثانية
    assert "2028-02-29" in _text("period_bounds")
    for fn in WEEK_START_FUNCTIONS:
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


def _snapshot(folder: Path) -> dict[str, bytes]:
    """ملفات المتجهات (ومخلّفات `.tmp` إن وُجدت) دون `.gitkeep`."""
    return {
        p.name: p.read_bytes() for p in sorted(folder.iterdir()) if p.suffix in {".json", ".tmp"}
    }


def test_generator_is_idempotent_against_committed_files(committed):
    before = _snapshot(committed)
    assert gen.generate(committed, check=True) == []
    assert gen.generate(committed) == []
    assert _snapshot(committed) == before


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


def test_missing_committed_file_is_a_dropped_baseline(committed):
    """حذف ملف ملتزَم ثم التوليد لا يعيد ضبط الحارس بصمت: يفشل في الوضعين إلا بـ`--init`."""
    (committed / "strain.json").unlink()
    before = _snapshot(committed)
    with pytest.raises(gen.VectorError, match="لا ملف ملتزَم"):
        gen.generate(committed, check=True)
    with pytest.raises(gen.VectorError, match="لا ملف ملتزَم"):
        gen.generate(committed)
    assert _snapshot(committed) == before  # لا كتابة قبل اكتمال الحارس
    assert gen.generate(committed, init=True) == ["strain.json"]
    assert (committed / "strain.json").read_bytes() == (VECTORS_DIR / "strain.json").read_bytes()


def test_init_creates_an_empty_folder_from_scratch(tmp_path):
    out = tmp_path / "fresh" / "v1"
    with pytest.raises(gen.VectorError, match="لا ملف ملتزَم"):
        gen.generate(out)
    assert not out.exists()
    assert gen.generate(out, init=True) == [f"{fn}.json" for fn in FUNCTIONS]
    assert _snapshot(out) == _snapshot(VECTORS_DIR)


def test_guard_failure_leaves_no_partial_writes(committed):
    """الحارس يفحص الملفات كلها قبل أن يكتب أيّها: فشل ملف متأخر لا يعيد كتابة ملف مبكر."""

    def drift_source(doc):
        doc["cases"][0]["source"] = "مصدر مختلف"

    def drift_expect(doc):
        doc["cases"][0]["expect"]["value"] = 0.5

    _rewrite(committed / "adherence.json", drift_source)  # أول ملف يختلف: كان سيُكتب
    _rewrite(committed / "strain.json", drift_expect)  # آخر ملف: يُسقط الحارس
    before = _snapshot(committed)
    with pytest.raises(gen.VectorError, match="strain-001"):
        gen.generate(committed)
    assert _snapshot(committed) == before
    assert not list(committed.glob("*.tmp"))


def test_check_mode_reports_any_drift_without_writing(committed):
    def mutate(doc):
        doc["cases"][0]["source"] = "مصدر مختلف"

    _rewrite(committed / "strain.json", mutate)
    before = (committed / "strain.json").read_bytes()
    assert gen.generate(committed, check=True) == ["strain.json"]
    assert (committed / "strain.json").read_bytes() == before
    assert gen.generate(committed) == ["strain.json"]
    assert (committed / "strain.json").read_bytes() == (VECTORS_DIR / "strain.json").read_bytes()
    assert not list(committed.glob("*.tmp"))


def test_main_exit_codes(committed, capsys):
    assert gen.main(["--check"], out_dir=committed) == 0
    (committed / "trimp.json").unlink()
    assert gen.main(["--check"], out_dir=committed) == 1
    assert "trimp.json" in capsys.readouterr().out
    assert gen.main([], out_dir=committed) == 1  # إعادة التوليد لا تنشئه بصمت
    assert not (committed / "trimp.json").exists()
    assert gen.main(["--init"], out_dir=committed) == 0
    assert (committed / "trimp.json").read_bytes() == (VECTORS_DIR / "trimp.json").read_bytes()


def test_main_has_no_output_path_option():
    """مجلد الإخراج ثابت من موقع السكربت، لا من سطر الأوامر."""
    with pytest.raises(SystemExit):
        gen.main(["--out", "x"])
