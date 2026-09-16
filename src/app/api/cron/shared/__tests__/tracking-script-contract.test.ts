import {
  buildHarnessTrackingScriptTag,
  buildLegacyTrackingScriptTag,
  HARNESS_TRACKING_ATTRIBUTE,
} from '../tracking-script-contract';

describe('tracking script contract', () => {
  it('marks new harness injections while retaining the exact legacy signature', () => {
    const current = buildHarnessTrackingScriptTag('site-1');
    const legacy = buildLegacyTrackingScriptTag('site-1');

    expect(current).toContain(HARNESS_TRACKING_ATTRIBUTE);
    expect(current).toContain('data-site-id="site-1"');
    expect(legacy).not.toContain(HARNESS_TRACKING_ATTRIBUTE);
  });
});
