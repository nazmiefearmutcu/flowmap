#!/usr/bin/env python3
"""Launch FlowMap — Bookmap-style order flow visualization."""

import os
import sys

# Auto-detect and re-execute in virtual environment if dependencies are missing globally
try:
    import PyQt6
    import numpy
except ImportError:
    project_dir = os.path.dirname(os.path.abspath(__file__))
    venv_python = os.path.join(project_dir, ".venv", "bin", "python3")
    
    if os.path.exists(venv_python) and sys.executable != venv_python:
        # Re-execute the script using the virtual environment's python interpreter
        os.execv(venv_python, [venv_python] + sys.argv)
    else:
        print("Error: Required dependencies (PyQt6/numpy) are missing, and no local .venv was found.")
        sys.exit(1)

from flowmap.main import main

if __name__ == "__main__":
    main()
