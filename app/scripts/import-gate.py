"""Assert that a bundled pyruntime can import everything the server will need.

Run with the BUNDLED interpreter, not the host's::

    app/src-tauri/resources/pyruntime/bin/python3.13 app/scripts/import-gate.py

Why a gate at all: booting the server and polling ``/api/health`` proves only
what it imports EAGERLY. The lazily-imported closure — above all the equity
providers, reached only on a real ``equity:`` subscribe — is invisible to it. A
bundle that lost pandas would boot green and die on the first ``equity:AAPL``.

Why a *file*: this list used to be written twice, once here and once inline in
.github/workflows/release.yml, and the two drifted the first time a target
needed an exception — the release workflow failed on a module the bundler had
been told, correctly, not to ship. One copy, two callers.

Exclusions are declared, never silently dropped: a target whose wheel
availability forces one names it in ``FLOWMAP_SKIP_IMPORTS`` (comma-separated),
or leaves it in the sidecar file this module reads, so the skip is printed in
the log and everything unnamed still has to import.
"""

from __future__ import annotations

import importlib
import os
import pathlib
import sys

# Every module the bundle must be able to import. Eager first, then the lazy
# closure the health poll cannot see.
MODULES = [
    # Eager: loaded the moment the server boots.
    "flowmap_server",
    "numpy",
    "polars",
    "fastapi",
    "uvicorn",
    "msgspec",
    "crocodile",
    "ccxt",
    "aiohttp",
    "certifi",
    # Lazy: imported only on a real subscribe.
    "crocodile.core.connector",
    "crocodile.core.ingest.transport",
    "crocodile.core.schema.records",
    "crocodile.core.scheduler.calendar",
    "crocodile.core.sink.memory",
    "crocodile.crypto.exchanges.factory",
    "crocodile.crypto.client.backfill",
    "crocodile.crypto.exchanges.ccxt_universal.connector",
    "crocodile.crypto.exchanges.binance.backfill",
    "crocodile.equity.providers.factory",
    "crocodile.equity.providers.yahoo.client",
    "crocodile.equity.client.collect",
    "crocodile.equity.depth.vap",
    "pandas",
    "pyarrow",
    "yfinance",
    "bs4",
]

# bundle-python.sh writes the target's exclusions here so a later, separate step
# (the release workflow's smoke test) gates on exactly what was built, without
# being told again. Outside pyruntime/, so it is not carried into the installer.
SKIP_FILE = pathlib.Path(__file__).resolve().parents[1] / "src-tauri" / "resources" / ".import-skip"


def _skips() -> set[str]:
    raw = os.environ.get("FLOWMAP_SKIP_IMPORTS")
    if raw is None and SKIP_FILE.is_file():
        raw = SKIP_FILE.read_text()
    return {name.strip() for name in (raw or "").split(",") if name.strip()}


def main() -> int:
    skip = _skips()
    unknown = skip - set(MODULES)
    if unknown:
        print(f"    ERROR: skip list names modules this gate never checked: {sorted(unknown)}")
        return 2

    ok: list[str] = []
    for module in MODULES:
        if module in skip:
            print(f"    skipped (excluded on this target): {module}")
            continue
        try:
            importlib.import_module(module)
        except Exception as exc:  # noqa: BLE001 - the message is the product here
            print(f"    MISSING: {module}: {exc}")
            raise
        ok.append(module)
    print(f"    imports OK ({len(ok)}): " + ", ".join(ok))
    return 0


if __name__ == "__main__":
    sys.exit(main())
