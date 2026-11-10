"""Access tokens (HS256 JWT) and refresh tokens (random, stored only as SHA-256).

Access tokens are stateless: `verify_access` never touches the database, so a revoked device
keeps a valid access token until it expires (`jwt_ttl_seconds`, 15 minutes by default) but can
no longer refresh it.
"""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt

ALGORITHM = "HS256"
DEVICE_KINDS = ("iphone", "watch", "web", "service")


class AuthError(Exception):
    """The presented token is missing, malformed, expired, or not signed by us."""


@dataclass(frozen=True)
class AccessClaims:
    sub: UUID
    kind: str
    exp: datetime


def issue_access(device_id: UUID, kind: str, secret: str, ttl: int) -> str:
    """Sign an access token for `device_id` that expires `ttl` seconds from now."""
    payload = {
        "sub": str(device_id),
        "kind": kind,
        "exp": datetime.now(UTC) + timedelta(seconds=ttl),
    }
    return jwt.encode(payload, secret, algorithm=ALGORITHM)


def verify_access(token: str, secret: str) -> AccessClaims:
    """Check signature, expiry and claim shape; raise `AuthError` for anything else."""
    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=[ALGORITHM],  # pinned: rejects `alg: none` and algorithm confusion
            options={"require": ["exp", "sub", "kind"]},
        )
        kind = payload["kind"]
        if kind not in DEVICE_KINDS:
            raise AuthError("unknown device kind")
        return AccessClaims(
            sub=UUID(payload["sub"]),
            kind=kind,
            exp=datetime.fromtimestamp(payload["exp"], tz=UTC),
        )
    except (jwt.PyJWTError, ValueError, TypeError, KeyError) as exc:
        raise AuthError("invalid access token") from exc


def hash_refresh(raw: str) -> str:
    """SHA-256 hex digest of a raw refresh token: the only form that is ever stored.

    `surrogatepass` keeps this total: a client-sent lone surrogate (a JSON escape such as
    U+D800) hashes to a value no real token has, so the caller answers 401 instead of failing
    with `UnicodeEncodeError`. Real tokens are ASCII, so for them the result is unchanged.
    """
    return hashlib.sha256(raw.encode("utf-8", "surrogatepass")).hexdigest()


def new_refresh() -> tuple[str, str]:
    """Return `(raw, sha256_hex)`; `raw` (256 random bits, 43 URL-safe chars) goes to the client."""
    raw = secrets.token_urlsafe(32)
    return raw, hash_refresh(raw)
