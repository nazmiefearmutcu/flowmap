"""
FlowMap setup.
"""

from setuptools import setup, find_packages

setup(
    name="flowmap",
    version="0.1.0",
    description="Open-source Bookmap-style order flow visualization platform",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    keywords=[
        "order-flow", "bookmap", "trading-visualization", "market-depth",
        "pyqt6", "numpy", "order-book", "liquidity-heatmap", "crypcodile"
    ],
    author="FlowMap Contributors",
    packages=find_packages(),
    install_requires=[
        "PyQt6>=6.5.0",
        "numpy>=1.24.0",
        "pyqtgraph>=0.13.0",
        "sortedcontainers>=2.4.0",
    ],
    extras_require={
        "crypto": ["ccxt>=4.0.0", "aiohttp>=3.8.0"],
        "all": ["ccxt>=4.0.0", "aiohttp>=3.8.0", "websocket-client>=1.6.0"],
    },
    entry_points={
        "console_scripts": [
            "flowmap=flowmap.main:main",
        ],
    },
    python_requires=">=3.10",
)
