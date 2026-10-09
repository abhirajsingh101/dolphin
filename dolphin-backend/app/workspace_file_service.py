"""Secure streaming primitives for terminal-linked workspace downloads."""

from __future__ import annotations

from dataclasses import dataclass, field
import errno
import os
from pathlib import Path
import stat
from typing import Iterator


DEFAULT_STREAM_CHUNK_BYTES = 64 * 1024

_DIRECTORY_OPEN_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_FILE_OPEN_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_NONBLOCK", 0)
)


class WorkspaceFileError(Exception):
    """A bounded, user-facing workspace download error."""

    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass
class OpenedWorkspaceFile:
    fd: int
    name: str
    path: str
    size_bytes: int
    content_type: str = "application/octet-stream"
    _closed: bool = field(default=False, init=False, repr=False)

    def close(self) -> None:
        if self._closed:
            return
        os.close(self.fd)
        self._closed = True


def _path_parts(relative_path: str) -> tuple[str, ...]:
    if "\x00" in relative_path:
        raise WorkspaceFileError("The requested path is invalid.")
    if relative_path == "":
        raise WorkspaceFileError("A file path is required.")
    if relative_path.startswith("/"):
        raise WorkspaceFileError("Absolute paths are not allowed.", 403)

    parts = tuple(relative_path.split("/"))
    if any(part in {"", ".", ".."} for part in parts):
        raise WorkspaceFileError(
            "Only normalized paths inside the workspace are allowed.",
            403 if ".." in parts else 400,
        )
    return parts


def _raise_open_error(error: OSError, *, directory: bool = False) -> None:
    if error.errno == errno.ELOOP:
        raise WorkspaceFileError("Symbolic links cannot be opened.", 403) from error
    if isinstance(error, FileNotFoundError):
        raise WorkspaceFileError("The requested path does not exist.", 404) from error
    if isinstance(error, NotADirectoryError):
        detail = (
            "The requested path is not a directory."
            if directory
            else "A parent path is not a directory."
        )
        raise WorkspaceFileError(detail, 400) from error
    if isinstance(error, PermissionError):
        raise WorkspaceFileError("Permission to read this path was denied.", 403) from error
    raise WorkspaceFileError("The requested path could not be read.", 400) from error


def _open_directory(root: Path, parts: tuple[str, ...]) -> int:
    try:
        current_fd = os.open(root, _DIRECTORY_OPEN_FLAGS)
    except OSError as error:
        _raise_open_error(error, directory=True)
        raise AssertionError("unreachable")

    try:
        for part in parts:
            try:
                component_stat = os.stat(
                    part,
                    dir_fd=current_fd,
                    follow_symlinks=False,
                )
                if stat.S_ISLNK(component_stat.st_mode):
                    raise WorkspaceFileError(
                        "Symbolic links cannot be opened.",
                        403,
                    )
                if not stat.S_ISDIR(component_stat.st_mode):
                    raise WorkspaceFileError(
                        "The requested path is not a directory.",
                        400,
                    )
                next_fd = os.open(
                    part,
                    _DIRECTORY_OPEN_FLAGS,
                    dir_fd=current_fd,
                )
            except WorkspaceFileError:
                raise
            except OSError as error:
                _raise_open_error(error, directory=True)
                raise AssertionError("unreachable")
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except BaseException:
        os.close(current_fd)
        raise


def lstat_within_root(root: Path, relative_path: str) -> os.stat_result:
    """Stat a leaf while refusing symlinked parent components."""

    parts = _path_parts(relative_path)
    parent_fd = _open_directory(root, parts[:-1])
    try:
        return os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
    except OSError as error:
        _raise_open_error(error)
        raise AssertionError("unreachable")
    finally:
        os.close(parent_fd)


def open_workspace_file(root: Path, relative_path: str) -> OpenedWorkspaceFile:
    """Open one regular file under ``root`` without following symlinks."""

    parts = _path_parts(relative_path)
    parent_fd = _open_directory(root, parts[:-1])
    file_fd: int | None = None
    try:
        try:
            path_stat = os.stat(
                parts[-1],
                dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except OSError as error:
            _raise_open_error(error)
            raise AssertionError("unreachable")

        if stat.S_ISLNK(path_stat.st_mode):
            raise WorkspaceFileError("Symbolic links cannot be opened.", 403)
        if not stat.S_ISREG(path_stat.st_mode):
            raise WorkspaceFileError("Only regular files can be downloaded.", 415)

        try:
            file_fd = os.open(parts[-1], _FILE_OPEN_FLAGS, dir_fd=parent_fd)
        except OSError as error:
            _raise_open_error(error)
            raise AssertionError("unreachable")

        opened_stat = os.fstat(file_fd)
        if not stat.S_ISREG(opened_stat.st_mode):
            raise WorkspaceFileError("Only regular files can be downloaded.", 415)

        opened = OpenedWorkspaceFile(
            fd=file_fd,
            name=parts[-1],
            path=relative_path,
            size_bytes=opened_stat.st_size,
        )
        file_fd = None
        return opened
    finally:
        if file_fd is not None:
            os.close(file_fd)
        os.close(parent_fd)


def iter_file_bytes(
    opened: OpenedWorkspaceFile,
    *,
    chunk_size: int = DEFAULT_STREAM_CHUNK_BYTES,
) -> Iterator[bytes]:
    if chunk_size < 1:
        raise ValueError("chunk_size must be positive")
    remaining = opened.size_bytes
    while remaining > 0:
        chunk = os.read(opened.fd, min(chunk_size, remaining))
        if not chunk:
            break
        remaining -= len(chunk)
        yield chunk
