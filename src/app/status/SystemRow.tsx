import type { PublicSystemCard } from '@/lib/status/get-public-summary';
import type { SystemTimeline } from '@/lib/status/get-system-timelines';
import { timelineHasProbeData } from '@/lib/status/get-system-timelines';
import { StatusTimeline } from '@/app/status/StatusTimeline';
import {
  formatStatusLabel,
  formatUptimeDisplay,
  resolveCurrentStatus,
  statusCssClass,
} from '@/app/status/status-labels';
import styles from './status.module.css';
import { isStatusStale } from '@/lib/status/observation';

export function SystemRow({
  system,
  timeline,
}: {
  system?: PublicSystemCard;
  timeline: SystemTimeline;
}) {
  const hasData = timelineHasProbeData(timeline.days) || !!system?.checkedAt;
  const lastDay = timeline.days[timeline.days.length - 1];
  const stale = !!system?.checkedAt && isStatusStale(system.checkedAt);
  const currentStatus = stale ? 'stale' : resolveCurrentStatus(system?.status, lastDay?.status, hasData);
  const label = system?.label ?? timeline.label;
  const uptimeDisplay = formatUptimeDisplay(
    timeline.uptimePercent,
    hasData,
  );

  const providers =
    system?.checks?.providers && typeof system.checks.providers === 'object'
      ? (system.checks.providers as Record<
          string,
           { liveProbe?: boolean; configured?: boolean; latencyMs?: number; verification?: string; observedHealthy?: boolean; observedStatus?: string }
        >)
      : null;

  return (
    <article className={styles.systemRow}>
      <div className={styles.systemRowHead}>
        <div className={styles.systemRowTitle}>
          <h3>{label}</h3>
          <span className={`${styles.statusDot} ${styles[statusCssClass(currentStatus)]}`}>
            {formatStatusLabel(currentStatus)}
          </span>
        </div>
        <div className={styles.systemRowUptime}>
          <span className={styles.uptimeValue}>{uptimeDisplay}</span>
          <span className={styles.uptimeLabel}>{hasData ? '90-day check success' : 'awaiting probes'}</span>
        </div>
      </div>

      <StatusTimeline timeline={timeline} />

      {system?.summary && <p className={styles.summary}>{system.summary}</p>}
      {system && <details className={styles.details}>
        <summary>Evidence and probe scope</summary>
        <pre>{JSON.stringify(system.checks, null, 2)}</pre>
      </details>}
      {system && <p className={styles.noDataHint}>
        {stale ? 'Stale evidence · ' : ''}Last check: {new Date(system.checkedAt).toISOString()}
        {' · '}{system.latencyMs} ms
      </p>}

      {!hasData && (
        <p className={styles.noDataHint}>Timeline fills in after the first health check run.</p>
      )}

      {providers && (
        <div className={styles.providerPills}>
          {Object.entries(providers).map(([name, p]) => (
            <span
              key={name}
              className={`${styles.providerPill} ${
                p.liveProbe || p.observedHealthy ? styles.providerPillUp
                  : p.observedStatus === 'down' || p.observedStatus === 'degraded' ? styles.providerPillDown : styles.providerPillSkipped
              }`}
            >
              {name}
              {p.liveProbe ? ' ✓ live verified' : p.observedHealthy ? ' ✓ observed'
                : p.observedStatus === 'down' || p.observedStatus === 'degraded' ? ' ✗ observed failure'
                : p.configured ? ' · unverified' : ' · not configured'}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
