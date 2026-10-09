"""System Health without netdata, for Dolphin Desktop on any Mac or Linux box.

Produces the same JSON as the netdata path in ``system_health_service`` so the
System Health screen needs no changes. Rates (disk and network bytes/s) come
from the difference between two psutil readings; history comes from a ring
buffer sampled every few seconds while the helper runs; alerts come from fixed
thresholds instead of netdata's alarm engine.
"""

from __future__ import annotations

import asyncio
import os
import platform
import socket
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any

import psutil

SAMPLE_SECONDS = 5.0
HISTORY_SECONDS = 3600
# Pseudo and virtual filesystems that only add noise to a disk list.
_SKIP_FSTYPES = {"tmpfs", "devtmpfs", "squashfs", "overlay", "autofs", "proc", "sysfs", "devfs", "nullfs"}
_SKIP_MOUNT_PREFIXES = ("/snap/", "/proc", "/sys", "/dev", "/run", "/System/Volumes/VM",
                        "/System/Volumes/Preboot", "/System/Volumes/Update", "/private/var/vm")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pct(part: float, total: float) -> float:
    return round(min(100.0, max(0.0, part / total * 100)), 2) if total else 0.0


class NativeHealth:
    def __init__(self) -> None:
        self._last_io: tuple[float, Any, Any, dict, dict] | None = None
        self._rates: dict[str, Any] = {
            "disk_io": {"read_bytes_per_second": 0, "write_bytes_per_second": 0},
            "network": {"received_bytes_per_second": 0, "sent_bytes_per_second": 0},
            "disks": [], "interfaces": [],
        }
        self._history: deque[dict[str, float]] = deque(maxlen=int(HISTORY_SECONDS / SAMPLE_SECONDS) + 1)
        self._processes: dict[int, psutil.Process] = {}
        self._sampler: asyncio.Task | None = None
        psutil.cpu_percent(interval=None)  # primes the first non-blocking reading

    # --- sampling -------------------------------------------------------------

    def _read_rates(self) -> None:
        now = time.monotonic()
        disk = psutil.disk_io_counters()
        net = psutil.net_io_counters()
        per_disk = psutil.disk_io_counters(perdisk=True) or {}
        per_nic = psutil.net_io_counters(pernic=True) or {}
        previous = self._last_io
        self._last_io = (now, disk, net, per_disk, per_nic)
        if previous is None:
            return
        elapsed = max(now - previous[0], 1e-3)

        def rate(new: float, old: float) -> int:
            return max(0, round((new - old) / elapsed))

        if disk and previous[1]:
            self._rates["disk_io"] = {
                "read_bytes_per_second": rate(disk.read_bytes, previous[1].read_bytes),
                "write_bytes_per_second": rate(disk.write_bytes, previous[1].write_bytes),
            }
        if net and previous[2]:
            self._rates["network"] = {
                "received_bytes_per_second": rate(net.bytes_recv, previous[2].bytes_recv),
                "sent_bytes_per_second": rate(net.bytes_sent, previous[2].bytes_sent),
            }
        self._rates["disks"] = [
            {"name": name, "read_bytes_per_second": rate(counters.read_bytes, previous[3][name].read_bytes),
             "write_bytes_per_second": rate(counters.write_bytes, previous[3][name].write_bytes)}
            for name, counters in sorted(per_disk.items())
            if name in previous[3] and not name.startswith(("loop", "ram"))
        ]
        self._rates["interfaces"] = [
            {"name": name, "received_bytes_per_second": rate(counters.bytes_recv, previous[4][name].bytes_recv),
             "sent_bytes_per_second": rate(counters.bytes_sent, previous[4][name].bytes_sent)}
            for name, counters in sorted(per_nic.items())
            if name in previous[4] and name != "lo" and not name.startswith(("lo0", "veth", "docker", "br-"))
        ]

    def sample(self) -> None:
        """One reading for rates and the history ring buffer."""
        self._read_rates()
        memory = psutil.virtual_memory()
        load = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)
        self._history.append({
            "timestamp": int(time.time()),
            "cpu": psutil.cpu_percent(interval=None),
            "memory": memory.percent,
            "load1": load[0], "load5": load[1], "load15": load[2],
            "received": self._rates["network"]["received_bytes_per_second"],
            "sent": self._rates["network"]["sent_bytes_per_second"],
            "read": self._rates["disk_io"]["read_bytes_per_second"],
            "write": self._rates["disk_io"]["write_bytes_per_second"],
        })

    async def _sample_forever(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.sample)
            except Exception:  # a failed reading must not end the history
                pass
            await asyncio.sleep(SAMPLE_SECONDS)

    def ensure_sampling(self) -> None:
        if self._sampler is None or self._sampler.done():
            self._sampler = asyncio.get_running_loop().create_task(self._sample_forever())

    # --- endpoints ------------------------------------------------------------

    def _filesystems(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for part in psutil.disk_partitions(all=False):
            if part.fstype in _SKIP_FSTYPES or part.mountpoint.startswith(_SKIP_MOUNT_PREFIXES) \
                    or part.device in seen:
                continue
            try:
                usage = psutil.disk_usage(part.mountpoint)
            except OSError:
                continue
            seen.add(part.device)
            reserved = max(0, usage.total - usage.used - usage.free)
            out.append({
                "mount": part.mountpoint,
                "available_bytes": usage.free,
                "used_bytes": usage.used,
                "reserved_bytes": reserved,
                "total_bytes": usage.total,
                "usage_percent": _pct(usage.used + reserved, usage.total),
            })
        return out

    def _temperatures(self) -> list[dict[str, Any]]:
        reader = getattr(psutil, "sensors_temperatures", None)
        if reader is None:
            return []
        try:
            groups = reader() or {}
        except Exception:
            return []
        return [
            {"label": (entry.label or name).replace("_", " "), "source": name, "celsius": round(entry.current, 1)}
            for name, entries in groups.items() for entry in entries if entry.current
        ][:24]

    def summary(self, gpus: list[dict[str, Any]], cpu_model: str, os_description: str) -> dict[str, Any]:
        if self._last_io is None:
            # Rates need two readings; don't show 0 B/s on the first look.
            self.sample()
            time.sleep(0.5)
            self.sample()
        elif len(self._history) < 2:
            time.sleep(0.5)
            self.sample()
        memory = psutil.virtual_memory()
        swap = psutil.swap_memory()
        load = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)
        cached = getattr(memory, "cached", 0) + getattr(memory, "buffers", 0)
        filesystems = self._filesystems()
        checked = self.alerts()
        alerts = checked["counts"]
        return {
            "available": True,
            "status": "critical" if alerts["critical"] else "warning" if alerts["warning"] else "healthy",
            "source": "system+nvidia-smi" if gpus else "system",
            "message": None,
            "collected_at": _now(),
            "netdata_version": None,
            "host": {
                "hostname": socket.gethostname(),
                "os": os_description,
                "kernel": platform.release(),
                "architecture": platform.machine(),
                "cpu_model": cpu_model,
                "cpu_cores": psutil.cpu_count() or os.cpu_count() or 0,
                "uptime_seconds": round(time.time() - psutil.boot_time()),
            },
            "cpu": {
                # The sampler's latest reading. A second cpu_percent(None)
                # caller would split the interval with it, and a call just
                # after a sample measures microseconds: 0%.
                "usage_percent": round(self._history[-1]["cpu"] if self._history else 0.0, 2),
                "load1": round(load[0], 2), "load5": round(load[1], 2), "load15": round(load[2], 2),
            },
            "memory": {
                "total_bytes": memory.total,
                "used_bytes": memory.total - memory.available,
                "cached_bytes": cached,
                "free_bytes": memory.available,
                "usage_percent": round(memory.percent, 2),
            },
            "swap": {
                "total_bytes": swap.total, "used_bytes": swap.used, "free_bytes": swap.free,
                "usage_percent": round(swap.percent, 2),
            },
            "disk_io": self._rates["disk_io"],
            "network": self._rates["network"],
            "filesystems": filesystems,
            "disks": self._rates["disks"],
            "interfaces": self._rates["interfaces"],
            "gpus": gpus,
            "temperatures": self._temperatures(),
            "alerts": {"normal": max(0, checked["evaluated"] - alerts["warning"] - alerts["critical"]),
                       "warning": alerts["warning"], "critical": alerts["critical"]},
            "smart": {"available": False, "metric_contexts": 0},
        }

    def history(self, metric: str, seconds: int, points: int) -> dict[str, Any]:
        cutoff = time.time() - seconds
        rows = [row for row in self._history if row["timestamp"] >= cutoff]
        if len(rows) > points:
            step = len(rows) / points
            rows = [rows[int(index * step)] for index in range(points)]
        names = {
            "cpu": (("CPU", "cpu"),), "memory": (("Memory", "memory"),),
            "load": (("1 min", "load1"), ("5 min", "load5"), ("15 min", "load15")),
            "network": (("Received", "received"), ("Sent", "sent")),
            "disk_io": (("Read", "read"), ("Write", "write")),
        }[metric]
        unit = {"cpu": "%", "memory": "%", "load": "load", "network": "B/s", "disk_io": "B/s"}[metric]
        return {
            "metric": metric, "unit": unit,
            "series": [
                {"name": title, "points": [{"timestamp": row["timestamp"], "value": round(row[key], 3)} for row in rows]}
                for title, key in names
            ],
            "available": True, "seconds": seconds, "collected_at": _now(), "message": None,
        }

    def alerts(self) -> dict[str, Any]:
        """Fixed thresholds: what would make a person look, not netdata's full catalogue."""
        memory = psutil.virtual_memory()
        swap = psutil.swap_memory()
        recent = list(self._history)[-3:]
        checks: list[tuple[str, str, float, str, str]] = []
        evaluated = 3  # CPU, memory, swap; plus one per filesystem below
        if len(recent) == 3 and min(row["cpu"] for row in recent) >= 90:
            checks.append(("cpu_busy", "warning", recent[-1]["cpu"], "%", "CPU has been above 90% for 15 seconds"))
        if memory.percent >= 97:
            checks.append(("memory_full", "critical", memory.percent, "%", "Memory is almost full"))
        elif memory.percent >= 90:
            checks.append(("memory_high", "warning", memory.percent, "%", "Memory is above 90%"))
        if swap.total and swap.percent >= 80:
            checks.append(("swap_high", "warning", swap.percent, "%", "Swap is above 80%"))
        for filesystem in self._filesystems():
            evaluated += 1
            usage = filesystem["usage_percent"]
            if usage >= 90:
                status = "critical" if usage >= 97 else "warning"
                checks.append((f"disk_full:{filesystem['mount']}", status, usage, "%",
                               f"{filesystem['mount']} is {usage:.0f}% full"))
        alerts = [
            {"id": key, "name": key.split(":")[0].replace("_", " "), "status": status, "chart": None,
             "value": round(value, 2), "units": unit, "summary": summary, "detail": "", "updated_at": int(time.time())}
            for key, status, value, unit, summary in checks
        ]
        alerts.sort(key=lambda item: (item["status"] != "critical", item["name"]))
        return {
            "available": True,
            "evaluated": evaluated,
            "counts": {"warning": sum(a["status"] == "warning" for a in alerts),
                       "critical": sum(a["status"] == "critical" for a in alerts)},
            "alerts": alerts, "collected_at": _now(), "message": None,
        }

    def top_processes(self, limit: int = 10) -> list[dict[str, Any]]:
        """CPU share since the previous call; psutil needs two readings per process."""
        if not self._processes:  # first call: take the baseline reading now
            self._processes = {process.pid: process for process in psutil.process_iter()}
            for process in self._processes.values():
                try:
                    process.cpu_percent(interval=None)
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    pass
            time.sleep(0.5)
        alive: dict[int, psutil.Process] = {}
        rows: list[dict[str, Any]] = []
        for process in psutil.process_iter(["pid", "name"]):
            pid = process.info["pid"]
            tracked = self._processes.get(pid, process)
            try:
                cpu = tracked.cpu_percent(interval=None)
                memory = tracked.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
            alive[pid] = tracked
            rows.append({"pid": pid, "name": process.info["name"] or "?", "cpu_percent": round(cpu, 1), "memory_bytes": memory})
        self._processes = alive
        rows.sort(key=lambda row: (row["cpu_percent"], row["memory_bytes"]), reverse=True)
        return rows[:limit]


native_health = NativeHealth()
