import {
  Activity,
  AlertTriangle,
  Box,
  CheckCircle2,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  ShieldAlert,
  Thermometer,
  Zap,
} from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  fetchSystemHealthAlerts,
  fetchSystemHealthHistory,
  fetchSystemHealthSummary,
  fetchSystemHealthWorkloads,
} from './api';
import type {
  SystemHealthAlerts,
  SystemHealthHistory,
  SystemHealthHistorySeries,
  SystemHealthSummary,
  SystemHealthWorkload,
  SystemHealthWorkloads,
} from './types';
import { smartTone } from './smartStatus';
import { startVisibilityAwarePolling } from './visibilityPolling';

// Primary series in --accent (brand teal), secondary in --ok (healthy green) —
// tokens, not a private hardcoded palette. See tokens.css. No chart currently
// renders more than two series (network/disk read+write); a third color was
// dropped rather than kept speculative — add one back if a three-series chart
// ships.
const CHART_COLORS = ['var(--accent)', 'var(--ok)'];

function formatBytes(value: number | null | undefined, rate = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let index = 0;
  let scaled = absolute;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  const digits = scaled >= 100 || index === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[index]}${rate ? '/s' : ''}`;
}

function formatDuration(seconds: number) {
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`;
}

function formatMetric(value: number, unit: string) {
  if (unit === 'B/s') return formatBytes(value, true);
  if (unit === '%') return `${value.toFixed(1)}%`;
  return `${value.toFixed(value >= 100 ? 0 : 2)} ${unit}`.trim();
}

function formatUpdated(timestamp: string | number) {
  const date = typeof timestamp === 'number' ? new Date(timestamp * 1000) : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function HealthCard({
  icon,
  label,
  value,
  meta,
  percent,
  tone = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: string;
  meta: string;
  percent?: number | null;
  tone?: 'neutral' | 'good' | 'warning' | 'critical';
}) {
  const safePercent = percent === null || percent === undefined ? null : Math.max(0, Math.min(100, percent));
  return (
    <article className={`health-card tone-${tone}`}>
      <div className="health-card-heading">
        <span className="health-card-icon">{icon}</span>
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <small>{meta}</small>
      {safePercent !== null ? (
        <div className="health-progress" aria-label={`${label} ${safePercent.toFixed(1)} percent`}>
          <span style={{ width: `${safePercent}%` }} />
        </div>
      ) : null}
    </article>
  );
}

function MiniChart({
  title,
  subtitle,
  history,
  fixedPercent = false,
}: {
  title: string;
  subtitle: string;
  history: SystemHealthHistory | undefined;
  fixedPercent?: boolean;
}) {
  const geometry = useMemo(() => {
    const series = history?.series.filter((item) => item.points.length > 0) ?? [];
    const values = series.flatMap((item) => item.points.map((point) => point.value));
    if (!values.length) return { series, min: 0, max: 1 };
    const observedMin = Math.min(...values);
    const observedMax = Math.max(...values);

    /* Percent charts used to pin the domain to a literal 0-100. An idle box
       sits near 1% CPU, so the trace was drawn on the bottom pixel row of a
       150px box and ~95% of every chart was empty air with unlabelled
       gridlines floating in it — the single biggest reason this page read as
       unfinished. Auto-scale like any real monitoring UI, but hold a minimum
       span so a genuinely flat line is not magnified into fake drama. */
    const ceiling = fixedPercent ? 100 : Infinity;
    const minSpan = fixedPercent
      ? Math.max(observedMax * 0.5, 4)
      : Math.max(observedMax * 0.25, 0.1);
    const span = Math.max(observedMax - observedMin, minSpan);
    const padding = span * 0.2;
    const min = Math.max(0, observedMin - padding);
    const max = Math.min(ceiling, Math.max(observedMax + padding, min + minSpan));
    return { series, min, max: max > min ? max : min + 1 };
  }, [fixedPercent, history]);

  const width = 620;
  const height = 150;
  const padX = 10;
  const padY = 12;
  const makePoints = (series: SystemHealthHistorySeries) => {
    const span = geometry.max - geometry.min || 1;
    return series.points
      .map((point, index) => {
        const x = padX + (index / Math.max(1, series.points.length - 1)) * (width - padX * 2);
        const y = padY + ((geometry.max - point.value) / span) * (height - padY * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  };
  /* Closes the trace down to the baseline so it can be filled. A 3px stroke
     alone across a wide card reads as a stray rule; a tinted area under it
     reads as a chart. */
  const makeArea = (series: SystemHealthHistorySeries) =>
    `${makePoints(series)} ${(width - padX).toFixed(1)},${(height - padY).toFixed(1)} ${padX.toFixed(1)},${(height - padY).toFixed(1)}`;
  const unit = history?.unit ?? '';

  return (
    <article className="health-chart-card">
      <header>
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="health-chart-latest">
          {geometry.series.map((series, index) => {
            const latest = series.points[series.points.length - 1]?.value;
            return (
              <span key={series.name}>
                <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
                {series.name} {latest === undefined ? '—' : formatMetric(latest, history?.unit ?? '')}
              </span>
            );
          })}
        </div>
      </header>
      {geometry.series.length ? (
        /* The axis bounds are HTML, not SVG <text>: this chart is drawn with
           preserveAspectRatio="none" so the viewBox stretches to the card
           width, which would smear any text inside it horizontally. */
        <div className="health-chart-plot">
          <svg
            aria-label={`${title} history`}
            className="health-sparkline"
            preserveAspectRatio="none"
            role="img"
            viewBox={`0 0 ${width} ${height}`}
          >
            <line
              className="health-chart-gridline"
              x1="0"
              x2={width}
              y1={height / 2}
              y2={height / 2}
            />
            {geometry.series.map((series, index) => (
              <polygon
                key={`${series.name}-area`}
                fill={CHART_COLORS[index % CHART_COLORS.length]}
                fillOpacity={geometry.series.length > 1 ? 0.08 : 0.13}
                points={makeArea(series)}
                stroke="none"
              />
            ))}
            {geometry.series.map((series, index) => (
              <polyline
                key={series.name}
                fill="none"
                points={makePoints(series)}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {/* Three unlabelled dotted rules used to sit behind the trace,
              which is decoration: a gridline you cannot read a value off
              tells you nothing. One mid rule, with the domain labelled. */}
          <span className="health-chart-bound is-max">
            {formatMetric(geometry.max, unit)}
          </span>
          <span className="health-chart-bound is-min">
            {formatMetric(geometry.min, unit)}
          </span>
        </div>
      ) : (
        <div className="health-chart-empty">Collecting history…</div>
      )}
    </article>
  );
}

function workloadSort(items: SystemHealthWorkload[]) {
  return [...items].sort(
    (left, right) =>
      right.cpu_percent - left.cpu_percent || right.memory_bytes - left.memory_bytes,
  );
}

export default function SystemHealthView() {
  const [summary, setSummary] = useState<SystemHealthSummary | null>(null);
  const [alerts, setAlerts] = useState<SystemHealthAlerts | null>(null);
  const [workloads, setWorkloads] = useState<SystemHealthWorkloads | null>(null);
  const [history, setHistory] = useState<Record<string, SystemHealthHistory>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (force = false) => {
    const [nextSummary, nextAlerts] = await Promise.all([
      fetchSystemHealthSummary(force),
      fetchSystemHealthAlerts(force),
    ]);
    setSummary(nextSummary);
    setAlerts(nextAlerts);
    setError(null);
  }, []);

  const loadHistories = useCallback(async () => {
    const metrics = ['cpu', 'memory', 'network', 'disk_io'] as const;
    const results = await Promise.allSettled(
      metrics.map((metric) =>
        fetchSystemHealthHistory(metric, { seconds: 3600, points: 120 }),
      ),
    );
    setHistory((current) => {
      const next = { ...current };
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') next[metrics[index]] = result.value;
      });
      return next;
    });
  }, []);

  const loadWorkloads = useCallback(async (force = false) => {
    setWorkloads(await fetchSystemHealthWorkloads(force));
  }, []);

  const refreshAll = useCallback(
    async (force = false) => {
      if (force) setRefreshing(true);
      try {
        await Promise.allSettled([
          loadSnapshot(force),
          loadHistories(),
          loadWorkloads(force),
        ]).then((results) => {
          const failure = results.find((result) => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [loadHistories, loadSnapshot, loadWorkloads],
  );

  useEffect(() => {
    // The tab title is owned by App.tsx's documentTitleFor effect; assigning
    // it here too meant a second format could clobber it on any later re-run.
    const reportRefreshError = (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    };
    const stopSnapshotPolling = startVisibilityAwarePolling({
      intervalMs: 5_000,
      poll: async () => {
        try {
          await loadSnapshot();
        } catch (reason) {
          reportRefreshError(reason);
        } finally {
          setLoading(false);
        }
      },
    });
    const stopWorkloadPolling = startVisibilityAwarePolling({
      intervalMs: 15_000,
      poll: () => loadWorkloads().catch(reportRefreshError),
    });
    const stopHistoryPolling = startVisibilityAwarePolling({
      intervalMs: 30_000,
      poll: loadHistories,
    });
    return () => {
      stopSnapshotPolling();
      stopWorkloadPolling();
      stopHistoryPolling();
    };
  }, [loadHistories, loadSnapshot, loadWorkloads]);

  if (loading && !summary) {
    return (
      <div className="health-loading">
        <Activity className="health-pulse" size={28} />
        <strong>Connecting to system telemetry…</strong>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="health-loading health-error-state">
        <AlertTriangle size={28} />
        <strong>System health could not be loaded</strong>
        <span>{error}</span>
        <button
          className="dt-btn dt-btn--secondary"
          onClick={() => void refreshAll(true)}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  const rootFilesystem = summary.filesystems.find((filesystem) => filesystem.mount === '/');
  const hottestGpu = Math.max(
    0,
    ...summary.gpus.map((gpu) => gpu.temperature_celsius ?? 0),
  );
  const peakGpu = Math.max(0, ...summary.gpus.map((gpu) => gpu.usage_percent ?? 0));
  const activeAlerts = alerts?.alerts ?? [];
  const containers = workloadSort(workloads?.containers ?? []).slice(0, 8);
  const services = workloadSort(workloads?.services ?? []).slice(0, 8);
  const statusLabel =
    summary.status === 'healthy'
      ? 'All systems normal'
      : summary.status === 'warning'
        ? `${summary.alerts.warning} warning${summary.alerts.warning === 1 ? '' : 's'}`
        : summary.status === 'critical'
          ? `${summary.alerts.critical} critical`
          : 'Collector unavailable';

  return (
    <section className="system-health-view">
      <header className="health-header">
        <div className="health-title">
          <span className={`health-status-orb status-${summary.status}`}>
            <Activity size={18} />
          </span>
          <div>
            <h2>System Health</h2>
            <p>
              {summary.host.hostname} · {summary.host.os} · {summary.host.architecture}
            </p>
          </div>
        </div>
        <div className="health-header-actions">
          <span className={`health-status-pill status-${summary.status}`}>
            {summary.status === 'healthy' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            {statusLabel}
          </span>
          <span className="health-source-pill">
            {summary.netdata_version ?? (summary.source?.startsWith('system') ? 'Built-in monitor' : 'Netdata')} · updated {formatUpdated(summary.collected_at)}
          </span>
          <button
            className="health-refresh dt-btn dt-btn--secondary"
            disabled={refreshing}
            onClick={() => void refreshAll(true)}
            type="button"
          >
            <RefreshCw className={refreshing ? 'spinning' : ''} size={15} />
            Refresh
          </button>
        </div>
      </header>

      <div className="health-scroll-area">
        {!summary.available ? (
          <div className="health-collector-banner">
            <ShieldAlert size={20} />
            <div>
              <strong>Netdata is not responding</strong>
              <span>{summary.message ?? 'Start the localhost collector, then refresh this page.'}</span>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="health-inline-error">
            <AlertTriangle size={16} /> {error}
          </div>
        ) : null}

        <div className="health-overview-grid">
          <HealthCard
            icon={<Cpu size={18} />}
            label="CPU"
            value={formatPercent(summary.cpu.usage_percent)}
            meta={`${summary.host.cpu_cores} cores · load ${summary.cpu.load1.toFixed(1)}`}
            percent={summary.cpu.usage_percent}
            tone={summary.cpu.usage_percent >= 90 ? 'critical' : summary.cpu.usage_percent >= 75 ? 'warning' : 'good'}
          />
          <HealthCard
            icon={<MemoryStick size={18} />}
            label="Memory"
            value={formatPercent(summary.memory.usage_percent)}
            meta={`${formatBytes(summary.memory.used_bytes)} of ${formatBytes(summary.memory.total_bytes)}`}
            percent={summary.memory.usage_percent}
            tone={summary.memory.usage_percent >= 90 ? 'critical' : summary.memory.usage_percent >= 75 ? 'warning' : 'good'}
          />
          <HealthCard
            icon={<HardDrive size={18} />}
            label="Root disk"
            value={rootFilesystem ? formatPercent(rootFilesystem.usage_percent) : '—'}
            meta={rootFilesystem ? `${formatBytes(rootFilesystem.available_bytes)} available` : 'No filesystem data'}
            percent={rootFilesystem?.usage_percent}
            tone={(rootFilesystem?.usage_percent ?? 0) >= 95 ? 'critical' : (rootFilesystem?.usage_percent ?? 0) >= 85 ? 'warning' : 'good'}
          />
          <HealthCard
            icon={<Gauge size={18} />}
            label="GPU"
            value={summary.gpus.length ? formatPercent(peakGpu) : 'Not detected'}
            meta={summary.gpus.length ? `${summary.gpus.length} devices · hottest ${hottestGpu.toFixed(0)}°C` : 'Waiting for GPU telemetry'}
            percent={summary.gpus.length ? peakGpu : null}
            tone={hottestGpu >= 85 ? 'critical' : hottestGpu >= 78 ? 'warning' : 'good'}
          />
          <HealthCard
            icon={<Network size={18} />}
            label="Network"
            value={formatBytes(summary.network.received_bytes_per_second, true)}
            meta={`Upload ${formatBytes(summary.network.sent_bytes_per_second, true)}`}
          />
          <HealthCard
            icon={<Server size={18} />}
            label="Uptime"
            value={formatDuration(summary.host.uptime_seconds)}
            meta={`${summary.alerts.normal} checks normal`}
            tone={summary.status === 'healthy' ? 'good' : 'neutral'}
          />
        </div>

        <div className="health-section-heading">
          <div>
            <strong>Last hour</strong>
          </div>
        </div>
        <div className="health-chart-grid">
          <MiniChart title="CPU utilization" subtitle="All cores" history={history.cpu} fixedPercent />
          <MiniChart title="Memory pressure" subtitle="Excluding cache" history={history.memory} fixedPercent />
          <MiniChart title="Network throughput" subtitle="Receive and send" history={history.network} />
          <MiniChart title="Disk throughput" subtitle="Reads and writes" history={history.disk_io} />
        </div>

        <div className="health-detail-grid">
          <article className="health-panel health-alerts-panel">
            <header className="health-panel-title">
              <div>
                <AlertTriangle size={17} />
                <strong>Active alerts</strong>
              </div>
              <span>{activeAlerts.length}</span>
            </header>
            {activeAlerts.length ? (
              <div className="health-alert-list">
                {activeAlerts.map((alert) => (
                  <div className={`health-alert-row alert-${alert.status}`} key={alert.id}>
                    <span className="health-alert-marker" />
                    <div>
                      <strong>{alert.summary}</strong>
                      {/* Netdata often sets detail to the same string as
                          summary, which printed the alert twice, the second
                          time in a dimmer grey that read as a rendering
                          fault. Show detail only when it adds something. */}
                      {alert.detail && alert.detail !== alert.summary ? (
                        <small>{alert.detail}</small>
                      ) : null}
                    </div>
                    {/* Netdata sets units to "status" for state alarms, where
                        the value is an internal state code rather than a
                        measurement — the reboot-required alarm reports 1.0,
                        which rendered as the meaningless "1.0 status" and
                        read as fake precision. Such alarms are fully
                        described by their summary and severity, so only the
                        timestamp is shown. */}
                    <div className="health-alert-value">
                      {alert.value !== null && alert.units !== 'status' ? (
                        <strong>
                          {`${alert.value.toFixed(1)}${alert.units ? ` ${alert.units}` : ''}`}
                        </strong>
                      ) : null}
                      <small>{formatUpdated(alert.updated_at)}</small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="health-panel-empty good">
                <CheckCircle2 size={20} /> No active warnings or critical alerts
              </div>
            )}
          </article>

          <article className="health-panel">
            <header className="health-panel-title">
              <div><HardDrive size={17} /><strong>Filesystems</strong></div>
              <span>{summary.filesystems.length}</span>
            </header>
            <div className="health-table-scroll">
              <table className="health-table">
                <thead><tr><th>Mount</th><th>Used</th><th>Available</th><th>Capacity</th></tr></thead>
                <tbody>
                  {summary.filesystems.map((filesystem) => (
                    <tr key={filesystem.mount}>
                      <td><strong>{filesystem.mount}</strong></td>
                      <td>{formatBytes(filesystem.used_bytes)}</td>
                      <td>{formatBytes(filesystem.available_bytes)}</td>
                      <td>
                        <span className={`table-meter ${filesystem.usage_percent >= 90 ? 'hot' : ''}`}>
                          <i style={{ width: `${Math.min(100, filesystem.usage_percent)}%` }} />
                          {formatPercent(filesystem.usage_percent)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </div>

        <div className="health-section-heading">
          {/* Subtitle dropped for the same reason as "Last hour"'s: the four
              figures below are labelled individually, so the line only listed
              them again. Missed in the first sweep. */}
          <div><strong>Accelerators</strong></div>
        </div>
        <div className="gpu-health-grid">
          {summary.gpus.map((gpu) => (
            <article className="gpu-health-card" key={gpu.uuid}>
              <header>
                <span><Zap size={17} /></span>
                <div><strong>GPU {gpu.index}</strong><small>{gpu.name}</small></div>
                <b>{formatPercent(gpu.usage_percent)}</b>
              </header>
              <div className="gpu-metric-grid">
                <div><span>Memory</span><strong>{formatBytes(gpu.memory_used_bytes)} / {formatBytes(gpu.memory_total_bytes)}</strong></div>
                <div><span>Temperature</span><strong>{gpu.temperature_celsius === null ? '—' : `${gpu.temperature_celsius.toFixed(0)}°C`}</strong></div>
                <div><span>Power</span><strong>{gpu.power_watts === null ? '—' : `${gpu.power_watts.toFixed(0)} W`}</strong></div>
                <div><span>Power limit</span><strong>{gpu.power_limit_watts === null ? '—' : `${gpu.power_limit_watts.toFixed(0)} W`}</strong></div>
              </div>
              <div className="gpu-bars">
                <span style={{ '--bar-value': `${gpu.usage_percent ?? 0}%` } as CSSProperties}>Core</span>
                <span style={{ '--bar-value': `${gpu.memory_usage_percent ?? 0}%` } as CSSProperties}>VRAM</span>
              </div>
            </article>
          ))}
          {!summary.gpus.length ? <div className="health-panel-empty">No GPU telemetry available</div> : null}
        </div>

        <div className="health-detail-grid three-column">
          <article className="health-panel">
            <header className="health-panel-title"><div><Activity size={17} /><strong>Top processes</strong></div><span>{workloads?.processes.length ?? 0}</span></header>
            <div className="health-compact-list">
              {(workloads?.processes ?? []).slice(0, 8).map((process) => (
                <div key={`${process.pid}-${process.name}`}>
                  <span><strong>{process.name}</strong><small>PID {process.pid}</small></span>
                  <span><strong>{process.cpu_percent.toFixed(1)}%</strong><small>{formatBytes(process.memory_bytes)}</small></span>
                </div>
              ))}
            </div>
          </article>
          <article className="health-panel">
            <header className="health-panel-title"><div><Box size={17} /><strong>Containers</strong></div><span>{workloads?.containers.length ?? 0}</span></header>
            <div className="health-compact-list">
              {containers.map((container) => (
                <div key={container.name}>
                  <span><strong>{container.name}</strong><small>{container.kind ?? 'cgroup'} · {container.pids} PID</small></span>
                  <span><strong>{container.cpu_percent.toFixed(1)}%</strong><small>{formatBytes(container.memory_bytes)}</small></span>
                </div>
              ))}
              {!containers.length ? <div className="health-list-empty">No active containers reported</div> : null}
            </div>
          </article>
          <article className="health-panel">
            <header className="health-panel-title"><div><Server size={17} /><strong>Services</strong></div><span>{workloads?.services.length ?? 0}</span></header>
            <div className="health-compact-list">
              {services.map((service) => (
                <div key={service.name}>
                  <span><strong>{service.name}</strong><small>{service.pids} processes</small></span>
                  <span><strong>{service.cpu_percent.toFixed(1)}%</strong><small>{formatBytes(service.memory_bytes)}</small></span>
                </div>
              ))}
            </div>
          </article>
        </div>

        <div className="health-detail-grid">
          <article className="health-panel">
            <header className="health-panel-title"><div><HardDrive size={17} /><strong>Block-device I/O</strong></div><span>{summary.disks.length}</span></header>
            <div className="health-compact-list">
              {summary.disks.slice(0, 10).map((disk) => (
                <div key={disk.name}>
                  <span><strong>{disk.name}</strong><small>block device</small></span>
                  <span><strong>↓ {formatBytes(disk.read_bytes_per_second, true)}</strong><small>↑ {formatBytes(disk.write_bytes_per_second, true)}</small></span>
                </div>
              ))}
            </div>
          </article>
          <article className="health-panel">
            <header className="health-panel-title"><div><Network size={17} /><strong>Network interfaces</strong></div><span>{summary.interfaces.length}</span></header>
            <div className="health-compact-list">
              {summary.interfaces.slice(0, 10).map((networkInterface) => (
                <div key={networkInterface.name}>
                  <span><strong>{networkInterface.name}</strong><small>interface</small></span>
                  <span><strong>↓ {formatBytes(networkInterface.received_bytes_per_second, true)}</strong><small>↑ {formatBytes(networkInterface.sent_bytes_per_second, true)}</small></span>
                </div>
              ))}
            </div>
          </article>
        </div>

        <div className="health-detail-grid">
          <article className="health-panel">
            <header className="health-panel-title"><div><Thermometer size={17} /><strong>Temperature sensors</strong></div><span>{summary.temperatures.length + summary.gpus.length}</span></header>
            <div className="sensor-chip-grid">
              {summary.gpus.map((gpu) => (
                <div key={`gpu-${gpu.uuid}`}><span>GPU {gpu.index}</span><strong>{gpu.temperature_celsius === null ? '—' : `${gpu.temperature_celsius.toFixed(0)}°C`}</strong></div>
              ))}
              {summary.temperatures.map((sensor) => (
                <div key={`${sensor.source}-${sensor.label}`}><span>{sensor.label}</span><strong>{sensor.celsius.toFixed(1)}°C</strong></div>
              ))}
            </div>
          </article>
          <article className="health-panel">
            <header className="health-panel-title"><div><ShieldAlert size={17} /><strong>S.M.A.R.T. health</strong></div><span>{workloads?.smart.devices.length ?? 0}</span></header>
            <div className="health-compact-list">
              {(workloads?.smart.devices ?? []).map((device) => (
                <div key={device.name}>
                  <span><strong>{device.name}</strong><small>{device.protocol} · {device.type}</small></span>
                  <span className={`smart-status is-${smartTone(device.status)}`}><strong>{device.status}</strong><small>{device.message ?? 'Detected'}</small></span>
                </div>
              ))}
              {workloads?.smart.message ? <div className="health-list-note">{workloads.smart.message}</div> : null}
            </div>
          </article>
        </div>

        <footer className="health-footer">
          <Activity size={14} /> Telemetry stays on this machine. Dolphin reads the localhost Netdata API through FastAPI.
        </footer>
      </div>
    </section>
  );
}
