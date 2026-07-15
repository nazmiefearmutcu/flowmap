"""Tests for SSL bootstrap (empty system CA → certifi)."""

from __future__ import annotations

import os
import ssl
import unittest
from unittest import mock


class TestSslBootstrap(unittest.TestCase):
    def setUp(self) -> None:
        # Reset module bootstrap flag between tests.
        import flowmap.ssl_bootstrap as m

        m._BOOTSTRAPPED = False
        self._env_backup = {
            k: os.environ.get(k)
            for k in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "FLOWMAP_INSECURE_SSL")
        }

    def tearDown(self) -> None:
        import flowmap.ssl_bootstrap as m

        m._BOOTSTRAPPED = False
        for k, v in self._env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_make_aiohttp_ssl_returns_context_or_false(self) -> None:
        from flowmap.ssl_bootstrap import make_aiohttp_ssl

        os.environ.pop("FLOWMAP_INSECURE_SSL", None)
        arg = make_aiohttp_ssl()
        self.assertIsInstance(arg, ssl.SSLContext)

    def test_insecure_env_returns_false(self) -> None:
        from flowmap.ssl_bootstrap import make_aiohttp_ssl
        import flowmap.ssl_bootstrap as m

        m._BOOTSTRAPPED = False
        os.environ["FLOWMAP_INSECURE_SSL"] = "1"
        self.assertIs(make_aiohttp_ssl(), False)

    def test_bootstrap_sets_ssl_cert_file_when_default_broken(self) -> None:
        from flowmap.ssl_bootstrap import bootstrap_ssl
        import flowmap.ssl_bootstrap as m

        m._BOOTSTRAPPED = False
        os.environ.pop("FLOWMAP_INSECURE_SSL", None)
        os.environ.pop("SSL_CERT_FILE", None)

        # Force the "default CA broken" path without network.
        with mock.patch("ssl.get_default_verify_paths") as paths:
            paths.return_value = mock.Mock(
                openssl_cafile="/nonexistent/empty.pem",
                openssl_capath=None,
            )
            with mock.patch("os.path.isfile", return_value=False):
                # isfile False for empty path → needs_override True via missing file
                # but certifi.where() must still be a real file
                import certifi

                real_ca = certifi.where()

                def _isfile(p: str) -> bool:
                    return p == real_ca

                with mock.patch("os.path.isfile", side_effect=_isfile):
                    with mock.patch("os.path.getsize", return_value=0):
                        result = bootstrap_ssl()
        self.assertEqual(result, real_ca)
        self.assertEqual(os.environ.get("SSL_CERT_FILE"), real_ca)


if __name__ == "__main__":
    unittest.main()
