"""Which push endpoints the server may contact: one check for the route and for the sender.

A push endpoint is a URL the browser hands over, so it is attacker-controlled input for anyone
holding a device token. The server only ever talks to the browsers' push services:

* `https`, no credentials in the URL, no IP literal, port absent or 443;
* the host, lower-cased, is one of `allowed` or a subdomain of one (exact or dot-suffix match);
* printable, without whitespace.

The route answers 422 when this fails; the sender checks again before every send and the
scheduler drops a stored row that fails, without contacting it. As a second layer the sender's
resolver refuses any address that is not global (`GlobalOnlyResolver` in `yawmi.push.sender`).
Standard library only: the route module and the settings import this.
"""

import ipaddress
from collections.abc import Iterable
from urllib.parse import urlsplit

# Apple (web.push.apple.com and its siblings), Google FCM, Mozilla autopush, Windows WNS.
DEFAULT_PUSH_HOSTS: tuple[str, ...] = (
    "push.apple.com",
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "notify.windows.com",
)


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def host_allowed(host: str, allowed: Iterable[str]) -> bool:
    host = host.lower()
    for entry in allowed:
        entry = entry.lower().strip(".")
        if entry and (host == entry or host.endswith("." + entry)):
            return True
    return False


def endpoint_problem(endpoint: str, allowed: Iterable[str] | None) -> str | None:
    """Why the server must not contact `endpoint`, or `None` when it may.

    With `allowed=None` only the shape is checked (scheme, host, port, credentials, IP literal);
    the request model uses that, and the route then applies the allow-list from the settings.
    """
    if any(c.isspace() or not c.isprintable() for c in endpoint):
        return "unprintable"
    try:
        parts = urlsplit(endpoint)
        host = parts.hostname
        port = parts.port
    except ValueError:
        return "malformed"
    if parts.scheme != "https":
        return "not_https"
    if not host:
        return "no_host"
    if parts.username is not None or parts.password is not None:
        return "credentials"
    if _is_ip_literal(host):
        return "ip_literal"
    if port not in (None, 443):
        return "port"
    if allowed is not None and not host_allowed(host, allowed):
        return "host_not_allowed"
    return None
