"""Where a run's evidence lives, and how to put it there without dirtying a repo.

`.dolphin/` is excluded through .git/info/exclude rather than .gitignore
deliberately: info/exclude is per-clone and untracked, so dispatching into a
project never modifies a file that project has committed (spec §7).
"""

from __future__ import annotations

import codecs
from pathlib import Path

RECEIPT_MAX_BYTES = 262_144  # 256KB (spec §7)

_EXCLUDE_LINE = ".dolphin/"
_EXCLUDE_COMMENT = "# Dolphin Tasks run receipts (local only, never committed)"


def receipt_path(workspace_path: str, run_id: str) -> Path:
    return Path(workspace_path) / ".dolphin" / "runs" / run_id / "receipt.md"


def prepare_workspace(workspace_path: str) -> None:
    """Create .dolphin/ and make git ignore it locally. Safe to call repeatedly."""
    workspace = Path(workspace_path)
    (workspace / ".dolphin").mkdir(parents=True, exist_ok=True)

    git_dir = workspace / ".git"
    if not git_dir.is_dir():
        return  # Not a repository; nothing to exclude.

    info_dir = git_dir / "info"
    info_dir.mkdir(parents=True, exist_ok=True)
    exclude = info_dir / "exclude"
    existing = exclude.read_text() if exclude.exists() else ""
    for line in existing.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue  # Blank and comment lines don't count as an active entry.
        if stripped == _EXCLUDE_LINE:
            return  # Already actively excluded; nothing to do.
    prefix = "" if existing.endswith("\n") or existing == "" else "\n"
    exclude.write_text(f"{existing}{prefix}{_EXCLUDE_COMMENT}\n{_EXCLUDE_LINE}\n")


def read_receipt(workspace_path: str, run_id: str) -> tuple[bool, str, bool]:
    """Return (exists, text, truncated). Never raises on a malformed file."""
    path = receipt_path(workspace_path, run_id)
    try:
        raw = path.read_bytes()
    except (FileNotFoundError, NotADirectoryError, PermissionError, OSError):
        return (False, "", False)
    raw_truncated = len(raw) > RECEIPT_MAX_BYTES
    head = raw[:RECEIPT_MAX_BYTES] if raw_truncated else raw
    # A byte-exact cut can land mid multi-byte UTF-8 sequence. Decoding that
    # trailing partial sequence with errors="replace" would turn it into one
    # U+FFFD, which re-encodes to *more* bytes than we cut off, breaking the
    # cap. Feeding the incremental decoder final=False instead makes it hold
    # a genuinely incomplete trailing sequence back rather than replacing it
    # -- so a raw-truncation-induced cut never expands past RECEIPT_MAX_BYTES.
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    text = decoder.decode(head, final=not raw_truncated)
    # Decoding can still push us over the cap even when the raw file was
    # never truncated: bytes that are invalid outright (not just incomplete)
    # -- e.g. a lone continuation byte -- get replaced 1:1 with U+FFFD, which
    # is 3 bytes each, so a file full of invalid UTF-8 can encode to well
    # past RECEIPT_MAX_BYTES on its own. So this check is unconditional, not
    # gated on raw_truncated. Bound it with one extra pass: if the encoding
    # overshot, cut the *encoded* bytes to the cap -- that slice is valid
    # UTF-8 by construction, since every U+FFFD boundary lands on a 3-byte
    # character edge -- and decode that back, tolerating one partial
    # trailing character at the new boundary.
    encoded = text.encode("utf-8")
    expansion_truncated = len(encoded) > RECEIPT_MAX_BYTES
    if expansion_truncated:
        fit_decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        text = fit_decoder.decode(encoded[:RECEIPT_MAX_BYTES], final=False)
    return (True, text, raw_truncated or expansion_truncated)
