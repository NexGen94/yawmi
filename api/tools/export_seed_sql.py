"""Write `api/db/seed/habits.sql` from `api/db/seed/habits.json`.

Run from `api/`:  uv run python tools/export_seed_sql.py

The output is committed: the server loader runs it with psql, and CI regenerates it and fails
on `git diff --exit-code`. Always written with LF line endings, whatever the platform.
"""

import argparse
import sys
from pathlib import Path

from yawmi.db import seed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate habits.sql from habits.json.")
    parser.add_argument("--habits", type=Path, default=seed.HABITS_JSON, help="source habits.json")
    parser.add_argument("--output", type=Path, default=seed.HABITS_SQL, help="habits.sql to write")
    args = parser.parse_args(argv)

    sql = seed.render_seed_sql(seed.load_habits(args.habits))
    args.output.write_text(sql, encoding="utf-8", newline="\n")
    print(f"wrote {args.output} ({len(sql.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
