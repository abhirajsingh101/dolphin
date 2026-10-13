"""TCP ports this user's processes listen on, for the Ports panel.

psutil.net_connections() needs root on macOS to see any process's sockets, so
this asks each of the user's own processes for its sockets instead
(Process.net_connections), which works unprivileged on Linux and macOS. Other
users' processes are never inspected. The helper itself is left out.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import psutil


@dataclass(frozen=True)
class ListeningPort:
    port: int
    address: str
    pid: int
    process: str
    command: str
    cwd: str | None


def _mine(process) -> bool:
    try:
        return process.uids().real == os.getuid()
    except (psutil.Error, AttributeError, OSError):
        return False


def list_ports(exclude_pids: set[int] | None = None) -> list[ListeningPort]:
    skip = {os.getpid(), *(exclude_pids or set())}
    found: dict[tuple[int, int], ListeningPort] = {}
    for process in psutil.process_iter(["pid", "name"]):
        if process.pid in skip or not _mine(process):
            continue
        try:
            listening = [s for s in process.net_connections(kind="tcp") if s.status == psutil.CONN_LISTEN and s.laddr]
            if not listening:
                continue
            name = process.name()
            command = " ".join(process.cmdline())[:200]
            try:
                cwd = process.cwd()
            except (psutil.Error, OSError):
                cwd = None
        except (psutil.Error, OSError):
            continue
        for sock in listening:
            key = (process.pid, sock.laddr.port)
            if key not in found:  # one row per port, whether it listens on IPv4, IPv6 or both
                found[key] = ListeningPort(sock.laddr.port, sock.laddr.ip, process.pid, name, command, cwd)
    return sorted(found.values(), key=lambda row: (row.port, row.pid))
