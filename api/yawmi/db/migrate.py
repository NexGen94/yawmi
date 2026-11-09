"""Apply ``api/db/migrations/*.sql`` to Postgres, one transaction per file.

Conventions
-----------
* Files are named ``NNNN_slug.sql`` and applied in filename order. Applied names are
  recorded in ``yawmi.schema_migrations`` inside the *same* transaction as the file, so
  a file is either fully applied and recorded, or not applied at all.
* A file may wrap itself in ``BEGIN;`` / ``COMMIT;`` (each on its own line) so it also
  runs standalone under ``psql``. The runner removes that one pair and supplies its own
  transaction. Any other transaction control (ROLLBACK, a second BEGIN, ...) is refused.
* Secrets never live in the SQL. Values passed in ``params`` are exposed to the file for
  the duration of its transaction as the settings ``yawmi_migrate.<name>`` (set with
  ``set_config``, bound as parameters, never spliced into the SQL text), and a file reads
  them with ``current_setting('yawmi_migrate.<name>', true)``. Only ``0002`` uses this,
  for the ``yawmi_api`` role password. Trailing whitespace (a newline from a secret file)
  is stripped from every value, like psql's backtick; values must not end in whitespace.
* The runner refuses a missing or empty migrations directory instead of silently doing nothing.
* A concurrent runner waits on an advisory lock instead of racing.
"""

import re
from pathlib import Path

import asyncpg

# api/yawmi/db/migrate.py -> api/db/migrations. A source-tree default: an installed wheel
# does not ship the SQL, so callers outside the repository layout pass ``migrations_dir``.
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "db" / "migrations"

PARAM_PREFIX = "yawmi_migrate"
_ADVISORY_LOCK_KEY = 0x7961776D69  # "yawmi"

_FILE_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
_PARAM_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
_BEGIN = re.compile(r"^[ \t]*BEGIN[ \t]*;[ \t]*$", re.IGNORECASE | re.MULTILINE)
_COMMIT = re.compile(r"^[ \t]*COMMIT[ \t]*;[ \t]*$", re.IGNORECASE | re.MULTILINE)
_OTHER_TRANSACTION_CONTROL = re.compile(
    r"^[ \t]*(ROLLBACK|START[ \t]+TRANSACTION|PREPARE[ \t]+TRANSACTION)\b",
    re.IGNORECASE | re.MULTILINE,
)

_BOOTSTRAP = """
CREATE SCHEMA IF NOT EXISTS yawmi;
CREATE TABLE IF NOT EXISTS yawmi.schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
"""


class MigrationError(RuntimeError):
    """A migration file or parameter is malformed (the database was not touched)."""


def strip_transaction(name: str, sql: str) -> str:
    """Return ``sql`` without its own ``BEGIN;``/``COMMIT;`` wrapper, or raise.

    Accepts a file with no wrapper or with exactly one BEGIN followed by one COMMIT.
    """
    begins = list(_BEGIN.finditer(sql))
    commits = list(_COMMIT.finditer(sql))
    if _OTHER_TRANSACTION_CONTROL.search(sql):
        raise MigrationError(f"{name}: ROLLBACK/START/PREPARE TRANSACTION is not allowed")
    if len(begins) != len(commits) or len(begins) > 1:
        raise MigrationError(f"{name}: expected at most one BEGIN; ... COMMIT; pair")
    if not begins:
        return sql
    begin, commit = begins[0], commits[0]
    if begin.start() > commit.start():
        raise MigrationError(f"{name}: COMMIT; appears before BEGIN;")
    # Cut the later span first so the earlier offsets stay valid.
    return sql[: begin.start()] + sql[begin.end() : commit.start()] + sql[commit.end() :]


def _discover(directory: Path) -> list[Path]:
    if not directory.is_dir():
        raise MigrationError(f"migrations directory not found: {directory}")
    seen: dict[str, str] = {}
    files: list[Path] = []
    for path in sorted(directory.glob("*.sql")):
        match = _FILE_NAME.match(path.name)
        if not match:
            raise MigrationError(f"{path.name}: migration names must look like 0001_slug.sql")
        number = match.group(1)
        if number in seen:
            raise MigrationError(f"{path.name}: number {number} already used by {seen[number]}")
        seen[number] = path.name
        files.append(path)
    if not files:
        raise MigrationError(f"no migration files (*.sql) in {directory}")
    return files


def clean_params(params: dict[str, str]) -> dict[str, str]:
    """Validate parameter names and strip trailing whitespace from the values.

    Reading a secret file with ``read_text()`` keeps its final newline; psql's backtick
    drops it; the Python path does the same so the stored password never ends in a newline.
    """
    cleaned: dict[str, str] = {}
    for name, value in params.items():
        if not _PARAM_NAME.match(name):
            raise MigrationError(f"bad parameter name {name!r}: use lowercase letters, digits, _")
        if not isinstance(value, str):
            raise MigrationError(f"parameter {name!r} must be a string")
        cleaned[name] = value.rstrip()
    return cleaned


async def migrate(
    dsn: str,
    params: dict[str, str] | None = None,
    *,
    migrations_dir: Path | None = None,
) -> list[str]:
    """Apply every pending migration and return the filenames applied by this call.

    ``params`` are exposed to each migration as ``yawmi_migrate.<name>`` settings for the
    duration of its transaction (see the module docstring); they are never written to SQL.
    Raises ``MigrationError`` for a bad parameter, a bad file name, or a missing/empty
    migrations directory, before connecting.
    """
    params = clean_params(params or {})
    files = _discover(migrations_dir or MIGRATIONS_DIR)

    applied: list[str] = []
    conn = await asyncpg.connect(dsn)
    try:
        # Session-level lock; released when the connection closes.
        await conn.execute("SELECT pg_advisory_lock($1)", _ADVISORY_LOCK_KEY)
        await conn.execute(_BOOTSTRAP)
        done = {
            row["filename"]
            for row in await conn.fetch("SELECT filename FROM yawmi.schema_migrations")
        }
        for path in files:
            if path.name in done:
                continue
            sql = strip_transaction(path.name, path.read_text(encoding="utf-8"))
            async with conn.transaction():
                for name, value in params.items():
                    await conn.execute(
                        "SELECT set_config($1, $2, true)", f"{PARAM_PREFIX}.{name}", value
                    )
                await conn.execute(sql)
                await conn.execute(
                    "INSERT INTO yawmi.schema_migrations (filename) VALUES ($1)", path.name
                )
            applied.append(path.name)
    finally:
        await conn.close()
    return applied
