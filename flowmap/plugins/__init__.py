"""Plugin system for FlowMap — re-exports the PluginAPI class."""

from .plugin_api import PluginAPI, AddonState

__all__ = ["PluginAPI", "AddonState"]
