__version__ = "1.3.1.1"

# Windows lacks time.clock_gettime_ns; rebind crocodile's now_ns before any
# submodule (or test) binds it. Must stay the first import of this package.
from . import _compat  # noqa: E402,F401
