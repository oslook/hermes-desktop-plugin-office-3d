"""office-3d — agent half.

The plugin is UI-first: the Desktop half (``desktop/plugin.js``) renders the
isometric office and the dashboard half (``dashboard/plugin_api.py``) serves
``/api/plugins/office-3d/state``. This module registers no tools, hooks or
middleware yet — it exists so the package is a proper Hermes plugin package
(``hermes plugins doctor`` and the admission capability probe load it) and so
agent-side surface can be added without restructuring the repo.
"""
from __future__ import annotations


def register(ctx) -> None:  # noqa: ARG001 — no agent-side surface yet
    """Register the plugin with Hermes. Currently contributes nothing."""
    return None
