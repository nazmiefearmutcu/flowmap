"""FlowMap server numerical core (design spec §8.1–8.2).

:mod:`flowmap_server.core.grid` holds the time-weighted density grid: epoch
management, the float16 column ring, and BarColumn accumulation.
"""

from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg

__all__ = ["FinalizedColumn", "Grid", "GridCfg"]
