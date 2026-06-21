"""
Exchange configuration for crypto data providers.
"""

from __future__ import annotations
from typing import TypedDict


class ExchangeCfg(TypedDict, total=False):
    """Type-restricted config entry for a single exchange."""

    ws: bool            # WebSocket support available
    rate_limit: int     # API rate limit (requests per minute)
    depth: int          # Default order book depth
    fees: float         # Taker fee as decimal


EXCHANGE_CONFIG: dict[str, ExchangeCfg] = {
    "binance": {
        "ws": True,
        "rate_limit": 1200,
        "depth": 20,
        "fees": 0.001,
    },
    "coinbase": {
        "ws": True,
        "rate_limit": 300,
        "depth": 20,
        "fees": 0.006,
    },
    "kraken": {
        "ws": True,
        "rate_limit": 1000,
        "depth": 10,
        "fees": 0.0026,
    },
    "bybit": {
        "ws": True,
        "rate_limit": 600,
        "depth": 50,
        "fees": 0.001,
    },
    "okx": {
        "ws": True,
        "rate_limit": 600,
        "depth": 20,
        "fees": 0.001,
    },
    "bitmex": {
        "ws": True,
        "rate_limit": 300,
        "depth": 25,
        "fees": 0.00075,
    },
}
