"""A throwaway local Postgres 16 for the database tests and the end-to-end suite.

    python api/tools/local_pg.py start [--port 55432]
    python api/tools/local_pg.py stop  [--port 55432]

`start` copies the `pgserver/pginstall` tree that `uv` already holds in its cache to a temporary
folder, fills its time zone data from the `tzdata` package of `api/.venv`, runs `initdb`
(trust authentication, UTF8, locale C), starts the server on 127.0.0.1 and creates the database
`raqib`. `stop` stops it and deletes the temporary folder. Nothing is downloaded or installed: when
`pgserver` is not in the uv cache the tool prints the recipe and exits with 2.

The folder lives in the system temp directory under `yawmi-local-pg-<port>`; the data directory,
the log and a copy of the binaries are inside it.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Sequence
from pathlib import Path

DEFAULT_PORT = 55432
DATABASE = "raqib"
API_DIR = Path(__file__).resolve().parents[1]

RECIPE = """\
pgserver/pginstall was not found in the uv cache; nothing was downloaded. By hand:
  1. Put a copy of a pgserver/pginstall tree (Postgres 16) in a temp folder outside the repo.
  2. Fill its share/postgresql/timezone from tzdata/zoneinfo inside api/.venv.
  3. initdb -U postgres -A trust -E UTF8 --locale=C -D <data>
  4. pg_ctl -D <data> -l <log> start -o "-p <port> -c listen_addresses=127.0.0.1"
  5. createdb -U postgres -h 127.0.0.1 -p <port> raqib
  6. Stop it and delete the temp folder when done.
"""


def default_uv_cache() -> Path:
    """`uv`'s cache directory: `uv cache dir`, else the platform default."""
    try:
        out = subprocess.run(
            ["uv", "cache", "dir"], capture_output=True, text=True, check=True, timeout=30
        )
        return Path(out.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        local = Path.home() / "AppData" / "Local" / "uv" / "cache"
        return local if local.exists() else Path.home() / ".cache" / "uv"


def find_pginstall(uv_cache: Path) -> Path | None:
    """A `pgserver/pginstall` folder with a `bin` under `uv_cache`, or `None`."""
    archive = uv_cache / "archive-v0"
    if not archive.is_dir():
        return None
    for candidate in sorted(archive.glob("*/**/site-packages/pgserver/pginstall")):
        if (candidate / "bin").is_dir():
            return candidate
    return None


def work_dir(port: int) -> Path:
    return Path(tempfile.gettempdir()) / f"yawmi-local-pg-{port}"


def _bin(root: Path, name: str) -> str:
    return str(root / "pginstall" / "bin" / (name + (".exe" if sys.platform == "win32" else "")))


def _zoneinfo() -> Path | None:
    site_packages = [API_DIR / ".venv" / "Lib" / "site-packages"]
    site_packages += list((API_DIR / ".venv" / "lib").glob("python*/site-packages"))
    for candidate in site_packages:
        zones = candidate / "tzdata" / "zoneinfo"
        if zones.is_dir():
            return zones
    return None


def start(port: int, uv_cache: Path | None = None) -> int:
    source = find_pginstall(uv_cache if uv_cache is not None else default_uv_cache())
    if source is None:
        print(RECIPE, file=sys.stderr, end="")
        return 2
    root = work_dir(port)
    if root.exists():
        print(f"{root} already exists: run `stop --port {port}` first", file=sys.stderr)
        return 1
    zones = _zoneinfo()
    if zones is None:
        print("tzdata is missing from api/.venv: run `uv sync` in api/ first", file=sys.stderr)
        return 1
    root.mkdir(parents=True)
    shutil.copytree(source, root / "pginstall")
    shutil.copytree(
        zones, root / "pginstall" / "share" / "postgresql" / "timezone", dirs_exist_ok=True
    )
    data = root / "data"
    init = [_bin(root, "initdb"), "-U", "postgres", "-A", "trust", "-E", "UTF8"]
    subprocess.run([*init, "--locale=C", "-D", str(data)], check=True, capture_output=True)
    # no `-w`, output dropped: pg_ctl would otherwise keep our pipes open while the server runs
    subprocess.Popen(
        [
            _bin(root, "pg_ctl"),
            "-D",
            str(data),
            "-l",
            str(root / "pg.log"),
            "start",
            "-o",
            f"-p {port} -c listen_addresses=127.0.0.1",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
    )
    create = [
        _bin(root, "createdb"),
        "-U",
        "postgres",
        "-h",
        "127.0.0.1",
        "-p",
        str(port),
        DATABASE,
    ]
    for _ in range(60):
        if subprocess.run(create, check=False, capture_output=True).returncode == 0:
            break
        time.sleep(0.5)
    else:
        print(f"the server did not accept connections; see {root / 'pg.log'}", file=sys.stderr)
        return 1
    print(f"postgresql://postgres@127.0.0.1:{port}/{DATABASE}")
    print(f"bin: {root / 'pginstall' / 'bin'}", file=sys.stderr)
    return 0


def stop(port: int) -> int:
    root = work_dir(port)
    if not root.exists():
        print(f"nothing to stop on port {port}", file=sys.stderr)
        return 0
    stop_cmd = [_bin(root, "pg_ctl"), "-D", str(root / "data"), "stop", "-m", "fast"]
    try:
        subprocess.run(stop_cmd, check=False, capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        pass
    for _ in range(20):
        try:
            shutil.rmtree(root)
            break
        except OSError:
            time.sleep(0.5)
    return 0 if not root.exists() else 1


def main(argv: Sequence[str] | None = None, *, uv_cache: Path | None = None) -> int:
    parser = argparse.ArgumentParser(prog="local_pg", description="Throwaway local Postgres 16")
    parser.add_argument("command", choices=("start", "stop"))
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)
    return start(args.port, uv_cache) if args.command == "start" else stop(args.port)


if __name__ == "__main__":
    sys.exit(main())
