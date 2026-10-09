import asyncio

from app.system_health_service import (
    SystemHealthService,
    build_summary,
    normalize_alerts,
    normalize_function_rows,
    normalize_history,
    unavailable_summary,
)


def _chart(context, units, dimensions, *, family=""):
    return {
        "context": context,
        "units": units,
        "family": family,
        "dimensions": {
            key: {"name": name, "value": value}
            for key, (name, value) in dimensions.items()
        },
    }


def test_build_summary_normalizes_core_metrics_and_health():
    metrics = {
        "system.cpu": _chart(
            "system.cpu",
            "percentage",
            {
                "user": ("user", 32),
                "system": ("system", 8),
                "idle": ("idle", 60),
            },
        ),
        "system.load": _chart(
            "system.load",
            "load",
            {
                "load1": ("load1", 2.5),
                "load5": ("load5", 2),
                "load15": ("load15", 1.5),
            },
        ),
        "system.ram": _chart(
            "system.ram",
            "MiB",
            {
                "free": ("free", 1024),
                "used": ("used", 2048),
                "cached": ("cached", 768),
                "buffers": ("buffers", 256),
            },
        ),
        "mem.swap": _chart(
            "mem.swap",
            "MiB",
            {"free": ("free", 512), "used": ("used", 512)},
        ),
        "system.uptime": _chart(
            "system.uptime", "seconds", {"uptime": ("uptime", 86400)}
        ),
        "system.io": _chart(
            "system.io",
            "KiB/s",
            {"in": ("reads", 10), "out": ("writes", -20)},
        ),
        "system.net": _chart(
            "system.net",
            "kilobits/s",
            {"InOctets": ("received", 80), "OutOctets": ("sent", -40)},
        ),
        "disk_space./": _chart(
            "disk.space",
            "GiB",
            {
                "avail": ("avail", 5),
                "used": ("used", 90),
                "reserved_for_root": ("reserved for root", 5),
            },
            family="/",
        ),
        "disk.sda": _chart(
            "disk.io",
            "KiB/s",
            {"reads": ("reads", 3), "writes": ("writes", -4)},
        ),
        "net.eth0": _chart(
            "net.net",
            "kilobits/s",
            {"received": ("received", 24), "sent": ("sent", -8)},
        ),
    }
    info = {
        "version": "v2.10.3",
        "cores_total": "8",
        "mirrored_hosts": ["test-host"],
        "alarms": {"normal": 10, "warning": 1, "critical": 0},
    }

    summary = build_summary(info, metrics, [])

    assert summary["available"] is True
    assert summary["status"] == "warning"
    assert summary["host"]["hostname"] == "test-host"
    assert summary["host"]["cpu_cores"] == 8
    assert summary["host"]["uptime_seconds"] == 86400
    assert summary["cpu"] == {
        "usage_percent": 40.0,
        "load1": 2.5,
        "load5": 2.0,
        "load15": 1.5,
    }
    assert summary["memory"]["total_bytes"] == 4096 * 1024**2
    assert summary["memory"]["usage_percent"] == 50.0
    assert summary["swap"]["usage_percent"] == 50.0
    assert summary["disk_io"]["read_bytes_per_second"] == 10 * 1024
    assert summary["network"]["received_bytes_per_second"] == 10_000
    assert summary["filesystems"][0]["usage_percent"] == 95.0
    assert summary["disks"][0]["write_bytes_per_second"] == 4 * 1024
    assert summary["interfaces"][0]["sent_bytes_per_second"] == 1000


def test_unavailable_summary_keeps_stable_response_shape():
    summary = unavailable_summary("connection refused")

    assert summary["available"] is False
    assert summary["status"] == "unavailable"
    assert summary["message"] == "connection refused"
    assert summary["filesystems"] == []
    assert summary["alerts"] == {"normal": 0, "warning": 0, "critical": 0}


def test_normalize_cpu_and_memory_history_ignores_missing_points():
    cpu = normalize_history(
        "cpu",
        {
            "labels": ["time", "user", "system"],
            "data": [[3, 20, 5], [2, None, None], [1, 10, 2]],
        },
    )
    memory = normalize_history(
        "memory",
        {
            "labels": ["time", "free", "used", "cached"],
            "data": [[2, 25, 50, 25], [1, 50, 25, 25]],
        },
    )

    assert cpu["unit"] == "%"
    assert cpu["series"][0]["points"] == [
        {"timestamp": 1, "value": 12.0},
        {"timestamp": 3, "value": 25.0},
    ]
    assert memory["series"][0]["points"] == [
        {"timestamp": 1, "value": 25.0},
        {"timestamp": 2, "value": 50.0},
    ]


def test_history_uses_unaligned_window_for_fresh_netdata_charts(monkeypatch):
    service = SystemHealthService("http://netdata.test")
    request = {}

    async def fake_request(path, params=None):
        request.update({"path": path, "params": params})
        return {"labels": ["time", "user"], "data": [[1, 25]]}

    monkeypatch.setattr(service, "_request_json", fake_request)

    result = asyncio.run(service.history("cpu", seconds=3600, points=20))

    assert request["path"] == "/api/v1/data"
    assert request["params"]["options"] == "unaligned"
    assert result["series"][0]["points"] == [{"timestamp": 1, "value": 25.0}]


def test_normalize_alerts_returns_only_actionable_alerts():
    result = normalize_alerts(
        {
            "alarms": {
                "clear": {"name": "clear", "status": "CLEAR"},
                "warning": {
                    "name": "disk_space_usage",
                    "status": "WARNING",
                    "summary": "Disk is filling",
                    "value": 92,
                    "units": "%",
                    "last_status_change": 123,
                },
                "critical": {
                    "name": "temperature",
                    "status": "CRITICAL",
                    "info": "Too hot",
                    "value": 99,
                    "units": "C",
                    "last_status_change": 456,
                },
            }
        }
    )

    assert result["counts"] == {"warning": 1, "critical": 1}
    assert [alert["status"] for alert in result["alerts"]] == [
        "critical",
        "warning",
    ]
    assert result["alerts"][0]["summary"] == "Too hot"


def test_normalize_function_rows_uses_declared_column_indexes():
    rows = normalize_function_rows(
        {
            "columns": {
                "CPU": {"index": 2},
                "Name": {"index": 0},
                "PIDs": {"index": 1},
            },
            "data": [["worker", 3, 12.5]],
        }
    )

    assert rows == [{"CPU": 12.5, "Name": "worker", "PIDs": 3}]
