"""Small tmux integration layer for project workspaces."""

import asyncio
import contextlib
import hashlib
import os
import re
import shlex
import shutil
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable


SESSION_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
FIELD_SEPARATOR = r"\037"
RECENT_ACTIVITY_SECONDS = 5
CODEX_START_TIMEOUT_SECONDS = 30.0
CODEX_START_POLL_SECONDS = 0.25


class TmuxServiceError(Exception):
    """User-facing tmux operation failure."""

    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(frozen=True)
class WorkspacePathStatus:
    path: str | None
    path_exists: bool
    is_directory: bool
    is_allowed: bool
    message: str


@dataclass(frozen=True)
class TmuxSessionInfo:
    name: str
    path: str
    created_at: datetime
    windows: int
    attached: bool
    current_command: str | None
    is_codex_running: bool
    is_claude_code_running: bool = False
    has_recent_activity: bool = False
    last_activity_at: datetime | None = None
    observation_degraded: bool = False
    pane_paths: tuple[str, ...] | None = None
    tmux_server_id: str | None = None
    tmux_session_id: str | None = None
    pane_observations: tuple["TmuxPaneObservation", ...] | None = None


@dataclass(frozen=True)
class TmuxSnapshot:
    session_name: str
    content: str
    captured_at: datetime


def workspace_roots() -> list[Path]:
    raw_roots = os.getenv("DOLPHIN_WORKSPACE_ROOTS", "~/projects")
    roots: list[Path] = []
    for raw_root in raw_roots.split(os.pathsep):
        if raw_root.strip():
            roots.append(Path(raw_root).expanduser().resolve())
    return roots


def workspace_path_status(raw_path: str | None) -> WorkspacePathStatus:
    if not raw_path:
        return WorkspacePathStatus(
            path=None,
            path_exists=False,
            is_directory=False,
            is_allowed=False,
            message="No directory is linked to this project.",
        )

    path = Path(raw_path).expanduser()
    resolved = path.resolve()
    exists = resolved.exists()
    is_directory = resolved.is_dir()
    allowed = any(
        resolved == root or root in resolved.parents for root in workspace_roots()
    )
    if not exists:
        message = "The linked directory does not exist on this machine."
    elif not is_directory:
        message = "The linked path exists, but it is not a directory."
    elif not allowed:
        message = "The linked directory is outside the allowed workspace roots."
    else:
        message = "Workspace is ready."

    return WorkspacePathStatus(
        path=str(resolved),
        path_exists=exists,
        is_directory=is_directory,
        is_allowed=allowed,
        message=message,
    )


def require_workspace_path(raw_path: str | None) -> Path:
    status = workspace_path_status(raw_path)
    if not status.path:
        raise TmuxServiceError(status.message)
    if not status.path_exists or not status.is_directory:
        raise TmuxServiceError(status.message)
    if not status.is_allowed:
        raise TmuxServiceError(status.message, status_code=403)
    return Path(status.path)


def _tmux_binary() -> str:
    # Dolphin Desktop points this at its bundled tmux (wrapped to use its own
    # socket) on machines that have none.
    tmux = os.getenv("DOLPHIN_TMUX_BIN") or shutil.which("tmux")
    if not tmux:
        raise TmuxServiceError("tmux is not installed on this machine.", 500)
    return tmux


def tmux_binary() -> str:
    return _tmux_binary()


def _tmux_server_is_absent(stderr: str) -> bool:
    error = stderr.lower()
    return "no server running" in error or (
        "error connecting to" in error and "no such file or directory" in error
    )


async def _run_tmux(*args: str, check: bool = True) -> tuple[int, str, str]:
    process = await asyncio.create_subprocess_exec(
        _tmux_binary(),
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    out = stdout.decode(errors="replace")
    err = stderr.decode(errors="replace")
    code = process.returncode
    if check and code != 0:
        detail = err.strip() or out.strip() or "tmux command failed."
        raise TmuxServiceError(detail)
    return code, out, err


async def _run_tmux_with_input(
    *args: str, input_text: str, check: bool = True
) -> tuple[int, str, str]:
    process = await asyncio.create_subprocess_exec(
        _tmux_binary(),
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate(input_text.encode())
    out = stdout.decode(errors="replace")
    err = stderr.decode(errors="replace")
    code = process.returncode
    if check and code != 0:
        detail = err.strip() or out.strip() or "tmux command failed."
        raise TmuxServiceError(detail)
    return code, out, err


async def _spawn_tmux_detached(*args: str) -> asyncio.Task[int]:
    process = await asyncio.create_subprocess_exec(
        _tmux_binary(),
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )
    return asyncio.create_task(process.wait())


async def _discard_task_exception(task: asyncio.Task[int]) -> None:
    with contextlib.suppress(Exception):
        await task


def _session_name_is_valid(name: str) -> bool:
    return bool(name and SESSION_NAME_RE.fullmatch(name))


def _slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip().lower())
    slug = slug.strip("-._")
    return slug[:36] or "project"


def make_session_name(project_name: str, requested_name: str | None = None) -> str:
    suffix = "-dolphin"
    if requested_name:
        name = requested_name.strip()
        if not _session_name_is_valid(name):
            raise TmuxServiceError(
                "Session names may only contain letters, numbers, dots, dashes, and underscores."
            )
        if name.startswith("dolphin-"):
            return name[:80]
        if name.endswith(suffix):
            name = name[: -len(suffix)]
        return f"{name[: 80 - len(suffix)]}{suffix}"

    return f"{_slugify(project_name)}-{uuid.uuid4().hex[:6]}{suffix}"


def _read_proc_command_text(pid: int) -> str:
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        cmdline = b""

    if cmdline:
        return cmdline.replace(b"\x00", b" ").decode(errors="replace")

    try:
        return Path(f"/proc/{pid}/comm").read_text(errors="replace").strip()
    except OSError:
        return ""


def _read_proc_executable_basename(pid: int) -> str:
    try:
        executable_path = os.readlink(f"/proc/{pid}/exe")
    except OSError:
        return ""
    return Path(executable_path.removesuffix(" (deleted)")).name


def _read_proc_process_name(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text(errors="replace").strip()
    except OSError:
        return ""


def _read_proc_stat_text(pid: int) -> str:
    return Path(f"/proc/{pid}/stat").read_text(errors="replace")


def _read_proc_start_ticks(pid: int) -> int | None:
    """Read Linux proc field 22 without being confused by spaces in comm."""

    try:
        raw = _read_proc_stat_text(pid)
        close = raw.rfind(")")
        if close < 0:
            return None
        # The first token after `comm` is field 3 (state); starttime is field
        # 22, therefore index 19 in this suffix.
        suffix = raw[close + 1 :].split()
        value = int(suffix[19])
        return value if value >= 0 else None
    except (IndexError, OSError, ValueError):
        return None


def _read_proc_fd_identities(
    pid: int,
    *,
    limit: int,
) -> tuple[set[tuple[int, int]], bool]:
    """Return bounded open-file device/inode pairs for one process."""

    identities: set[tuple[int, int]] = set()
    truncated = False
    with os.scandir(f"/proc/{pid}/fd") as entries:
        for index, entry in enumerate(entries):
            if index >= limit:
                truncated = True
                break
            try:
                stat = entry.stat(follow_symlinks=True)
            except OSError:
                continue
            identities.add((stat.st_dev, stat.st_ino))
    return identities, truncated


def _read_proc_child_pids(pid: int) -> list[int]:
    try:
        child_text = Path(f"/proc/{pid}/task/{pid}/children").read_text()
    except OSError:
        return []

    child_pids: list[int] = []
    for raw_pid in child_text.split():
        try:
            child_pids.append(int(raw_pid))
        except ValueError:
            continue
    return child_pids


def _walk_process_tree(
    root_pid: int,
    children_by_parent: dict[int, list[int]] | None = None,
    *,
    limit: int = 200,
):
    seen: set[int] = set()
    stack = [root_pid]
    while stack and len(seen) < limit:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        yield pid
        if children_by_parent is not None:
            child_pids = children_by_parent.get(pid, [])
        else:
            child_pids = _read_proc_child_pids(pid)
        stack.extend(child_pids)


def _process_tree_contains_pattern(
    root_pid: int,
    lowered_pattern: str,
    children_by_parent: dict[int, list[int]] | None = None,
) -> bool:
    for pid in _walk_process_tree(root_pid, children_by_parent):
        if lowered_pattern in _read_proc_command_text(pid).lower():
            return True
    return False


def _process_tree_contains_executable_basename(
    root_pid: int,
    executable_basename: str,
    children_by_parent: dict[int, list[int]] | None = None,
) -> bool:
    target = executable_basename.lower()
    for pid in _walk_process_tree(root_pid, children_by_parent):
        if _read_proc_executable_basename(pid).lower() == target:
            return True
        # Native Claude installs use version filenames; match the same process
        # identity used by the workspace's Claude presence observation.
        if target == "claude" and _read_proc_process_name(pid).lower() == "claude":
            return True
    return False


def _activity_is_recent(raw_timestamp: str, observed_at: int) -> bool:
    try:
        activity_at = int(raw_timestamp)
    except ValueError:
        return False
    age = observed_at - activity_at
    return 0 <= age <= RECENT_ACTIVITY_SECONDS


def _activity_timestamp(raw_timestamp: str) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(raw_timestamp), tz=timezone.utc)
    except (OSError, OverflowError, ValueError):
        return None


_OBSERVE_SEMAPHORE = asyncio.Semaphore(12)


@dataclass(frozen=True)
class TmuxPaneObservation:
    path: str | None
    current_command: str | None
    pid: int | None
    degraded: bool = False
    tmux_server_id: str | None = None
    tmux_session_id: str | None = None
    session_name: str | None = None
    pane_id: str | None = None
    pane_process_start_ticks: int | None = None
    gaps: tuple[str, ...] = ()


# Compatibility for existing internal tests and callers while the richer
# public observation remains opt-in data on TmuxSessionInfo.
_PaneObservation = TmuxPaneObservation


@dataclass(frozen=True)
class TmuxOpenFileObservation:
    agent_pid: int | None
    agent_process_start_ticks: int | None
    open_fd_process_start_ticks: int | None
    exact: bool
    degraded: bool
    gaps: tuple[str, ...]


@dataclass(frozen=True)
class AgentProcessFingerprint:
    """One currently foreground provider process in an exact pane lifetime."""

    provider: str
    pid: int | None
    process_start_ticks: int | None
    pane_foreground_pgid: int | None
    topology_sha256: str | None
    exact: bool
    degraded: bool
    gaps: tuple[str, ...]

    @property
    def agent_pid(self) -> int | None:
        return self.pid

    @property
    def agent_process_start_ticks(self) -> int | None:
        return self.process_start_ticks


def _stable_tmux_server_id(socket_path: str, server_pid: int) -> str:
    material = f"{socket_path}\0server-pid={server_pid}".encode()
    return hashlib.sha256(material).hexdigest()


def _is_supported_agent_process(pid: int) -> bool:
    return (
        _read_proc_executable_basename(pid).lower() == "codex"
        or _read_proc_process_name(pid).lower() == "claude"
    )


def _proc_identity(pid: int) -> tuple[int, int, int] | None:
    """Return process group, foreground group, and start ticks atomically."""

    try:
        raw = _read_proc_stat_text(pid)
    except OSError:
        return None
    closing = raw.rfind(")")
    if closing < 0:
        return None
    fields = raw[closing + 2 :].split()
    # fields begin at Linux stat field 3 (state).
    if len(fields) < 20:
        return None
    try:
        return int(fields[2]), int(fields[5]), int(fields[19])
    except ValueError:
        return None


def _provider_for_pid(pid: int) -> str | None:
    executable = _read_proc_executable_basename(pid).casefold()
    process_name = _read_proc_process_name(pid).casefold()
    if executable == "codex":
        return "codex"
    if process_name == "claude" or executable == "claude":
        return "claude"
    return None


def _bounded_thread_children(
    pid: int,
    *,
    thread_limit: int,
    child_bytes_per_file: int,
    remaining_bytes: list[int],
) -> tuple[list[int], str | None]:
    task_root = f"/proc/{pid}/task"
    try:
        with os.scandir(task_root) as entries:
            tids: list[int] = []
            for entry in entries:
                if len(tids) >= thread_limit:
                    return [], "thread_limit_reached"
                try:
                    tids.append(int(entry.name))
                except ValueError:
                    return [], "proc_topology_invalid"
    except OSError:
        return [], "proc_topology_unreadable"
    children: list[int] = []
    for tid in sorted(tids):
        if remaining_bytes[0] <= 0:
            return [], "child_bytes_limit_reached"
        limit = min(child_bytes_per_file, remaining_bytes[0])
        try:
            descriptor = os.open(
                f"{task_root}/{tid}/children",
                os.O_RDONLY | getattr(os, "O_CLOEXEC", 0),
            )
            try:
                payload = os.read(descriptor, limit + 1)
            finally:
                os.close(descriptor)
        except OSError:
            return [], "proc_topology_unreadable"
        remaining_bytes[0] -= min(len(payload), limit)
        if len(payload) > limit:
            return [], "child_bytes_limit_reached"
        try:
            raw_children = payload.decode("ascii").split()
            children.extend(int(value) for value in raw_children)
        except (UnicodeDecodeError, ValueError):
            return [], "proc_topology_invalid"
    return children, None


def _foreground_process_scan(
    pane_pid: int,
    provider: str,
    *,
    process_limit: int,
    thread_limit: int,
    child_bytes_per_file: int,
    child_bytes_total: int,
) -> tuple[tuple[int, int, int] | None, str | None, str | None]:
    pane_identity = _proc_identity(pane_pid)
    if pane_identity is None:
        return None, None, "pane_process_unavailable"
    _pane_pgrp, foreground_pgid, _pane_start = pane_identity
    if foreground_pgid <= 0:
        return None, None, "foreground_group_unavailable"
    remaining_bytes = [child_bytes_total]
    stack = [pane_pid]
    seen: set[int] = set()
    topology: list[tuple[int, tuple[int, ...]]] = []
    matches: list[tuple[int, int, int]] = []
    while stack:
        if len(seen) >= process_limit:
            return None, None, "process_limit_reached"
        pid = stack.pop()
        if pid in seen:
            continue
        identity = _proc_identity(pid)
        if identity is None:
            return None, None, "proc_identity_unavailable"
        seen.add(pid)
        children, error = _bounded_thread_children(
            pid,
            thread_limit=thread_limit,
            child_bytes_per_file=child_bytes_per_file,
            remaining_bytes=remaining_bytes,
        )
        if error is not None:
            return None, None, error
        unique_children = tuple(sorted(set(children)))
        topology.append((pid, unique_children))
        stack.extend(reversed(unique_children))
        if _provider_for_pid(pid) == provider and identity[0] == foreground_pgid:
            matches.append((pid, identity[2], foreground_pgid))
            if len(matches) > 1:
                return None, None, "provider_ambiguous"
    if len(matches) != 1:
        return None, None, "provider_not_foreground"
    topology_sha256 = hashlib.sha256(
        repr(sorted(topology)).encode("ascii")
    ).hexdigest()
    return matches[0], topology_sha256, None


def observe_agent_process_fingerprint(
    pane_pid: int,
    provider: str,
    *,
    process_limit: int = 200,
    thread_limit: int = 512,
    child_bytes_per_file: int = 4096,
    child_bytes_total: int = 64 * 1024,
) -> AgentProcessFingerprint:
    """Prove one unchanged foreground Codex or Claude across two full scans."""

    if pane_pid <= 0 or provider not in {"codex", "claude"}:
        return AgentProcessFingerprint(
            provider=provider,
            pid=None,
            process_start_ticks=None,
            pane_foreground_pgid=None,
            topology_sha256=None,
            exact=False,
            degraded=True,
            gaps=("invalid_process_identity",),
        )
    process_limit = max(1, min(process_limit, 512))
    thread_limit = max(1, min(thread_limit, 1024))
    child_bytes_per_file = max(32, min(child_bytes_per_file, 16 * 1024))
    child_bytes_total = max(256, min(child_bytes_total, 256 * 1024))
    first, first_topology, error = _foreground_process_scan(
        pane_pid,
        provider,
        process_limit=process_limit,
        thread_limit=thread_limit,
        child_bytes_per_file=child_bytes_per_file,
        child_bytes_total=child_bytes_total,
    )
    if error is not None or first is None:
        return AgentProcessFingerprint(
            provider=provider,
            pid=None,
            process_start_ticks=None,
            pane_foreground_pgid=None,
            topology_sha256=first_topology,
            exact=False,
            degraded=True,
            gaps=(error or "provider_unavailable",),
        )
    second, second_topology, error = _foreground_process_scan(
        pane_pid,
        provider,
        process_limit=process_limit,
        thread_limit=thread_limit,
        child_bytes_per_file=child_bytes_per_file,
        child_bytes_total=child_bytes_total,
    )
    if error is not None or second is None:
        gap = error or "provider_unavailable"
    elif first != second:
        gap = "provider_identity_changed"
    elif first_topology != second_topology:
        gap = "provider_topology_changed"
    else:
        pid, start_ticks, foreground_pgid = first
        return AgentProcessFingerprint(
            provider=provider,
            pid=pid,
            process_start_ticks=start_ticks,
            pane_foreground_pgid=foreground_pgid,
            topology_sha256=first_topology,
            exact=True,
            degraded=False,
            gaps=(),
        )
    return AgentProcessFingerprint(
        provider=provider,
        pid=None,
        process_start_ticks=None,
        pane_foreground_pgid=None,
        topology_sha256=second_topology,
        exact=False,
        degraded=True,
        gaps=(gap,),
    )


def observe_open_file_agent(
    pane_pid: int,
    *,
    target_device: int,
    target_inode: int,
    process_limit: int = 200,
    fd_limit: int = 256,
) -> TmuxOpenFileObservation:
    """Observe a supported descendant holding one exact file identity.

    This is a bounded read-only `/proc` probe. It does not open the target
    transcript and it binds a matching descriptor to an unchanged process
    start time so PID reuse cannot establish exactness.
    """

    if pane_pid <= 0 or target_device < 0 or target_inode < 0:
        return TmuxOpenFileObservation(
            agent_pid=None,
            agent_process_start_ticks=None,
            open_fd_process_start_ticks=None,
            exact=False,
            degraded=True,
            gaps=("invalid_process_identity",),
        )
    process_limit = max(1, min(process_limit, 200))
    fd_limit = max(1, min(fd_limit, 256))
    gaps: list[str] = []
    try:
        processes = tuple(_walk_process_tree(pane_pid, limit=process_limit))
        if len(processes) >= process_limit:
            gaps.append("process_limit_reached")
        for pid in processes:
            if not _is_supported_agent_process(pid):
                continue
            start_before = _read_proc_start_ticks(pid)
            if start_before is None:
                if "proc_start_unavailable" not in gaps:
                    gaps.append("proc_start_unavailable")
                continue
            identities, truncated = _read_proc_fd_identities(pid, limit=fd_limit)
            if truncated and "fd_limit_reached" not in gaps:
                gaps.append("fd_limit_reached")
            if (target_device, target_inode) not in identities:
                continue
            start_after = _read_proc_start_ticks(pid)
            if start_after is None:
                return TmuxOpenFileObservation(
                    agent_pid=pid,
                    agent_process_start_ticks=start_before,
                    open_fd_process_start_ticks=None,
                    exact=False,
                    degraded=True,
                    gaps=("proc_start_unavailable",),
                )
            if start_after != start_before:
                return TmuxOpenFileObservation(
                    agent_pid=pid,
                    agent_process_start_ticks=start_before,
                    open_fd_process_start_ticks=start_after,
                    exact=False,
                    degraded=True,
                    gaps=("pid_reuse",),
                )
            return TmuxOpenFileObservation(
                agent_pid=pid,
                agent_process_start_ticks=start_before,
                open_fd_process_start_ticks=start_after,
                exact=True,
                degraded=bool(gaps),
                gaps=tuple(gaps),
            )
    except (OSError, RuntimeError, ValueError):
        return TmuxOpenFileObservation(
            agent_pid=None,
            agent_process_start_ticks=None,
            open_fd_process_start_ticks=None,
            exact=False,
            degraded=True,
            gaps=("proc_unavailable",),
        )
    if "transcript_fd_not_open" not in gaps:
        gaps.append("transcript_fd_not_open")
    return TmuxOpenFileObservation(
        agent_pid=None,
        agent_process_start_ticks=None,
        open_fd_process_start_ticks=None,
        exact=False,
        degraded=any(
            gap in {"process_limit_reached", "fd_limit_reached", "proc_start_unavailable"}
            for gap in gaps
        ),
        gaps=tuple(gaps),
    )


def _pane_pids_containing_pattern(
    pane_pids: tuple[int, ...] | list[int],
    pattern: str,
) -> set[int]:
    lowered_pattern = pattern.lower()
    matched: set[int] = set()
    for pane_pid in pane_pids:
        if _process_tree_contains_pattern(pane_pid, lowered_pattern):
            matched.add(pane_pid)
    return matched


def _pane_pids_containing_executable_basename(
    pane_pids: tuple[int, ...] | list[int],
    executable_basename: str,
) -> set[int]:
    matched: set[int] = set()
    for pane_pid in pane_pids:
        if _process_tree_contains_executable_basename(
            pane_pid,
            executable_basename,
        ):
            matched.add(pane_pid)
    return matched


def _pane_pids_containing_supported_agents(
    pane_pids: tuple[int, ...] | list[int],
) -> tuple[set[int], set[int]]:
    codex_pids: set[int] = set()
    claude_code_pids: set[int] = set()
    for pane_pid in pane_pids:
        has_codex = False
        has_claude_code = False
        for pid in _walk_process_tree(pane_pid):
            if _read_proc_executable_basename(pid).lower() == "codex":
                has_codex = True
            if _read_proc_process_name(pid).lower() == "claude":
                has_claude_code = True
        if has_codex:
            codex_pids.add(pane_pid)
        if has_claude_code:
            claude_code_pids.add(pane_pid)
    return codex_pids, claude_code_pids


async def _load_all_pane_observations() -> tuple[
    dict[str, list[TmuxPaneObservation]],
    set[int],
    set[int],
    bool,
]:
    fmt = FIELD_SEPARATOR.join(
        [
            "#{socket_path}",
            "#{pid}",
            "#{session_id}",
            "#{session_name}",
            "#{pane_id}",
            "#{pane_current_path}",
            "#{pane_current_command}",
            "#{pane_pid}",
        ]
    )
    code, out, err = await _run_tmux(
        "list-panes",
        "-a",
        "-F",
        fmt,
        check=False,
    )
    if code != 0:
        raise TmuxServiceError(err.strip() or "Could not inspect tmux panes.")

    by_session: dict[str, list[TmuxPaneObservation]] = {}
    malformed = False
    pane_pids: list[int] = []
    for line in out.splitlines():
        parts = line.split(FIELD_SEPARATOR)
        legacy_row = len(parts) == 4
        if legacy_row:
            # Keep the pre-08-09 observation contract consumable by isolated
            # callers while treating every absent stable identity as a typed
            # degradation. The command issued above always requests the rich
            # format; this branch never weakens exact attribution.
            session_name, raw_path, raw_command, raw_pid = parts
            socket_path = raw_server_pid = session_id = pane_id = ""
        elif len(parts) == 8:
            (
                socket_path,
                raw_server_pid,
                session_id,
                session_name,
                pane_id,
                raw_path,
                raw_command,
                raw_pid,
            ) = parts
        else:
            malformed = True
            continue
        degraded = False
        gaps: list[str] = []
        try:
            server_pid = int(raw_server_pid)
            if server_pid <= 0 or not socket_path:
                raise ValueError
            server_id = _stable_tmux_server_id(socket_path, server_pid)
        except ValueError:
            server_id = None
            degraded = True
            gaps.append("tmux_server_identity_unavailable")
        if not session_id:
            degraded = True
            gaps.append("tmux_session_identity_unavailable")
        if not pane_id:
            degraded = True
            gaps.append("tmux_pane_identity_unavailable")
        resolved_path: str | None
        try:
            resolved_path = str(Path(raw_path).expanduser().resolve())
        except (OSError, RuntimeError, ValueError):
            resolved_path = None
            degraded = True
        try:
            pane_pid = int(raw_pid)
            if pane_pid <= 0:
                raise ValueError
            pane_pids.append(pane_pid)
        except ValueError:
            pane_pid = None
            degraded = True
            gaps.append("pane_pid_unavailable")
        pane_start = (
            _read_proc_start_ticks(pane_pid)
            if pane_pid is not None and not legacy_row
            else None
        )
        if pane_start is None:
            degraded = True
            gaps.append("proc_start_unavailable")
        by_session.setdefault(session_name, []).append(
            TmuxPaneObservation(
                path=resolved_path,
                current_command=raw_command.strip() or None,
                pid=pane_pid,
                degraded=degraded,
                tmux_server_id=server_id,
                tmux_session_id=session_id or None,
                session_name=session_name,
                pane_id=pane_id or None,
                pane_process_start_ticks=pane_start,
                gaps=tuple(gaps),
            )
        )

    process_probe_degraded = False
    try:
        codex_pids, claude_code_pids = await asyncio.to_thread(
            _pane_pids_containing_supported_agents,
            tuple(pane_pids),
        )
    except (OSError, RuntimeError, ValueError):
        codex_pids = set()
        claude_code_pids = set()
        process_probe_degraded = True

    # Bind the process classification to the same PID lifetime observed in the
    # tmux row.  A process may exit or its PID may be reused while the bounded
    # descendant scan is running; neither condition may retain an exact agent
    # observation.
    for session_name, observations in tuple(by_session.items()):
        verified: list[TmuxPaneObservation] = []
        for observation in observations:
            if observation.pid is None or observation.pane_process_start_ticks is None:
                verified.append(observation)
                continue
            start_after = _read_proc_start_ticks(observation.pid)
            if start_after == observation.pane_process_start_ticks:
                verified.append(observation)
                continue
            codex_pids.discard(observation.pid)
            claude_code_pids.discard(observation.pid)
            gap = "proc_start_unavailable" if start_after is None else "pid_reuse"
            verified.append(
                replace(
                    observation,
                    degraded=True,
                    pane_process_start_ticks=None,
                    gaps=tuple(dict.fromkeys((*observation.gaps, gap))),
                )
            )
        by_session[session_name] = verified
    return (
        by_session,
        codex_pids,
        claude_code_pids,
        malformed
        or process_probe_degraded
        or any(row.degraded for rows in by_session.values() for row in rows),
    )


async def _build_session_info(
    parts: list[str],
    observed_at: int,
    pane_observations: list[TmuxPaneObservation] | None = None,
    codex_pids: set[int] | None = None,
    claude_code_pids: set[int] | None = None,
    pane_probe_degraded: bool = False,
) -> "TmuxSessionInfo | None":
    if len(parts) != 6:
        return None
    name, path, created_raw, windows_raw, attached_raw, activity_raw = parts
    observations = pane_observations or []
    observation_degraded = (
        pane_probe_degraded
        or not observations
        or any(observation.degraded for observation in observations)
    )
    current_command = next(
        (
            observation.current_command
            for observation in observations
            if observation.current_command
        ),
        None,
    )
    detected_codex_pids = codex_pids or set()
    detected_claude_code_pids = claude_code_pids or set()
    is_codex_running = any(
        observation.pid is not None
        and observation.pid in detected_codex_pids
        for observation in observations
    )
    is_claude_code_running = any(
        observation.pid is not None
        and observation.pid in detected_claude_code_pids
        for observation in observations
    )
    pane_paths = tuple(
        dict.fromkeys(
            observation.path
            for observation in observations
            if observation.path is not None
        )
    )
    server_ids = {
        observation.tmux_server_id
        for observation in observations
        if observation.tmux_server_id is not None
    }
    session_ids = {
        observation.tmux_session_id
        for observation in observations
        if observation.tmux_session_id is not None
    }
    tmux_server_id = next(iter(server_ids)) if len(server_ids) == 1 else None
    tmux_session_id = next(iter(session_ids)) if len(session_ids) == 1 else None
    if len(server_ids) > 1 or len(session_ids) > 1:
        observation_degraded = True
    try:
        resolved_path = str(Path(path).expanduser().resolve())
    except (OSError, RuntimeError, ValueError):
        resolved_path = path
        observation_degraded = True
    try:
        created_at = datetime.fromtimestamp(int(created_raw), tz=timezone.utc)
    except (OSError, ValueError):
        return None
    return TmuxSessionInfo(
        name=name,
        path=resolved_path,
        created_at=created_at,
        windows=int(windows_raw or 0),
        attached=attached_raw not in ("", "0"),
        current_command=current_command,
        is_codex_running=is_codex_running,
        is_claude_code_running=is_claude_code_running,
        has_recent_activity=_activity_is_recent(activity_raw, observed_at),
        last_activity_at=_activity_timestamp(activity_raw),
        observation_degraded=observation_degraded,
        pane_paths=pane_paths,
        tmux_server_id=tmux_server_id,
        tmux_session_id=tmux_session_id,
        pane_observations=tuple(observations),
    )


_SESSIONS_CACHE: dict = {"at": 0.0, "data": None}
_SESSIONS_CACHE_TTL = 2.0
_SESSIONS_CACHE_LOCK = asyncio.Lock()


def _invalidate_sessions_cache() -> None:
    _SESSIONS_CACHE["data"] = None
    _SESSIONS_CACHE["at"] = 0.0


async def _refresh_sessions_cache() -> list[TmuxSessionInfo]:
    async with _SESSIONS_CACHE_LOCK:
        result = await _list_all_sessions_uncached()
        _SESSIONS_CACHE["data"] = result
        _SESSIONS_CACHE["at"] = asyncio.get_running_loop().time()
        return result


async def list_all_sessions() -> list[TmuxSessionInfo]:
    loop = asyncio.get_running_loop()
    cache = _SESSIONS_CACHE
    if cache["data"] is not None and (loop.time() - cache["at"]) < _SESSIONS_CACHE_TTL:
        return cache["data"]
    async with _SESSIONS_CACHE_LOCK:
        if cache["data"] is not None and (loop.time() - cache["at"]) < _SESSIONS_CACHE_TTL:
            return cache["data"]
        result = await _list_all_sessions_uncached()
        cache["data"] = result
        cache["at"] = loop.time()
        return result


async def _list_all_sessions_uncached() -> list[TmuxSessionInfo]:
    fmt = FIELD_SEPARATOR.join(
        [
            "#{session_name}",
            "#{session_path}",
            "#{session_created}",
            "#{session_windows}",
            "#{session_attached}",
            "#{window_activity}",
        ]
    )
    code, out, err = await _run_tmux("list-sessions", "-F", fmt, check=False)
    if code != 0:
        if _tmux_server_is_absent(err):
            return []
        raise TmuxServiceError(err.strip() or "Could not list tmux sessions.")

    observed_at = int(datetime.now(tz=timezone.utc).timestamp())
    rows = [line.split(FIELD_SEPARATOR) for line in out.splitlines()]
    try:
        (
            pane_observations,
            codex_pids,
            claude_code_pids,
            pane_probe_degraded,
        ) = (
            await _load_all_pane_observations()
        )
    except (OSError, RuntimeError, ValueError, TmuxServiceError):
        pane_observations = {}
        codex_pids = set()
        claude_code_pids = set()
        pane_probe_degraded = True
    built = await asyncio.gather(
        *(
            _build_session_info(
                parts,
                observed_at,
                pane_observations.get(parts[0], []) if parts else [],
                codex_pids,
                claude_code_pids,
                pane_probe_degraded,
            )
            for parts in rows
        )
    )
    return [s for s in built if s is not None]


async def _session_matches_workspace(
    session: TmuxSessionInfo, resolved: Path
) -> "TmuxSessionInfo | None":
    session_paths = [Path(session.path).expanduser().resolve()]
    if session.pane_paths is None:
        async with _OBSERVE_SEMAPHORE:
            session_paths.extend(await pane_current_paths(session.name))
    else:
        session_paths.extend(
            Path(path).expanduser().resolve() for path in session.pane_paths
        )
    if any(path == resolved or resolved in path.parents for path in session_paths):
        return session
    return None


async def list_workspace_sessions(workspace_path: Path) -> list[TmuxSessionInfo]:
    resolved = workspace_path.resolve()
    all_sessions = await list_all_sessions()
    matched = await asyncio.gather(
        *(_session_matches_workspace(s, resolved) for s in all_sessions)
    )
    return [s for s in matched if s is not None]


async def pane_current_command(
    session_name: str,
    *,
    strict: bool = False,
) -> str | None:
    code, out, err = await _run_tmux(
        "list-panes",
        "-t",
        session_name,
        "-F",
        "#{pane_current_command}",
        check=False,
    )
    if code != 0:
        if strict:
            raise TmuxServiceError(
                err.strip() or f"Could not inspect the current command for {session_name}."
            )
        return None
    commands = [line.strip() for line in out.splitlines() if line.strip()]
    if not commands:
        if strict:
            raise TmuxServiceError(
                f"Could not inspect the current command for {session_name}."
            )
        return None
    return commands[0]


async def pane_current_paths(
    session_name: str,
    *,
    strict: bool = False,
) -> list[Path]:
    code, out, err = await _run_tmux(
        "list-panes",
        "-t",
        session_name,
        "-F",
        "#{pane_current_path}",
        check=False,
    )
    if code != 0:
        if strict:
            raise TmuxServiceError(
                err.strip() or f"Could not inspect panes for {session_name}."
            )
        return []

    paths: list[Path] = []
    for line in out.splitlines():
        raw_path = line.strip()
        if not raw_path:
            continue
        try:
            paths.append(Path(raw_path).expanduser().resolve())
        except (OSError, RuntimeError, ValueError) as error:
            if strict:
                raise TmuxServiceError(
                    f"Could not resolve a pane path for {session_name}."
                ) from error
            continue
    return paths


async def pane_contains_process(
    session_name: str,
    pattern: str,
    *,
    strict: bool = False,
) -> bool:
    code, out, err = await _run_tmux(
        "list-panes",
        "-t",
        session_name,
        "-F",
        FIELD_SEPARATOR.join(["#{pane_current_command}", "#{pane_pid}"]),
        check=False,
    )
    if code != 0:
        if strict:
            raise TmuxServiceError(
                err.strip() or f"Could not inspect processes for {session_name}."
            )
        return False

    lowered_pattern = pattern.lower()
    for line in out.splitlines():
        parts = line.split(FIELD_SEPARATOR)
        if len(parts) != 2:
            if strict:
                raise TmuxServiceError(
                    f"Could not inspect processes for {session_name}."
                )
            continue
        command, pid_raw = parts
        if lowered_pattern in command.lower():
            return True
        try:
            pane_pid = int(pid_raw)
        except ValueError as error:
            if strict:
                raise TmuxServiceError(
                    f"Could not inspect processes for {session_name}."
                ) from error
            continue
        if await asyncio.to_thread(
            _process_tree_contains_pattern, pane_pid, lowered_pattern
        ):
            return True
    return False


async def pane_contains_executable(
    session_name: str,
    executable_basename: str,
    *,
    strict: bool = False,
) -> bool:
    code, out, err = await _run_tmux(
        "list-panes",
        "-t",
        session_name,
        "-F",
        "#{pane_pid}",
        check=False,
    )
    if code != 0:
        if strict:
            raise TmuxServiceError(
                err.strip() or f"Could not inspect processes for {session_name}."
            )
        return False

    for pid_raw in out.splitlines():
        try:
            pane_pid = int(pid_raw)
        except ValueError as error:
            if strict:
                raise TmuxServiceError(
                    f"Could not inspect processes for {session_name}."
                ) from error
            continue
        if await asyncio.to_thread(
            _process_tree_contains_executable_basename,
            pane_pid,
            executable_basename,
        ):
            return True
    return False


async def require_workspace_session(
    workspace_path: Path, session_name: str
) -> TmuxSessionInfo:
    if not _session_name_is_valid(session_name):
        raise TmuxServiceError("Invalid tmux session name.")
    session = next(
        (
            candidate
            for candidate in await _refresh_sessions_cache()
            if candidate.name == session_name
        ),
        None,
    )
    if session is None:
        raise TmuxServiceError("That tmux session is no longer available.", 404)
    matched = await _session_matches_workspace(
        session,
        workspace_path.expanduser().resolve(),
    )
    if matched is not None:
        return matched
    raise TmuxServiceError("That tmux session does not belong to this project.", 409)


async def create_session(
    workspace_path: Path,
    project_name: str,
    requested_name: str | None = None,
    mode: str = "shell",
) -> TmuxSessionInfo:
    session_name = make_session_name(project_name, requested_name)
    if mode not in {"shell", "codex", "claude"}:
        raise TmuxServiceError("Unsupported tmux session mode.")

    if any(session.name == session_name for session in await list_all_sessions()):
        raise TmuxServiceError("A tmux session with that name already exists.")

    args = [
        "new-session",
        "-d",
        "-x",
        "132",
        "-y",
        "36",
        "-s",
        session_name,
        "-c",
        str(workspace_path),
    ]

    wait_task = await _spawn_tmux_detached(*args)
    asyncio.create_task(_discard_task_exception(wait_task))
    _invalidate_sessions_cache()

    created_session: TmuxSessionInfo | None = None
    for _ in range(24):
        await asyncio.sleep(0.15)
        try:
            created_session = await require_workspace_session(
                workspace_path,
                session_name,
            )
            break
        except TmuxServiceError:
            if wait_task.done() and wait_task.result() != 0:
                raise TmuxServiceError("Could not create tmux session.")
            pass
    if created_session is None:
        created_session = await require_workspace_session(
            workspace_path,
            session_name,
        )
    if mode == "codex":
        await start_codex(workspace_path, session_name)
        return await require_workspace_session(workspace_path, session_name)
    if mode == "claude":
        await start_claude(workspace_path, session_name)
        return await require_workspace_session(workspace_path, session_name)
    return created_session


async def rename_session(
    workspace_path: Path,
    project_name: str,
    current_name: str,
    requested_name: str,
) -> TmuxSessionInfo:
    final_name = make_session_name(project_name, requested_name)
    current_session = await require_workspace_session(
        workspace_path,
        current_name,
    )
    if final_name == current_name:
        return current_session

    if any(session.name == final_name for session in await list_all_sessions()):
        raise TmuxServiceError(
            "A tmux session with that name already exists.",
            409,
        )

    code, out, err = await _run_tmux(
        "rename-session",
        "-t",
        f"={current_name}",
        final_name,
        check=False,
    )
    if code != 0:
        detail = err.strip() or out.strip() or "Could not rename tmux session."
        normalized_detail = detail.lower()
        if "duplicate session" in normalized_detail:
            raise TmuxServiceError(
                "A tmux session with that name already exists.",
                409,
            )
        if (
            "can't find session" in normalized_detail
            or "no such session" in normalized_detail
        ):
            raise TmuxServiceError(
                "That tmux session is no longer available.",
                404,
            )
        raise TmuxServiceError(detail)

    _invalidate_sessions_cache()
    return await require_workspace_session(workspace_path, final_name)


async def kill_session(workspace_path: Path, session_name: str) -> None:
    await require_workspace_session(workspace_path, session_name)
    await _run_tmux("kill-session", "-t", session_name)
    _invalidate_sessions_cache()


async def send_input(
    workspace_path: Path,
    session_name: str,
    text: str,
    enter: bool = True,
    *,
    require_codex: bool = False,
    require_agent: bool = False,
    before_enter: Callable[[], Awaitable[bool]] | None = None,
) -> bool:
    session = await require_workspace_session(workspace_path, session_name)
    if require_agent:
        _require_observable_agent_session(session)
    if require_codex:
        _require_observable_codex_session(session)
    if enter:
        if text:
            await asyncio.sleep(5)
        if require_codex or require_agent:
            session = await require_workspace_session(
                workspace_path,
                session_name,
            )
            if require_agent:
                _require_observable_agent_session(session)
            if require_codex:
                _require_observable_codex_session(session)
    if text:
        buffer_name = f"dolphin-input-{uuid.uuid4().hex}"
        await _run_tmux_with_input(
            "load-buffer",
            "-b",
            buffer_name,
            "-",
            input_text=text,
        )
        try:
            if before_enter is not None and not await before_enter():
                await _run_tmux("delete-buffer", "-b", buffer_name, check=False)
                return False
            # tmux routes send-keys to copy/view mode instead of the process.
            # Pasting still reaches Codex in that state, which can leave a full
            # prompt visibly stranded in its editor while Enter is swallowed.
            # Leave any pane mode immediately before the atomic paste+submit.
            await _run_tmux(
                "send-keys",
                "-t",
                session_name,
                "-X",
                "cancel",
                check=False,
            )
            paste_args = [
                "paste-buffer",
                "-d",
                "-p",
                "-r",
                "-b",
                buffer_name,
                "-t",
                session_name,
            ]
            if enter:
                paste_args.extend(
                    [";", "send-keys", "-t", session_name, "C-m"]
                )
            await _run_tmux(*paste_args)
        except Exception:
            with contextlib.suppress(Exception):
                await _run_tmux("delete-buffer", "-b", buffer_name, check=False)
            raise
    elif enter:
        if before_enter is not None and not await before_enter():
            return False
        await _run_tmux("send-keys", "-t", session_name, "C-m")
    return True


def _require_observable_agent_session(session: TmuxSessionInfo) -> None:
    if session.observation_degraded or not (session.is_codex_running or session.is_claude_code_running):
        raise TmuxServiceError("No observable Codex or Claude agent in this session; no input was sent.", 409)


def _require_observable_codex_session(session: TmuxSessionInfo) -> None:
    if session.observation_degraded:
        raise TmuxServiceError(
            "Dolphin could not safely verify the linked Codex session.",
            503,
        )
    if not session.is_codex_running:
        if session.is_claude_code_running:
            # This path only continues an existing Codex conversation. A
            # Claude Code session (e.g. the operator's task-owned session,
            # which tracked runs now launch) is running something real, just
            # not Codex -- saying "Codex is not running" here would be
            # literally true and practically wrong: it is this operator's
            # only signal for an entire class of untracked dispatch, and it
            # was pointing at the wrong agent.
            raise TmuxServiceError(
                "Claude Code is running in the linked task session, not "
                "Codex. This action only continues an existing Codex "
                "session.",
                409,
            )
        raise TmuxServiceError(
            "Codex is not running in the linked task session.",
            409,
        )


async def send_key(workspace_path: Path, session_name: str, key: str) -> None:
    await require_workspace_session(workspace_path, session_name)
    allowed_keys = {
        "Enter",
        "C-c",
        "C-d",
        "Escape",
        "Up",
        "Down",
        "Left",
        "Right",
        "BSpace",
        "Tab",
    }
    if key not in allowed_keys:
        raise TmuxServiceError("Unsupported key.")
    await _run_tmux("send-keys", "-t", session_name, key)


async def send_terminal_data(
    workspace_path: Path,
    session_name: str,
    data: str,
) -> None:
    await require_workspace_session(workspace_path, session_name)

    i = 0
    text_buffer: list[str] = []

    async def flush_text() -> None:
        if not text_buffer:
            return
        text = "".join(text_buffer)
        text_buffer.clear()
        await _run_tmux("send-keys", "-t", session_name, "-l", text)

    while i < len(data):
        if data.startswith("\x1b[A", i):
            await flush_text()
            await _run_tmux("send-keys", "-t", session_name, "Up")
            i += 3
        elif data.startswith("\x1b[B", i):
            await flush_text()
            await _run_tmux("send-keys", "-t", session_name, "Down")
            i += 3
        elif data.startswith("\x1b[C", i):
            await flush_text()
            await _run_tmux("send-keys", "-t", session_name, "Right")
            i += 3
        elif data.startswith("\x1b[D", i):
            await flush_text()
            await _run_tmux("send-keys", "-t", session_name, "Left")
            i += 3
        else:
            char = data[i]
            if char == "\r" or char == "\n":
                await flush_text()
                await _run_tmux("send-keys", "-t", session_name, "Enter")
            elif char == "\x03":
                await flush_text()
                await _run_tmux("send-keys", "-t", session_name, "C-c")
            elif char == "\x04":
                await flush_text()
                await _run_tmux("send-keys", "-t", session_name, "C-d")
            elif char == "\x7f" or char == "\b":
                await flush_text()
                await _run_tmux("send-keys", "-t", session_name, "BSpace")
            elif char == "\t":
                await flush_text()
                await _run_tmux("send-keys", "-t", session_name, "Tab")
            elif char == "\x1b":
                await flush_text()
                await _run_tmux("send-keys", "-t", session_name, "Escape")
            else:
                text_buffer.append(char)
            i += 1

    await flush_text()


def build_agent_command(
    binary: str, *, initial_prompt: str | None, run_id: str | None
) -> str:
    """Compose the shell line that starts an agent.

    A dispatched run carries DOLPHIN_RUN_ID in the agent's environment. That
    variable is the ONLY thing that makes the Stop hook do anything, so a
    session started without it — every session the operator starts by hand —
    leaves the hook inert (spec §6.1).
    """
    command = binary
    if initial_prompt is not None:
        command = f"{command} {shlex.quote(initial_prompt)}"
    if run_id:
        command = f"DOLPHIN_RUN_ID={shlex.quote(run_id)} {command}"
    return command


async def start_codex(
    workspace_path: Path,
    session_name: str,
    initial_prompt: str | None = None,
    run_id: str | None = None,
) -> None:
    session = await require_workspace_session(workspace_path, session_name)
    if session.is_codex_running:
        return
    command = build_agent_command("codex", initial_prompt=initial_prompt, run_id=run_id)
    await _run_tmux("send-keys", "-t", session_name, "-l", command)
    await _run_tmux("send-keys", "-t", session_name, "Enter")
    readiness_checks = (
        max(
            1,
            int(CODEX_START_TIMEOUT_SECONDS / CODEX_START_POLL_SECONDS),
        )
        + 1
    )
    for check_index in range(readiness_checks):
        try:
            if await pane_contains_executable(
                session_name,
                "codex",
                strict=True,
            ):
                return
        except (OSError, RuntimeError, ValueError, TmuxServiceError) as error:
            detail = getattr(error, "detail", None) or str(error) or (
                "process observation failed"
            )
            status_code = getattr(error, "status_code", 503)
            raise TmuxServiceError(
                f"Codex start was sent to {session_name}, but Dolphin could not "
                f"verify readiness: {detail}. The shell was kept open; inspect "
                "its terminal output and retry.",
                status_code,
            ) from error
        if check_index < readiness_checks - 1:
            await asyncio.sleep(CODEX_START_POLL_SECONDS)

    raise TmuxServiceError(
        f"Codex did not become ready in {session_name} within "
        f"{CODEX_START_TIMEOUT_SECONDS:g} seconds. The shell was kept open; "
        "inspect its terminal output and retry.",
        503,
    )


async def start_claude(
    workspace_path: Path,
    session_name: str,
    initial_prompt: str | None = None,
    run_id: str | None = None,
) -> None:
    """Start Claude Code in an existing session.

    Tracked runs use this rather than start_codex because Claude Code's Stop
    hook is the only verified per-turn signal that can also block (spec §6.3).

    Mirrors start_codex, including its readiness loop: a command sent into a
    pane is not proof the agent started, and reporting a run as dispatched when
    nothing is running is the exact dishonesty Phase B removes.
    """
    session = await require_workspace_session(workspace_path, session_name)
    if session.is_claude_code_running:
        return

    command = build_agent_command(
        "claude", initial_prompt=initial_prompt, run_id=run_id
    )
    await _run_tmux("send-keys", "-t", session_name, "-l", command)
    await _run_tmux("send-keys", "-t", session_name, "Enter")

    readiness_checks = (
        max(1, int(CODEX_START_TIMEOUT_SECONDS / CODEX_START_POLL_SECONDS)) + 1
    )
    for check_index in range(readiness_checks):
        try:
            if await pane_contains_executable(session_name, "claude", strict=True):
                return
        except (OSError, RuntimeError, ValueError, TmuxServiceError) as error:
            detail = getattr(error, "detail", None) or str(error) or (
                "process observation failed"
            )
            status_code = getattr(error, "status_code", 503)
            raise TmuxServiceError(
                f"Claude Code start was sent to {session_name}, but Dolphin "
                f"could not verify readiness: {detail}. The shell was kept "
                "open; inspect its terminal output and retry.",
                status_code,
            ) from error
        if check_index < readiness_checks - 1:
            await asyncio.sleep(CODEX_START_POLL_SECONDS)

    raise TmuxServiceError(
        f"Claude Code did not become ready in {session_name} within "
        f"{CODEX_START_TIMEOUT_SECONDS:g} seconds. The shell was kept open; "
        "inspect its terminal output and retry.",
        503,
    )


async def capture_session(
    workspace_path: Path,
    session_name: str,
    lines: int = 300,
) -> TmuxSnapshot:
    await require_workspace_session(workspace_path, session_name)
    bounded_lines = max(40, min(lines, 2000))
    _, out, _ = await _run_tmux(
        "capture-pane",
        "-p",
        "-J",
        "-S",
        f"-{bounded_lines}",
        "-t",
        session_name,
    )
    return TmuxSnapshot(
        session_name=session_name,
        content=out.rstrip(),
        captured_at=datetime.now(timezone.utc),
    )
