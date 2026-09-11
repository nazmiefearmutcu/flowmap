"""Loaded before every test module: importing the package applies the Windows
``now_ns`` shim (``flowmap_server._compat``) before any test binds crocodile
names directly."""

import flowmap_server  # noqa: F401
