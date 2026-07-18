"""FlowMap wire protocol: canonical events (`events`) and framing (`wire`).

See docs/superpowers/specs/2026-07-17-flowmap-design.md §6 for the
authoritative message semantics. The byte layout in `wire` is mirrored by the
TypeScript client (`client/src/proto/`); golden vectors under
tests/proto/golden/ keep the two implementations in lockstep.
"""

from . import events, wire

__all__ = ["events", "wire"]
