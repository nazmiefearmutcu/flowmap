import os
from flowmap_server.config import Config

def test_defaults():
    cfg = Config.from_env({})
    assert cfg.host == "127.0.0.1"          # spec §11: loopback only, asserted
    assert cfg.port == 8720
    assert cfg.ring_columns == 32_768
    assert cfg.max_sessions == 4
    assert cfg.recording_gb_cap == 20.0
    assert cfg.recording_enabled is True
    assert cfg.alpaca_key is None

def test_env_overrides_and_loopback_assertion():
    cfg = Config.from_env({"FLOWMAP_PORT": "9001", "ALPACA_API_KEY": "k", "ALPACA_API_SECRET": "s"})
    assert cfg.port == 9001 and cfg.alpaca_key == "k"
    import pytest
    with pytest.raises(ValueError):
        Config.from_env({"FLOWMAP_HOST": "0.0.0.0"})   # refuses non-loopback
