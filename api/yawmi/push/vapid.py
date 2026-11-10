"""VAPID keys (RFC 8292): load the private key from the secrets volume, derive the public one.

The private key is a P-256 key in PEM, generated once on the server by `yawmi.push.keygen` into
the `yawmi_secrets` volume. Its content never appears in an error message or a log line: every
failure is reported as a `VapidKeyError` that names only what went wrong.
"""

import base64
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


class VapidKeyError(ValueError):
    """The VAPID private key is missing, unreadable, or not a P-256 key."""


def load_private_key(path: Path) -> ec.EllipticCurvePrivateKey:
    """The P-256 private key stored as PEM (PKCS#8 or SEC1) at `path`."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        raise VapidKeyError("the VAPID private key file is missing or unreadable") from None
    try:
        key = serialization.load_pem_private_key(data, password=None)
    except (ValueError, TypeError):
        raise VapidKeyError("the VAPID private key file is not an unencrypted PEM key") from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise VapidKeyError("the VAPID private key is not a P-256 key")
    return key


def public_key_b64url(key: ec.EllipticCurvePrivateKey) -> str:
    """The public key as the browser wants it for `applicationServerKey`.

    The uncompressed point (65 bytes, leading 0x04), base64url without padding.
    """
    raw = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
