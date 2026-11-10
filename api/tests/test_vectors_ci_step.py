"""خطوة CI التي تحرس المتجهات ضد الفرع الأساس: تثبيت بنيتها كي لا تعود «تفشل مفتوحة».

الخطوة في `.github/workflows/api-tests.yml` تقرأ شجرة commit الأساس (`BASE_SHA`). في نسخة ضحلة
(`fetch-depth` الافتراضي 1) لا يوجد ذلك الـcommit، فإن ابتُلع الخطأ عُدّ «لا متجهات في الأساس»
ومرّت الخطوة دون أي حراسة. هذه الاختبارات تقرأ الملف وتؤكد ما يمنع ذلك؛ السلوك نفسه مُثبَت
بتشغيل السكربت في نسخ كاملة وضحلة (تقرير المهمة 11، الجولة 3).
"""

import re
from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "api-tests.yml"
STEP_NAME = "Domain vectors match the reference implementation"
UNTRACKED_CHECK = 'test -z "$(git status --porcelain --untracked-files=all -- contracts/)"'


def _steps() -> list[dict]:
    doc = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    return doc["jobs"]["test"]["steps"]


def _vector_step() -> dict:
    (step,) = [s for s in _steps() if s.get("name") == STEP_NAME]
    return step


def test_checkout_fetches_full_history_without_persisting_credentials():
    (checkout,) = [s for s in _steps() if str(s.get("uses", "")).startswith("actions/checkout@")]
    assert checkout["with"]["fetch-depth"] == 0  # commit الأساس يجب أن يكون في النسخة
    assert checkout["with"]["persist-credentials"] is False
    assert re.fullmatch(r"actions/checkout@[0-9a-f]{40}", checkout["uses"])  # مثبّت بـSHA


def test_install_step_precedes_the_vector_step():
    names = [s.get("name") for s in _steps()]
    assert names.index("Install dependencies") < names.index(STEP_NAME)


def test_vector_step_runs_strict_bash():
    step = _vector_step()
    assert step["shell"] == "bash"
    lines = [ln.strip() for ln in step["run"].splitlines()]
    assert lines[0] == "set -euo pipefail"
    assert lines[1].startswith("trap 'echo \"::error::")  # أي أمر يفشل يُسمّى في السجل
    assert lines[1].endswith("' ERR")


def test_base_sha_reaches_the_script_through_env_only():
    step = _vector_step()
    assert step["env"] == {
        "BASE_SHA": "${{ github.event.pull_request.base.sha || github.event.before }}"
    }
    assert "${{" not in step["run"]


def test_unresolvable_base_commit_fails_closed():
    run = _vector_step()["run"]
    block = re.search(
        r'^if ! git cat-file -e "\$BASE_SHA\^\{commit\}"; then\n(?P<body>.*?)^fi$',
        run,
        flags=re.MULTILINE | re.DOTALL,
    )
    assert block is not None
    assert "::error::" in block["body"]
    assert "exit 1" in block["body"]
    assert "exit 0" not in block["body"]
    assert "2>/dev/null |" not in run  # لا خطأ git يُبتلع داخل أنبوب يقرر التخطّي


def test_skip_is_limited_to_no_base_or_a_base_without_vectors():
    run = _vector_step()["run"]
    assert run.count("exit 0") == 2
    first_skip = run[: run.index("exit 0")]
    assert '[ -z "$BASE_SHA" ]' in first_skip  # حدث بلا أساس
    assert "^0+$" in first_skip  # أو أصفار كلها: فرع جديد
    assert run.index("exit 0") < run.index('git cat-file -e "$BASE_SHA^{commit}"')
    second_skip = run[run.index("git ls-tree") : run.rindex("exit 0")]
    assert r"\.json$" in second_skip  # أو أساس محلول بلا ملفات متجهات


def test_generator_lines_neither_sync_nor_build():
    run = _vector_step()["run"]
    lines = [ln.strip() for ln in run.splitlines() if "gen_domain_vectors.py" in ln]
    prefix = "uv run --locked --no-sync --no-build --project api python -I api/tools/"
    assert lines == [
        prefix + "gen_domain_vectors.py --check",
        prefix + "gen_domain_vectors.py --init",
    ]


def test_untracked_check_runs_before_and_after_the_base_swap():
    run = _vector_step()["run"]
    assert run.count(UNTRACKED_CHECK) == 2
    swap = run.index("git archive")
    init = run.index("gen_domain_vectors.py --init")
    assert run.index(UNTRACKED_CHECK) < swap
    assert run.rindex(UNTRACKED_CHECK) > init
    assert run.index("git diff --exit-code -- contracts/") > init
