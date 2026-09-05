"""Observability tests (upgrade wave A2, handoff §6 gap).

``configure_logging`` (called from ``__main__.main``) puts a handler on the
ROOT logger before uvicorn applies its own (root-leaving) dictConfig — without
it, ``flowmap_server.api.ws`` refusal warnings fell through to
``logging.lastResort``: unformatted, stderr-only, never in the log file.
"""

from __future__ import annotations

import logging

import pytest

from flowmap_server import __main__ as entry


@pytest.fixture
def fresh_logging(monkeypatch):
    """Isolate root-logger state; make configure_logging re-configurable."""
    root = logging.getLogger()
    saved_handlers = root.handlers[:]
    saved_level = root.level
    monkeypatch.setattr(entry, "_configured", False)
    yield root
    for h in root.handlers[:]:
        h.close()
        root.removeHandler(h)
    for h in saved_handlers:
        root.addHandler(h)
    root.setLevel(saved_level)


def _flush_and_read(root: logging.Logger, log_path) -> str:
    for h in root.handlers:
        h.flush()
        if isinstance(h, logging.FileHandler):
            h.close()  # release the Windows file lock before reading
    return log_path.read_text(encoding="utf-8")


def test_configure_logging_file_handler_captures_ws_warning(fresh_logging, tmp_path):
    root = fresh_logging
    log_path = tmp_path / "server.log"
    entry.configure_logging("info", str(log_path))

    logging.getLogger("flowmap_server.api.ws").warning(
        "refused subscribe: session limit reached (sim:SIM-X mode=live) -> 1013"
    )
    text = _flush_and_read(root, log_path)
    assert "refused subscribe: session limit reached" in text
    assert "flowmap_server.api.ws" in text
    assert "WARNING" in text  # formatted, not lastResort's bare message


def test_configure_logging_respects_level(fresh_logging, tmp_path):
    root = fresh_logging
    log_path = tmp_path / "server.log"
    entry.configure_logging("warning", str(log_path))
    assert root.level == logging.WARNING

    logging.getLogger("flowmap_server.api.ws").debug("noisy per-message detail")
    assert _flush_and_read(root, log_path) == ""


def test_configure_logging_idempotent(fresh_logging):
    root = fresh_logging
    entry.configure_logging("info")
    n = len(root.handlers)
    entry.configure_logging("info")  # second call must not stack handlers
    assert len(root.handlers) == n
