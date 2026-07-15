"""Ensure TLS verification works on hosts with empty/broken system CA stores.

Python.org macOS builds often ship without running ``Install Certificates.command``,
so the default OpenSSL CA path is empty and live WebSocket/HTTPS fails with
``CERTIFICATE_VERIFY_FAILED: self-signed certificate in certificate chain``.

This module points OpenSSL / aiohttp / urllib at certifi's CA bundle early in
process startup.  Optional ``FLOWMAP_INSECURE_SSL=1`` disables verification
(dev only).
"""

from __future__ import annotations

import logging
import os
import ssl
from typing import Any, Optional, Union

log = logging.getLogger(__name__)

_BOOTSTRAPPED = False


def bootstrap_ssl() -> Optional[str]:
    """Point process SSL defaults at certifi when system CAs are unusable.

    Returns the CA file path used, or None if nothing was configured.
    Safe to call multiple times (idempotent).
    """
    global _BOOTSTRAPPED
    if _BOOTSTRAPPED:
        return os.environ.get("SSL_CERT_FILE")
    _BOOTSTRAPPED = True

    insecure = os.environ.get("FLOWMAP_INSECURE_SSL", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    if insecure:
        log.warning(
            "FLOWMAP_INSECURE_SSL set: TLS verification disabled (dev only)."
        )
        # Do not force SSL_CERT_FILE when user opted into insecure mode.
        return None

    # Honour an explicit user-provided CA file.
    if os.environ.get("SSL_CERT_FILE") and os.path.isfile(os.environ["SSL_CERT_FILE"]):
        return os.environ["SSL_CERT_FILE"]

    ca_path: Optional[str] = None
    try:
        import certifi

        ca_path = certifi.where()
    except Exception as exc:
        log.warning("certifi unavailable for SSL bootstrap: %s", exc)
        return None

    if not ca_path or not os.path.isfile(ca_path):
        log.warning("certifi CA path missing: %s", ca_path)
        return None

    # Only override when default verification is broken / CA store empty.
    needs_override = False
    try:
        paths = ssl.get_default_verify_paths()
        default_ca = paths.openssl_cafile or ""
        if not default_ca or not os.path.isfile(default_ca) or os.path.getsize(default_ca) == 0:
            needs_override = True
        else:
            # Probe: if default context cannot verify a known public host, use certifi.
            try:
                import socket
                import urllib.request

                ctx = ssl.create_default_context()
                urllib.request.urlopen(
                    "https://api.binance.com/api/v3/ping",
                    context=ctx,
                    timeout=3,
                )
            except Exception:
                needs_override = True
    except Exception:
        needs_override = True

    if needs_override:
        os.environ["SSL_CERT_FILE"] = ca_path
        os.environ.setdefault("REQUESTS_CA_BUNDLE", ca_path)
        os.environ.setdefault("CURL_CA_BUNDLE", ca_path)
        log.info("SSL bootstrap: using certifi CA bundle at %s", ca_path)
    return ca_path if needs_override else os.environ.get("SSL_CERT_FILE")


def make_aiohttp_ssl() -> Union[bool, ssl.SSLContext]:
    """Return an ssl argument suitable for aiohttp ClientSession / ws_connect.

    * ``False`` when ``FLOWMAP_INSECURE_SSL`` is set (skip verify)
    * ``ssl.SSLContext`` with certifi CAs otherwise
    """
    insecure = os.environ.get("FLOWMAP_INSECURE_SSL", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    if insecure:
        return False

    bootstrap_ssl()
    ca = os.environ.get("SSL_CERT_FILE")
    try:
        import certifi

        ca = ca or certifi.where()
        return ssl.create_default_context(cafile=ca)
    except Exception:
        return ssl.create_default_context()


def make_ws_transport(url: str, transport_cls: Any = None) -> Any:
    """Build an AiohttpWsTransport (or compatible) with correct SSL.

    Prefers constructor ``ssl=`` kwarg when available; otherwise wraps connect.
    """
    ssl_arg = make_aiohttp_ssl()
    if transport_cls is None:
        from crypcodile.ingest.transport import AiohttpWsTransport as transport_cls

    try:
        return transport_cls(url, ssl=ssl_arg)
    except TypeError:
        # Older transport without ssl kwarg — subclass at runtime.
        class _SslAwareTransport(transport_cls):  # type: ignore[misc,valid-type]
            def __init__(self, u: str) -> None:
                super().__init__(u)
                self._flowmap_ssl = ssl_arg

            async def connect(self) -> None:
                import aiohttp

                connector = aiohttp.TCPConnector(ssl=self._flowmap_ssl)
                self._session = aiohttp.ClientSession(connector=connector)
                self._ws = await self._session.ws_connect(
                    self._url, heartbeat=20.0, ssl=self._flowmap_ssl
                )

        return _SslAwareTransport(url)
