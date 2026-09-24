"""Starts Veyrum's capture in a Python process a test started (see veyrum_capture._install_spawn).

The process finds this module first on its PYTHONPATH; it loads the capture plugin, which reads its
configuration from the environment and restores the PYTHONPATH the test gave, then imports the
environment's own sitecustomize, if there is one, as Python would have.
"""

import os
import sys


def _without(path, directory):
    return [p for p in path if os.path.abspath(p or os.curdir) != directory]


def _boot():
    here = os.path.dirname(os.path.abspath(__file__))
    plugin_dir = os.path.dirname(here)
    this = sys.modules.pop(__name__)
    sys.path[:] = _without(sys.path, here)
    sys.path.insert(0, plugin_dir)
    try:
        import veyrum_capture  # noqa: F401 - starts capture as the environment configures it
    finally:
        sys.path[:] = _without(sys.path, plugin_dir)
    try:
        import sitecustomize  # noqa: F401 - the one this module shadowed
    except ImportError:
        # None: the import system expects this module under its name once it has run.
        sys.modules[__name__] = this


_boot()
