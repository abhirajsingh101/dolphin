"""Netdata-backed system health aggregation for Dolphin Tasks.

The browser never talks to Netdata directly. This module keeps the monitoring
service behind a small, allow-listed adapter and normalizes Netdata's flexible
chart payloads into a stable Dolphin API.
"""

from __future__ import annotations

import asyncio
import csv
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import time
from typing import Any, Callable, Coroutine
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


NETDATA_URL = os.getenv("DOLPHIN_NETDATA_URL", "http://127.0.0.1:19999").rstrip("/")
NETDATA_TOKEN = os.getenv("DOLPHIN_NETDATA_TOKEN", "").strip()
NETDATA_TIMEOUT = float(os.getenv("DOLPHIN_NETDATA_TIMEOUT", "3"))
MAX_NETDATA_RESPONSE_BYTES = 16 * 1024 * 1024


class NetdataUnavailable(RuntimeError):
    """Raised when the configured Netdata agent cannot answer a request."""


def _number(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _optional_number(value: Any) -> float | None:
    try:
        if value is None or value == "" or str(value).strip().upper() == "N/A":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return min(high, max(low, value))


def _dimensions(chart: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not isinstance(chart, dict):
        return {}
    dimensions = chart.get("dimensions")
    return dimensions if isinstance(dimensions, dict) else {}


def _dimension_value(chart: dict[str, Any] | None, *names: str) -> float:
    dimensions = _dimensions(chart)
    for name in names:
        dimension = dimensions.get(name)
        if isinstance(dimension, dict):
            return _number(dimension.get("value"))
        for candidate in dimensions.values():
            if isinstance(candidate, dict) and candidate.get("name") == name:
                return _number(candidate.get("value"))
    return 0.0


def _unit_bytes(value: float, unit: str) -> float:
    normalized = unit.lower().strip()
    if normalized in {"gib", "gib/s"}:
        return value * 1024**3
    if normalized in {"mib", "mib/s"}:
        return value * 1024**2
    if normalized in {"kib", "kib/s"}:
        return value * 1024
    if normalized in {"gb", "gb/s"}:
        return value * 1000**3
    if normalized in {"mb", "mb/s", "mbps"}:
        return value * 1000**2
    if normalized in {"kb", "kb/s"}:
        return value * 1000
    if normalized in {"kilobits/s", "kbit/s", "kb/s (bits)"}:
        return value * 1000 / 8
    return value


def _chart_entries(
    metrics: dict[str, Any], context: str
) -> list[tuple[str, dict[str, Any]]]:
    entries: list[tuple[str, dict[str, Any]]] = []
    for chart_id, chart in metrics.items():
        if isinstance(chart, dict) and chart.get("context") == context:
            entries.append((chart_id, chart))
    return entries


def _os_description() -> str:
    try:
        return platform.freedesktop_os_release().get("PRETTY_NAME", platform.system())
    except OSError:
        return platform.system()


def _cpu_model() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text(errors="replace").splitlines():
            if line.lower().startswith("model name"):
                return line.partition(":")[2].strip()
    except OSError:
        pass
    return platform.processor() or "Unknown CPU"


def _mount_name(chart_id: str, chart: dict[str, Any]) -> str:
    family = str(chart.get("family") or "").strip()
    if family.startswith("/"):
        return family
    if chart_id.startswith("disk_space."):
        value = chart_id.removeprefix("disk_space.")
        return value if value.startswith("/") else f"/{value}"
    return family or chart_id


def _parse_filesystems(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    filesystems: list[dict[str, Any]] = []
    for chart_id, chart in _chart_entries(metrics, "disk.space"):
        unit = str(chart.get("units") or "GiB")
        available = _unit_bytes(_dimension_value(chart, "avail"), unit)
        used = _unit_bytes(_dimension_value(chart, "used"), unit)
        reserved = _unit_bytes(
            _dimension_value(chart, "reserved_for_root", "reserved for root"), unit
        )
        total = available + used + reserved
        filesystems.append(
            {
                "mount": _mount_name(chart_id, chart),
                "available_bytes": round(available),
                "used_bytes": round(used),
                "reserved_bytes": round(reserved),
                "total_bytes": round(total),
                "usage_percent": round(_clamp((used + reserved) / total * 100), 2)
                if total
                else 0.0,
            }
        )
    return sorted(filesystems, key=lambda item: (item["mount"] != "/", item["mount"]))


def _parse_disks(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    disks: list[dict[str, Any]] = []
    for chart_id, chart in _chart_entries(metrics, "disk.io"):
        unit = str(chart.get("units") or "KiB/s")
        disks.append(
            {
                "name": chart_id.removeprefix("disk."),
                "read_bytes_per_second": round(
                    abs(_unit_bytes(_dimension_value(chart, "reads", "read"), unit))
                ),
                "write_bytes_per_second": round(
                    abs(_unit_bytes(_dimension_value(chart, "writes", "write"), unit))
                ),
            }
        )
    return sorted(
        disks,
        key=lambda item: item["read_bytes_per_second"] + item["write_bytes_per_second"],
        reverse=True,
    )


def _parse_interfaces(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    interfaces: list[dict[str, Any]] = []
    for chart_id, chart in _chart_entries(metrics, "net.net"):
        unit = str(chart.get("units") or "kilobits/s")
        interfaces.append(
            {
                "name": chart_id.removeprefix("net."),
                "received_bytes_per_second": round(
                    abs(_unit_bytes(_dimension_value(chart, "received"), unit))
                ),
                "sent_bytes_per_second": round(
                    abs(_unit_bytes(_dimension_value(chart, "sent"), unit))
                ),
            }
        )
    return sorted(
        interfaces,
        key=lambda item: item["received_bytes_per_second"]
        + item["sent_bytes_per_second"],
        reverse=True,
    )


def _parse_temperatures(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    temperatures: list[dict[str, Any]] = []
    seen: set[str] = set()
    for chart_id, chart in metrics.items():
        if not isinstance(chart, dict):
            continue
        context = str(chart.get("context") or "").lower()
        units = str(chart.get("units") or "").lower()
        if "temperature" not in context and "celsius" not in units:
            continue
        for dimension_id, dimension in _dimensions(chart).items():
            if not isinstance(dimension, dict):
                continue
            label = str(dimension.get("name") or dimension_id)
            key = f"{chart_id}:{label}"
            if key in seen:
                continue
            seen.add(key)
            temperatures.append(
                {
                    "label": label.replace("_", " "),
                    "source": str(chart.get("family") or chart_id),
                    "celsius": round(_number(dimension.get("value")), 1),
                }
            )
    return temperatures[:16]


def build_summary(
    info: dict[str, Any], metrics: dict[str, Any], gpus: list[dict[str, Any]]
) -> dict[str, Any]:
    """Normalize Netdata info and allmetrics responses into Dolphin's contract."""

    cpu_chart = metrics.get("system.cpu")
    idle = _dimension_value(cpu_chart, "idle")
    if idle:
        cpu_usage = 100 - idle
    else:
        cpu_usage = sum(
            max(0.0, _number(dimension.get("value")))
            for name, dimension in _dimensions(cpu_chart).items()
            if name != "idle" and isinstance(dimension, dict)
        )

    load_chart = metrics.get("system.load")
    memory_chart = metrics.get("system.ram")
    memory_unit = str(memory_chart.get("units") or "MiB") if isinstance(memory_chart, dict) else "MiB"
    memory_free = _unit_bytes(_dimension_value(memory_chart, "free"), memory_unit)
    memory_used = _unit_bytes(_dimension_value(memory_chart, "used"), memory_unit)
    memory_cached = _unit_bytes(_dimension_value(memory_chart, "cached"), memory_unit)
    memory_buffers = _unit_bytes(_dimension_value(memory_chart, "buffers"), memory_unit)
    memory_total = memory_free + memory_used + memory_cached + memory_buffers

    swap_chart = metrics.get("mem.swap")
    swap_unit = str(swap_chart.get("units") or "MiB") if isinstance(swap_chart, dict) else "MiB"
    swap_free = _unit_bytes(_dimension_value(swap_chart, "free"), swap_unit)
    swap_used = _unit_bytes(_dimension_value(swap_chart, "used"), swap_unit)
    swap_total = swap_free + swap_used

    disk_io_chart = metrics.get("system.io")
    disk_io_unit = (
        str(disk_io_chart.get("units") or "KiB/s")
        if isinstance(disk_io_chart, dict)
        else "KiB/s"
    )
    network_chart = metrics.get("system.net")
    network_unit = (
        str(network_chart.get("units") or "kilobits/s")
        if isinstance(network_chart, dict)
        else "kilobits/s"
    )

    filesystems = _parse_filesystems(metrics)
    alarms = info.get("alarms") if isinstance(info.get("alarms"), dict) else {}
    warning_count = int(_number(alarms.get("warning")))
    critical_count = int(_number(alarms.get("critical")))
    status = "critical" if critical_count else "warning" if warning_count else "healthy"
    mirrored_hosts = info.get("mirrored_hosts")
    hostname = (
        str(mirrored_hosts[0])
        if isinstance(mirrored_hosts, list) and mirrored_hosts
        else socket.gethostname()
    )
    smart_contexts = {
        str(chart.get("context"))
        for chart in metrics.values()
        if isinstance(chart, dict) and "smart" in str(chart.get("context") or "").lower()
    }

    return {
        "available": True,
        "status": status,
        "source": "netdata+nvidia-smi" if gpus else "netdata",
        "message": None,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "netdata_version": info.get("version"),
        "host": {
            "hostname": hostname,
            "os": info.get("os_name") or _os_description(),
            "kernel": info.get("kernel_version") or platform.release(),
            "architecture": info.get("architecture") or platform.machine(),
            "cpu_model": _cpu_model(),
            "cpu_cores": int(_number(info.get("cores_total"), os.cpu_count() or 0)),
            "uptime_seconds": round(_dimension_value(metrics.get("system.uptime"), "uptime")),
        },
        "cpu": {
            "usage_percent": round(_clamp(cpu_usage), 2),
            "load1": round(_dimension_value(load_chart, "load1"), 2),
            "load5": round(_dimension_value(load_chart, "load5"), 2),
            "load15": round(_dimension_value(load_chart, "load15"), 2),
        },
        "memory": {
            "total_bytes": round(memory_total),
            "used_bytes": round(memory_used),
            "cached_bytes": round(memory_cached + memory_buffers),
            "free_bytes": round(memory_free),
            "usage_percent": round(_clamp(memory_used / memory_total * 100), 2)
            if memory_total
            else 0.0,
        },
        "swap": {
            "total_bytes": round(swap_total),
            "used_bytes": round(swap_used),
            "free_bytes": round(swap_free),
            "usage_percent": round(_clamp(swap_used / swap_total * 100), 2)
            if swap_total
            else 0.0,
        },
        "disk_io": {
            "read_bytes_per_second": round(
                abs(_unit_bytes(_dimension_value(disk_io_chart, "in", "reads"), disk_io_unit))
            ),
            "write_bytes_per_second": round(
                abs(_unit_bytes(_dimension_value(disk_io_chart, "out", "writes"), disk_io_unit))
            ),
        },
        "network": {
            "received_bytes_per_second": round(
                abs(_unit_bytes(_dimension_value(network_chart, "InOctets", "received"), network_unit))
            ),
            "sent_bytes_per_second": round(
                abs(_unit_bytes(_dimension_value(network_chart, "OutOctets", "sent"), network_unit))
            ),
        },
        "filesystems": filesystems,
        "disks": _parse_disks(metrics),
        "interfaces": _parse_interfaces(metrics),
        "gpus": gpus,
        "temperatures": _parse_temperatures(metrics),
        "alerts": {
            "normal": int(_number(alarms.get("normal"))),
            "warning": warning_count,
            "critical": critical_count,
        },
        "smart": {
            "available": bool(smart_contexts),
            "metric_contexts": len(smart_contexts),
        },
    }


def unavailable_summary(message: str) -> dict[str, Any]:
    return {
        "available": False,
        "status": "unavailable",
        "source": "netdata",
        "message": message,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "netdata_version": None,
        "host": {
            "hostname": socket.gethostname(),
            "os": _os_description(),
            "kernel": platform.release(),
            "architecture": platform.machine(),
            "cpu_model": _cpu_model(),
            "cpu_cores": os.cpu_count() or 0,
            "uptime_seconds": 0,
        },
        "cpu": {"usage_percent": 0, "load1": 0, "load5": 0, "load15": 0},
        "memory": {
            "total_bytes": 0,
            "used_bytes": 0,
            "cached_bytes": 0,
            "free_bytes": 0,
            "usage_percent": 0,
        },
        "swap": {"total_bytes": 0, "used_bytes": 0, "free_bytes": 0, "usage_percent": 0},
        "disk_io": {"read_bytes_per_second": 0, "write_bytes_per_second": 0},
        "network": {"received_bytes_per_second": 0, "sent_bytes_per_second": 0},
        "filesystems": [],
        "disks": [],
        "interfaces": [],
        "gpus": [],
        "temperatures": [],
        "alerts": {"normal": 0, "warning": 0, "critical": 0},
        "smart": {"available": False, "metric_contexts": 0},
    }


HISTORY_CHARTS = {
    "cpu": "system.cpu",
    "memory": "system.ram",
    "load": "system.load",
    "network": "system.net",
    "disk_io": "system.io",
}


def normalize_history(metric: str, payload: dict[str, Any]) -> dict[str, Any]:
    labels = payload.get("labels")
    rows = payload.get("data")
    if not isinstance(labels, list) or not isinstance(rows, list) or not labels:
        return {"metric": metric, "unit": "", "series": []}

    indexes = {str(label): index for index, label in enumerate(labels)}
    points_by_name: dict[str, list[dict[str, Any]]] = {}
    unit = ""

    def add(name: str, timestamp: int, value: float | None) -> None:
        if value is None:
            return
        points_by_name.setdefault(name, []).append(
            {"timestamp": timestamp, "value": round(value, 3)}
        )

    for row in reversed(rows):
        if not isinstance(row, list) or not row:
            continue
        timestamp = int(_number(row[0]))
        values = {
            label: _optional_number(row[index]) if index < len(row) else None
            for label, index in indexes.items()
            if label != "time"
        }
        if metric == "cpu":
            present = [value for value in values.values() if value is not None]
            add("CPU", timestamp, sum(present) if present else None)
            unit = "%"
        elif metric == "memory":
            present = [value for value in values.values() if value is not None]
            total = sum(present)
            used = values.get("used")
            add("Memory", timestamp, used / total * 100 if used is not None and total else None)
            unit = "%"
        elif metric == "load":
            for label, title in (("load1", "1 min"), ("load5", "5 min"), ("load15", "15 min")):
                add(title, timestamp, values.get(label))
            unit = "load"
        elif metric == "network":
            add("Received", timestamp, abs(values.get("InOctets") or values.get("received") or 0) * 1000 / 8)
            add("Sent", timestamp, abs(values.get("OutOctets") or values.get("sent") or 0) * 1000 / 8)
            unit = "B/s"
        elif metric == "disk_io":
            add("Read", timestamp, abs(values.get("in") or values.get("reads") or 0) * 1024)
            add("Write", timestamp, abs(values.get("out") or values.get("writes") or 0) * 1024)
            unit = "B/s"

    return {
        "metric": metric,
        "unit": unit,
        "series": [
            {"name": name, "points": points} for name, points in points_by_name.items()
        ],
    }


def normalize_alerts(payload: dict[str, Any]) -> dict[str, Any]:
    raw_alarms = payload.get("alarms")
    alarms = raw_alarms if isinstance(raw_alarms, dict) else {}
    active: list[dict[str, Any]] = []
    counts = {"warning": 0, "critical": 0}
    for alarm_id, alarm in alarms.items():
        if not isinstance(alarm, dict):
            continue
        status = str(alarm.get("status") or "").upper()
        if status not in {"WARNING", "CRITICAL"}:
            continue
        counts[status.lower()] += 1
        active.append(
            {
                "id": alarm_id,
                "name": alarm.get("name") or alarm_id,
                "status": status.lower(),
                "chart": alarm.get("chart"),
                "value": _optional_number(alarm.get("value")),
                "units": alarm.get("units") or "",
                "summary": alarm.get("summary") or alarm.get("info") or alarm.get("name"),
                "detail": alarm.get("info") or "",
                "updated_at": int(_number(alarm.get("last_status_change"))),
            }
        )
    active.sort(key=lambda item: (item["status"] != "critical", item["name"]))
    return {
        "available": True,
        "counts": counts,
        "alerts": active,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "message": None,
    }


def normalize_function_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    columns = payload.get("columns")
    data = payload.get("data")
    if not isinstance(columns, dict) or not isinstance(data, list):
        return []
    indexes = {
        name: int(_number(metadata.get("index"), -1))
        for name, metadata in columns.items()
        if isinstance(metadata, dict)
    }
    rows: list[dict[str, Any]] = []
    for values in data:
        if not isinstance(values, list):
            continue
        row = {
            name: values[index] if 0 <= index < len(values) else None
            for name, index in indexes.items()
        }
        rows.append(row)
    return rows


def _nvidia_gpus() -> list[dict[str, Any]]:
    binary = shutil.which("nvidia-smi")
    if not binary:
        return []
    fields = (
        "index,name,uuid,utilization.gpu,memory.used,memory.total,"
        "temperature.gpu,power.draw,power.limit"
    )
    try:
        result = subprocess.run(
            [binary, f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=3,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return []

    gpus: list[dict[str, Any]] = []
    for row in csv.reader(result.stdout.splitlines(), skipinitialspace=True):
        if len(row) != 9:
            continue
        memory_used = _optional_number(row[4])
        memory_total = _optional_number(row[5])
        gpus.append(
            {
                "index": int(_number(row[0])),
                "name": row[1].strip(),
                "uuid": row[2].strip(),
                "usage_percent": _optional_number(row[3]),
                "memory_used_bytes": round(memory_used * 1024**2) if memory_used is not None else None,
                "memory_total_bytes": round(memory_total * 1024**2) if memory_total is not None else None,
                "memory_usage_percent": round(memory_used / memory_total * 100, 2)
                if memory_used is not None and memory_total
                else None,
                "temperature_celsius": _optional_number(row[6]),
                "power_watts": _optional_number(row[7]),
                "power_limit_watts": _optional_number(row[8]),
            }
        )
    return gpus


def _top_processes(limit: int = 10) -> list[dict[str, Any]]:
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid=,comm=,%cpu=,rss=", "--sort=-%cpu"],
            capture_output=True,
            text=True,
            timeout=3,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    processes: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 3)
        if len(parts) != 4:
            continue
        processes.append(
            {
                "pid": int(_number(parts[0])),
                "name": parts[1],
                "cpu_percent": _number(parts[2]),
                "memory_bytes": round(_number(parts[3]) * 1024),
            }
        )
        if len(processes) >= limit:
            break
    return processes


def _smart_status() -> dict[str, Any]:
    binary = shutil.which("smartctl")
    if not binary:
        return {
            "available": False,
            "devices": [],
            "message": "smartctl is not installed.",
        }
    try:
        result = subprocess.run(
            [binary, "--scan-open", "-j"],
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
        payload = json.loads(result.stdout or "{}")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return {
            "available": False,
            "devices": [],
            "message": "S.M.A.R.T. device discovery failed.",
        }

    devices: list[dict[str, Any]] = []
    for device in payload.get("devices", []):
        if not isinstance(device, dict):
            continue
        error = device.get("open_error")
        devices.append(
            {
                "name": device.get("name"),
                "type": device.get("type"),
                "protocol": device.get("protocol"),
                "status": "unavailable" if error else "detected",
                "message": error,
            }
        )
    available = any(device["status"] != "unavailable" for device in devices)
    message = None
    if devices and not available:
        message = "Netdata needs device permissions to read S.M.A.R.T. health."
    elif not devices:
        message = "No S.M.A.R.T. devices were discovered."
    return {"available": available, "devices": devices, "message": message}


def _workload_item(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": row.get("Name") or "Unknown",
        "kind": row.get("Kind"),
        "pids": int(_number(row.get("PIDs"))),
        "cpu_percent": round(_number(row.get("CPU")), 2),
        "memory_bytes": round(_number(row.get("RAM")) * 1024**2),
        "read_bytes": round(_number(row.get("Reads")) * 1024**2),
        "write_bytes": round(_number(row.get("Writes")) * 1024**2),
        "received_bytes_per_second": round(_number(row.get("Received")) * 1000**2 / 8),
        "sent_bytes_per_second": round(_number(row.get("Sent")) * 1000**2 / 8),
    }


# "netdata" (this server's install): netdata or nothing. "native": psutil only.
# "auto" (Dolphin Desktop's helper): netdata when it answers, otherwise native,
# so System Health works on any Mac or Linux box without installing netdata.
HEALTH_SOURCE = os.getenv("DOLPHIN_SYSTEM_HEALTH_SOURCE", "netdata")
NETDATA_RETRY_SECONDS = 60.0


class SystemHealthService:
    def __init__(self, base_url: str = NETDATA_URL, source: str | None = None):
        self.base_url = base_url.rstrip("/")
        self._cache: dict[str, tuple[float, Any]] = {}
        self.source = source or HEALTH_SOURCE
        self._netdata_down_until = 0.0

    def _native(self):
        """The psutil collector, started on first use, or None in netdata mode."""
        if self.source == "netdata":
            return None
        from .native_health import native_health

        native_health.ensure_sampling()
        if self.source == "native" or time.monotonic() < self._netdata_down_until:
            return native_health
        return None

    def _netdata_failed(self):
        """In auto mode, stop asking netdata for a while and use native instead."""
        if self.source != "auto":
            return None
        self._netdata_down_until = time.monotonic() + NETDATA_RETRY_SECONDS
        return self._native()

    def _request_json_sync(
        self, path: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        query = f"?{urlencode(params)}" if params else ""
        request = Request(
            f"{self.base_url}{path}{query}",
            headers={
                "Accept": "application/json",
                **({"Authorization": f"Bearer {NETDATA_TOKEN}"} if NETDATA_TOKEN else {}),
            },
        )
        try:
            with urlopen(request, timeout=NETDATA_TIMEOUT) as response:
                raw = response.read(MAX_NETDATA_RESPONSE_BYTES + 1)
        except HTTPError as error:
            raise NetdataUnavailable(f"Netdata returned HTTP {error.code}.") from error
        except (URLError, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            raise NetdataUnavailable(f"Netdata is unavailable at {self.base_url}: {reason}") from error
        if len(raw) > MAX_NETDATA_RESPONSE_BYTES:
            raise NetdataUnavailable("Netdata returned an unexpectedly large response.")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as error:
            raise NetdataUnavailable("Netdata returned invalid JSON.") from error
        if not isinstance(payload, dict):
            raise NetdataUnavailable("Netdata returned an unexpected response shape.")
        return payload

    async def _request_json(
        self, path: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self._request_json_sync, path, params)

    async def _cached(
        self,
        key: str,
        ttl: float,
        loader: Callable[[], Coroutine[Any, Any, Any]],
    ) -> Any:
        cached = self._cache.get(key)
        now = time.monotonic()
        if cached and cached[0] > now:
            return cached[1]
        value = await loader()
        self._cache[key] = (now + ttl, value)
        return value

    async def summary(self, *, refresh: bool = False) -> dict[str, Any]:
        if refresh:
            self._cache.pop("summary", None)

        async def native_summary(native) -> dict[str, Any]:
            gpus = await asyncio.to_thread(_nvidia_gpus)
            return await asyncio.to_thread(native.summary, gpus, _cpu_model(), _os_description())

        async def load() -> dict[str, Any]:
            native = self._native()
            if native is not None:
                return await native_summary(native)
            try:
                info, metrics, gpus = await asyncio.gather(
                    self._request_json("/api/v1/info"),
                    self._request_json("/api/v1/allmetrics", {"format": "json"}),
                    asyncio.to_thread(_nvidia_gpus),
                )
                return build_summary(info, metrics, gpus)
            except NetdataUnavailable as error:
                native = self._netdata_failed()
                if native is not None:
                    return await native_summary(native)
                return unavailable_summary(str(error))

        return await self._cached("summary", 2.0, load)

    async def history(
        self, metric: str, *, seconds: int = 3600, points: int = 120
    ) -> dict[str, Any]:
        chart = HISTORY_CHARTS.get(metric)
        if not chart:
            raise ValueError(f"Unsupported history metric: {metric}")
        native = self._native()
        if native is not None:
            return native.history(metric, seconds, points)
        try:
            payload = await self._request_json(
            "/api/v1/data",
            {
                "chart": chart,
                "after": -seconds,
                "points": points,
                "format": "json",
                "group": "average",
                # Avoid Netdata aligning an exact one-hour query outside a
                # freshly-created chart's available retention window.
                "options": "unaligned",
            },
            )
        except NetdataUnavailable:
            native = self._netdata_failed()
            if native is None:
                raise
            return native.history(metric, seconds, points)
        result = normalize_history(metric, payload)
        result.update(
            {
                "available": True,
                "seconds": seconds,
                "collected_at": datetime.now(timezone.utc).isoformat(),
                "message": None,
            }
        )
        return result

    async def alerts(self, *, refresh: bool = False) -> dict[str, Any]:
        if refresh:
            self._cache.pop("alerts", None)

        async def load() -> dict[str, Any]:
            native = self._native()
            if native is not None:
                return await asyncio.to_thread(native.alerts)
            try:
                return normalize_alerts(
                    await self._request_json("/api/v1/alarms", {"all": ""})
                )
            except NetdataUnavailable as error:
                native = self._netdata_failed()
                if native is not None:
                    return await asyncio.to_thread(native.alerts)
                return {
                    "available": False,
                    "counts": {"warning": 0, "critical": 0},
                    "alerts": [],
                    "collected_at": datetime.now(timezone.utc).isoformat(),
                    "message": str(error),
                }

        return await self._cached("alerts", 4.0, load)

    async def workloads(self, *, refresh: bool = False) -> dict[str, Any]:
        if refresh:
            self._cache.pop("workloads", None)

        async def native_workloads(native) -> dict[str, Any]:
            processes, smart = await asyncio.gather(
                asyncio.to_thread(native.top_processes),
                asyncio.to_thread(_smart_status),
                return_exceptions=True,
            )
            return {
                "available": True,
                "processes": processes if isinstance(processes, list) else [],
                "containers": [],
                "services": [],
                "smart": smart if isinstance(smart, dict)
                else {"available": False, "devices": [], "message": str(smart)},
                "collected_at": datetime.now(timezone.utc).isoformat(),
                "message": None,
            }

        async def load() -> dict[str, Any]:
            native = self._native()
            if native is not None:
                return await native_workloads(native)
            container_request = self._request_json(
                "/api/v1/function", {"function": "containers-vms"}
            )
            service_request = self._request_json(
                "/api/v1/function", {"function": "systemd-services"}
            )
            container_result, service_result, processes, smart = await asyncio.gather(
                container_request,
                service_request,
                asyncio.to_thread(_top_processes),
                asyncio.to_thread(_smart_status),
                return_exceptions=True,
            )

            containers = (
                [_workload_item(row) for row in normalize_function_rows(container_result)[:20]]
                if isinstance(container_result, dict)
                else []
            )
            services = (
                [_workload_item(row) for row in normalize_function_rows(service_result)[:20]]
                if isinstance(service_result, dict)
                else []
            )
            netdata_available = isinstance(container_result, dict) or isinstance(service_result, dict)
            if not netdata_available:
                native = self._netdata_failed()
                if native is not None:
                    return await native_workloads(native)
            messages = [
                str(result)
                for result in (container_result, service_result)
                if isinstance(result, Exception)
            ]
            return {
                "available": netdata_available,
                "processes": processes if isinstance(processes, list) else [],
                "containers": containers,
                "services": services,
                "smart": smart
                if isinstance(smart, dict)
                else {"available": False, "devices": [], "message": str(smart)},
                "collected_at": datetime.now(timezone.utc).isoformat(),
                "message": "; ".join(messages) if messages else None,
            }

        return await self._cached("workloads", 10.0, load)


system_health_service = SystemHealthService()
