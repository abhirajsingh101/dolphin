"""Frozen entry point for the Dolphin helper (PyInstaller)."""
import os
import sys

# PyInstaller's bootloader points LD_LIBRARY_PATH at the bundle's own libraries
# so this process can load them. Every child inherits it: tmux, ps, git, and the
# user's shells in tmux panes, which then load the bundle's libtinfo and fail
# ("version NCURSES6_TINFO_6.4 not found"). The loader read it at startup
# already, so restoring the user's value here only changes what children see.
if getattr(sys, "frozen", False):
    for name in ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
        original = os.environ.pop(f"{name}_ORIG", None)
        if original is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = original

from app.helper import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
