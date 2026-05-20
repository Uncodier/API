function computeUptime(rows: { status: string }[]): number {
  const counted = rows.filter((r) => ['up', 'down', 'degraded'].includes(r.status));
  if (counted.length === 0) return 100;
  const up = counted.filter((r) => r.status === 'up').length;
  return Math.round((up / counted.length) * 1000) / 10;
}

describe('computeUptime', () => {
  it('returns 100 when no counted rows', () => {
    expect(computeUptime([])).toBe(100);
  });

  it('returns 100 when all up', () => {
    expect(computeUptime([{ status: 'up' }, { status: 'up' }])).toBe(100);
  });

  it('excludes skipped from denominator', () => {
    expect(computeUptime([{ status: 'up' }, { status: 'skipped' }, { status: 'down' }])).toBe(50);
  });

  it('counts degraded as not up', () => {
    expect(computeUptime([{ status: 'up' }, { status: 'degraded' }])).toBe(50);
  });
});
