import { getPublicSummary } from '@/lib/status/get-public-summary';
import { getCachedSystemTimelines } from '@/lib/status/cached-timelines';
import {
  aggregateDayStatus,
  computeTimelineUptime,
  getSystemTimelines,
  type TimelineDay,
} from '@/lib/status/get-system-timelines';
import { SystemRow } from '@/app/status/SystemRow';
import { StatusTimeline } from '@/app/status/StatusTimeline';
import { formatStatusLabel, formatUptimeDisplay, statusCssClass } from '@/app/status/status-labels';
import styles from './status.module.css';

export const dynamic = 'force-dynamic';

function formatTrigger(trigger: string | null): string {
  if (!trigger) return '—';
  if (trigger === 'cron_hourly') return 'Hourly cron';
  if (trigger === 'github_push') return 'Deploy / push';
  if (trigger === 'manual') return 'Manual';
  return trigger;
}

export default async function StatusPage() {
  const [summary, history] = await Promise.all([
    getPublicSummary(),
    getCachedSystemTimelines().then(timelines => ({ timelines, unavailable: false }))
      .catch(() => ({ timelines: [], unavailable: true })),
  ]);
  const timelines = history.timelines;

  const systemByKey = new Map(summary.systems.map((s) => [s.systemKey, s]));
  const aiTimelines = timelines.filter((t) => t.systemKey.startsWith('ai_'));
  const otherTimelines = timelines.filter((t) => !t.systemKey.startsWith('ai_'));

  const overallTimelineDays = buildOverallTimeline(timelines);

  return (
    <main
      className={`${styles.page} x:w-full x:min-w-0 x:break-words x:text-slate-700 x:dark:text-slate-200`}
    >
      <header className={styles.header}>
        <h1>API Status</h1>
        <p className={styles.subtitle}>Makinari API — health evidence and check history</p>
        <div className={`${styles.badge} ${styles[statusCssClass(summary.overall)]}`}>
          {formatStatusLabel(summary.overall)}
        </div>
      </header>

      <section className={styles.slaRow}>
        <div className={styles.slaCard}>
          <span className={styles.slaLabel}>Observed check success (24h)</span>
          <strong className={styles.slaValue}>
            {formatUptimeDisplay(summary.lastRunAt ? summary.overallSla24h : null, !!summary.lastRunAt)}
          </strong>
        </div>
        <div className={styles.slaCard}>
          <span className={styles.slaLabel}>Observation coverage (latest run)</span>
          <strong className={styles.slaValue}>
            {formatUptimeDisplay(summary.observation?.coveragePercent, !!summary.observation?.total)}
          </strong>
          <span>{summary.observation?.observed ?? 0}/{summary.observation?.total ?? 0} systems observed</span>
        </div>
        <div className={styles.slaCard}>
          <span className={styles.slaLabel}>Last check</span>
          <strong className={styles.slaValue}>
            {summary.lastRunAt ? new Date(summary.lastRunAt).toLocaleString() : 'Never'}
          </strong>
        </div>
        <div className={styles.slaCard}>
          <span className={styles.slaLabel}>Trigger</span>
          <strong className={styles.slaValue}>{formatTrigger(summary.lastTrigger)}</strong>
        </div>
      </section>
      <p className={styles.emptyHint}>
        Percentages count successful observed checks, not time-based availability or an SLA.
        Unverified checks are excluded; missing observations never imply healthy service.
        Contract probes verify route behavior, not end-to-end job completion.
      </p>
      {(summary.stale || summary.sourceUnavailable) && <p role="alert" className={styles.emptyHint}>
        {summary.stale ? 'Monitoring evidence is stale (hourly checks expire after 90 minutes). ' : ''}
        {summary.sourceUnavailable ? 'Status refresh failed; showing the last available snapshot.' : ''}
      </p>}
      {history.unavailable && <p role="alert" className={styles.emptyHint}>
        Check history is temporarily unavailable. This is a data-loading failure, not an empty history.
      </p>}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>90-day check history</h2>
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={`${styles.legendSwatch} ${styles.timelineBarSkipped}`} /> Unverified
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendSwatch} ${styles.timelineBarUp}`} /> Operational
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendSwatch} ${styles.timelineBarDegraded}`} /> Degraded
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendSwatch} ${styles.timelineBarDown}`} /> Down
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendSwatch} ${styles.timelineBarNone}`} /> No data
            </span>
          </div>
        </div>
        <div className={styles.overallRow}>
          <span className={styles.overallLabel}>All systems</span>
          <StatusTimeline
            timeline={{
              systemKey: 'overall',
              label: 'All systems',
              days: overallTimelineDays,
              uptimePercent: computeTimelineUptime(overallTimelineDays),
            }}
          />
        </div>
      </section>

      {aiTimelines.length > 0 && (
        <section className={styles.section}>
          <h2>AI Services</h2>
          <div className={styles.systemList}>
            {aiTimelines.map((timeline) => (
              <SystemRow
                key={timeline.systemKey}
                timeline={timeline}
                system={systemByKey.get(timeline.systemKey)}
              />
            ))}
          </div>
        </section>
      )}

      <section className={styles.section}>
        <h2>Platform Systems</h2>
        {summary.lastRunAt === null && (
          <p className={styles.emptyHint}>
            No probe runs yet. Timelines will fill after cron or deploy. Run{' '}
            <code>npm run status:probe</code> or wait for the hourly cron.
          </p>
        )}
        <div className={styles.systemList}>
          {otherTimelines.map((timeline) => (
            <SystemRow
              key={timeline.systemKey}
              timeline={timeline}
              system={systemByKey.get(timeline.systemKey)}
            />
          ))}
        </div>
      </section>

      <footer className={styles.footer}>
        <a href="/api/status" className="x:text-primary-600 x:dark:text-primary-400">
          JSON API
        </a>
        {' · '}
        <a href="/api/status/systems" className="x:text-primary-600 x:dark:text-primary-400">
          Systems list
        </a>
      </footer>
    </main>
  );
}

function buildOverallTimeline(
  timelines: Awaited<ReturnType<typeof getSystemTimelines>>,
): TimelineDay[] {
  if (timelines.length === 0 || timelines[0].days.length === 0) return [];
  return timelines[0].days.map((_, i) => {
    const dayStatuses = timelines.map((t) => t.days[i]?.status ?? 'none');
    const date = timelines[0].days[i].date;
    const checkCount = timelines.reduce((sum, t) => sum + (t.days[i]?.checkCount ?? 0), 0);
    return {
      date,
      status: aggregateDayStatus(dayStatuses.filter((s) => s !== 'none')),
      checkCount,
      observedCheckCount: timelines.reduce((sum, t) => sum + (t.days[i]?.observedCheckCount ?? 0), 0),
      upCheckCount: timelines.reduce((sum, t) => sum + (t.days[i]?.upCheckCount ?? 0), 0),
    };
  });
}
