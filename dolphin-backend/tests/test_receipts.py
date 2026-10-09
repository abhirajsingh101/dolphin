"""Receipts are evidence, and producing them must not dirty the operator's repo."""

import subprocess

import pytest

from app import receipts


def test_receipt_path_is_run_scoped(tmp_path):
    path = receipts.receipt_path(str(tmp_path), "run_abc")
    assert path == tmp_path / ".dolphin" / "runs" / "run_abc" / "receipt.md"


def test_prepare_workspace_creates_the_directory(tmp_path):
    receipts.prepare_workspace(str(tmp_path))
    assert (tmp_path / ".dolphin").is_dir()


def test_prepare_workspace_excludes_via_git_info_exclude(tmp_path):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    gitignore = tmp_path / ".gitignore"
    gitignore.write_text("node_modules\n")

    receipts.prepare_workspace(str(tmp_path))

    exclude = (tmp_path / ".git" / "info" / "exclude").read_text()
    assert ".dolphin/" in exclude
    # The tracked file must be untouched (spec §7).
    assert gitignore.read_text() == "node_modules\n"


def test_prepare_workspace_is_idempotent(tmp_path):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    receipts.prepare_workspace(str(tmp_path))
    receipts.prepare_workspace(str(tmp_path))
    exclude = (tmp_path / ".git" / "info" / "exclude").read_text()
    assert exclude.count(".dolphin/") == 1


def test_prepare_workspace_ignores_a_comment_that_merely_mentions_dolphin(tmp_path):
    # A comment naming ".dolphin/" as a whitespace-separated token (e.g. from
    # a human editing the file) must not be mistaken for the real, active
    # exclude entry -- only an exact, non-comment line counts as "already
    # excluded".
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    exclude_path = tmp_path / ".git" / "info" / "exclude"
    exclude_path.write_text("# note: .dolphin/ should probably be ignored\n")

    receipts.prepare_workspace(str(tmp_path))

    lines = [line.strip() for line in exclude_path.read_text().splitlines()]
    assert ".dolphin/" in lines


def test_prepare_workspace_tolerates_a_non_git_workspace(tmp_path):
    receipts.prepare_workspace(str(tmp_path))
    assert (tmp_path / ".dolphin").is_dir()
    assert not (tmp_path / ".git").exists()


def test_read_receipt_reports_absence(tmp_path):
    exists, text, truncated = receipts.read_receipt(str(tmp_path), "run_abc")
    assert exists is False
    assert text == ""
    assert truncated is False


def test_read_receipt_returns_content(tmp_path):
    path = receipts.receipt_path(str(tmp_path), "run_abc")
    path.parent.mkdir(parents=True)
    path.write_text("# Done\nChanged two files.\n")
    exists, text, truncated = receipts.read_receipt(str(tmp_path), "run_abc")
    assert exists is True
    assert "Changed two files." in text
    assert truncated is False


def test_read_receipt_truncates_a_runaway_file(tmp_path):
    path = receipts.receipt_path(str(tmp_path), "run_abc")
    path.parent.mkdir(parents=True)
    path.write_text("x" * (receipts.RECEIPT_MAX_BYTES + 5000))
    exists, text, truncated = receipts.read_receipt(str(tmp_path), "run_abc")
    assert exists is True
    assert truncated is True
    assert len(text.encode()) <= receipts.RECEIPT_MAX_BYTES


def test_read_receipt_truncation_never_exceeds_cap_for_multibyte_content(tmp_path):
    # A byte-exact cut can land mid multi-byte UTF-8 sequence. Naively
    # decoding with errors="replace" turns that partial trailing sequence
    # into one U+FFFD, which re-encodes to *more* bytes than were cut off.
    path = receipts.receipt_path(str(tmp_path), "run_abc")
    path.parent.mkdir(parents=True)
    path.write_bytes("日".encode("utf-8") * 100_000)
    exists, text, truncated = receipts.read_receipt(str(tmp_path), "run_abc")
    assert exists is True
    assert truncated is True
    assert len(text.encode()) <= receipts.RECEIPT_MAX_BYTES


def test_read_receipt_truncation_never_exceeds_cap_for_invalid_utf8(tmp_path):
    # Every byte here is invalid outright (a lone UTF-8 continuation byte,
    # not just an incomplete trailing sequence), so errors="replace" maps
    # each one to a single U+FFFD -- which re-encodes to 3 bytes. Naively
    # that would triple the size of the truncated buffer.
    path = receipts.receipt_path(str(tmp_path), "run_abc")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"\x80" * (receipts.RECEIPT_MAX_BYTES + 5000))
    exists, text, truncated = receipts.read_receipt(str(tmp_path), "run_abc")
    assert exists is True
    assert truncated is True
    assert len(text.encode("utf-8")) <= receipts.RECEIPT_MAX_BYTES


def test_read_receipt_never_exceeds_cap_for_invalid_utf8_under_the_raw_cap(tmp_path):
    # The raw file is UNDER RECEIPT_MAX_BYTES (so the raw-truncation branch
    # never fires), but decoding invalid bytes still expands the text 3x on
    # re-encode (262146 > 262144 here) -- the cap check must be unconditional,
    # not gated behind "was the raw file itself oversized".
    path = receipts.receipt_path(str(tmp_path), "run_abc")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"\x80" * 87_382)
    exists, text, truncated = receipts.read_receipt(str(tmp_path), "run_abc")
    assert exists is True
    assert truncated is True
    assert len(text.encode("utf-8")) <= receipts.RECEIPT_MAX_BYTES


def test_read_receipt_never_exceeds_cap_for_invalid_utf8_exactly_at_the_raw_cap(tmp_path):
    # Raw size is exactly RECEIPT_MAX_BYTES, so raw_truncated is False, yet
    # decoding all-invalid bytes expands to 3x the cap on re-encode.
    path = receipts.receipt_path(str(tmp_path), "run_abc")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"\x80" * receipts.RECEIPT_MAX_BYTES)
    exists, text, truncated = receipts.read_receipt(str(tmp_path), "run_abc")
    assert exists is True
    assert truncated is True
    assert len(text.encode("utf-8")) <= receipts.RECEIPT_MAX_BYTES


def test_read_receipt_does_not_over_trim_a_small_invalid_file(tmp_path):
    # A small invalid-UTF-8 file expands on decode (10 bytes -> 30 encoded)
    # but never crosses the cap, so it must be returned whole and untruncated.
    path = receipts.receipt_path(str(tmp_path), "run_abc")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"\x80" * 10)
    exists, text, truncated = receipts.read_receipt(str(tmp_path), "run_abc")
    assert exists is True
    assert truncated is False
    assert len(text.encode("utf-8")) == 30
