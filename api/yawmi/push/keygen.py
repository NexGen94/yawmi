"""One-shot VAPID key generator, run on the server by `deploy/compose/yawmi-vapid-keygen.yml`.

    YAWMI_VAPID_PRIVATE_KEY_FILE=/run/yawmi/vapid_private.pem         python -I -m yawmi.push.keygen [--group 10001]

The key file is the one the API reads: `YAWMI_VAPID_PRIVATE_KEY_FILE` (default
`/run/yawmi/vapid_private.pem`). No path is ever taken from the command line, and the variable
must name a file directly inside `/run/yawmi` (the secrets volume); anything else is refused
with exit 2 before a file is touched. Tests pass `path=` to `main` instead.

If the file is missing it writes a new P-256 private key there (PKCS#8 PEM, mode 0640: the
owner and the API's group may read it, nobody else). If it exists it is kept as is. Either way
the only thing printed is the public key (base64url), which is not a secret: the web client
fetches it from `GET /v1/push/vapid-public-key` anyway. The private key is never printed.

`--group` hands the file to the API's group (uid/gid 10001 in the image), so the API container,
which mounts the volume read-only and runs as 10001, can read it. It needs CAP_CHOWN.

Exit codes: 0 done, 1 the existing file is not a usable key (it is left untouched), 2 the
variable names a path outside the secrets directory.
"""

import argparse
import os
import posixpath
import sys
from pathlib import Path, PurePosixPath

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from yawmi.push.vapid import VapidKeyError, load_private_key, public_key_b64url

FILE_MODE = 0o640
SECRETS_DIR = PurePosixPath("/run/yawmi")
ENV = "YAWMI_VAPID_PRIVATE_KEY_FILE"
DEFAULT_FILE = SECRETS_DIR / "vapid_private.pem"


def key_path() -> Path | None:
    """The key file from the environment, or `None` if it is not directly in `SECRETS_DIR`."""
    raw = os.environ.get(ENV, "").strip() or str(DEFAULT_FILE)
    if not raw.startswith("/"):
        return None
    candidate = PurePosixPath(posixpath.normpath(raw))
    if candidate.parent != SECRETS_DIR or candidate.name in ("", ".", ".."):
        return None
    return Path(str(candidate))


def _write_new_key(path: Path, group: int | None) -> None:
    """Write a fresh key next to `path`, then link it into place only if `path` is still absent.

    The temporary file is created exclusively with the final mode, so the key is never readable
    by anyone else, not even for an instant; `os.link` refuses to replace an existing file.
    """
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, FILE_MODE)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(pem)
            handle.flush()
            os.fsync(handle.fileno())
        if group is not None:
            os.chown(tmp, -1, group)
        os.chmod(tmp, FILE_MODE)  # the umask may have narrowed the mode at creation
        os.link(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def main(argv: list[str] | None = None, *, path: Path | None = None) -> int:
    """Create the key once. `path` is for tests; the command line never names a file."""
    parser = argparse.ArgumentParser(description=f"Create the VAPID private key ({ENV}) once.")
    parser.add_argument("--group", type=int, default=None, help="gid allowed to read the key")
    args = parser.parse_args(argv)
    if path is None:
        path = key_path()
        if path is None:
            print(
                f"yawmi-vapid-keygen: {ENV} is outside {SECRETS_DIR}; nothing done", file=sys.stderr
            )
            return 2

    if not path.exists():
        _write_new_key(path, args.group)
        print("yawmi-vapid-keygen: generated a new VAPID key", file=sys.stderr)
    else:
        print("yawmi-vapid-keygen: kept the existing VAPID key", file=sys.stderr)
    try:
        key = load_private_key(path)
    except VapidKeyError as exc:
        print(f"yawmi-vapid-keygen: {exc}; the file was left as is", file=sys.stderr)
        return 1
    print(public_key_b64url(key))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
