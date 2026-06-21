"""
Plugin loader for FlowMap — discovers, imports, and registers
custom indicator plugins from a user-specified directory.

Usage::

    from flowmap.plugins.loader import discover_plugins, load_and_register
    from flowmap.plugins import PluginAPI

    api = PluginAPI(order_book=ob)
    modules = discover_plugins("~/flowmap/plugins")
    for mod in modules:
        load_and_register(api, mod)
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Iterator, List, Optional, Union

from .plugin_api import PluginAPI


def discover_plugins(
    directory: Union[str, Path] = "plugins/",
) -> List[Path]:
    """Scan *directory* for ``.py`` files (excluding ``__init__.py``)
    and return a sorted list of file paths.

    Parameters
    ----------
    directory : str or Path
        Directory to scan.  Expanded (``~`` is resolved) and
        resolved to an absolute path.  Defaults to ``./plugins/``.

    Returns
    -------
    list[Path]
        Sorted list of plugin file paths (empty if the directory
        does not exist or contains no suitable files).
    """
    plugin_dir = Path(directory).expanduser().resolve()
    if not plugin_dir.is_dir():
        return []

    plugins: list[Path] = []
    for entry in sorted(plugin_dir.iterdir()):
        if entry.suffix == ".py" and entry.name != "__init__.py":
            plugins.append(entry)
    return plugins


def load_plugin(filepath: Union[str, Path]) -> Optional[ModuleType]:
    """Import a single plugin module from a ``.py`` file.

    Parameters
    ----------
    filepath : str or Path
        Path to the plugin ``.py`` file.

    Returns
    -------
    ModuleType or None
        The imported module, or ``None`` if the import failed
        (the error is printed to stderr).
    """
    path = Path(filepath).expanduser().resolve()
    if not path.is_file():
        print(f"[FlowMap Plugin] File not found: {path}", file=sys.stderr)
        return None

    # Derive a unique module name from the absolute path
    module_name = f"_flowmap_plugin_{path.stem}_{id(path)}"

    try:
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            print(
                f"[FlowMap Plugin] Could not load spec for {path.name}",
                file=sys.stderr,
            )
            return None

        module = importlib.util.module_from_spec(spec)
        # Add the plugin's directory to sys.path so relative imports
        # inside the plugin work (rare but harmless)
        sys.path.insert(0, str(path.parent))
        try:
            spec.loader.exec_module(module)
        finally:
            if sys.path and sys.path[0] == str(path.parent):
                sys.path.pop(0)

        return module
    except Exception:
        print(
            f"[FlowMap Plugin] Failed to import {path.name}:",
            file=sys.stderr,
        )
        import traceback

        traceback.print_exc(file=sys.stderr)
        return None


def register_plugin(
    api: PluginAPI, module: ModuleType
) -> bool:
    """Connect a loaded plugin module to the *api* by calling its
    ``register(api)`` function.

    The module **must** export a top-level ``register`` function
    that accepts a single argument (the :class:`PluginAPI` instance).

    Parameters
    ----------
    api : PluginAPI
        The API instance to pass to the plugin.
    module : ModuleType
        The imported plugin module.

    Returns
    -------
    bool
        ``True`` if registration succeeded, ``False`` otherwise.
    """
    register_func = getattr(module, "register", None)
    if register_func is None:
        print(
            f"[FlowMap Plugin] {module.__name__} has no `register(api)` "
            f"function — skipping.",
            file=sys.stderr,
        )
        return False

    if not callable(register_func):
        print(
            f"[FlowMap Plugin] {module.__name__}.register is not callable "
            f"— skipping.",
            file=sys.stderr,
        )
        return False

    try:
        register_func(api)
        return True
    except Exception:
        print(
            f"[FlowMap Plugin] {module.__name__}.register() raised an "
            f"exception:",
            file=sys.stderr,
        )
        import traceback

        traceback.print_exc(file=sys.stderr)
        return False


def load_and_register(
    api: PluginAPI,
    filepath: Union[str, Path],
) -> bool:
    """Convenience: load a plugin file and register it in one call.

    Parameters
    ----------
    api : PluginAPI
        The API instance.
    filepath : str or Path
        Path to the plugin ``.py`` file.

    Returns
    -------
    bool
        ``True`` if both loading and registration succeeded.
    """
    module = load_plugin(filepath)
    if module is None:
        return False
    return register_plugin(api, module)


def load_all_from_directory(
    api: PluginAPI,
    directory: Union[str, Path] = "plugins/",
    *,
    quiet: bool = False,
) -> int:
    """Discover, load, and register all plugins in a directory.

    Parameters
    ----------
    api : PluginAPI
        The API instance to pass to each plugin.
    directory : str or Path
        Directory to scan.
    quiet : bool
        If ``True``, suppress "plugin loaded" messages.

    Returns
    -------
    int
        Number of plugins successfully loaded and registered.
    """
    count = 0
    for path in discover_plugins(directory):
        ok = load_and_register(api, path)
        if ok:
            count += 1
            if not quiet:
                print(f"[FlowMap Plugin] Loaded: {path.name}")
        else:
            if not quiet:
                print(
                    f"[FlowMap Plugin] Failed to load: {path.name}",
                    file=sys.stderr,
                )
    return count
