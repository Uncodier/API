import type { SystemTimeline, TimelineDay, TimelineDayStatus } from '@/lib/status/get-system-timelines';
import styles from './status.module.css';

const STATUS_LABELS: Record<TimelineDayStatus, string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  skipped: 'Skipped',
  none: 'No data',
};

function barClass(status: TimelineDayStatus): string {
  switch (status) {
    case 'up':
      return styles.timelineBarUp;
    case 'degraded':
      return styles.timelineBarDegraded;
    case 'down':
      return styles.timelineBarDown;
    case 'skipped':
      return styles.timelineBarSkipped;
    default:
      return styles.timelineBarNone;
  }
}

function formatDayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00.000Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function DayBar({ day }: { day: TimelineDay }) {
  const label = `${formatDayLabel(day.date)} — ${STATUS_LABELS[day.status]}${
    day.checkCount > 0 ? ` (${day.checkCount} checks)` : ''
  }`;
  return (
    <span
      className={`${styles.timelineBar} ${barClass(day.status)}`}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

export function StatusTimeline({ timeline }: { timeline: SystemTimeline }) {
  const first = timeline.days[0]?.date;
  const last = timeline.days[timeline.days.length - 1]?.date;

  return (
    <div className={styles.timelineWrap}>
      <div className={styles.timelineBars} role="list" aria-label={`${timeline.label} uptime history`}>
        {timeline.days.map((day) => (
          <DayBar key={day.date} day={day} />
        ))}
      </div>
      <div className={styles.timelineAxis}>
        <span>{first ? formatDayLabel(first) : ''}</span>
        <span>{last ? formatDayLabel(last) : ''}</span>
      </div>
    </div>
  );
}
