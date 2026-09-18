import {
  dedupeFailedRequests,
  filterHarnessOwnedTelemetry,
  HARNESS_TRACKING_SCRIPT_URL,
} from '../step-visual-telemetry';

describe('visual telemetry filtering', () => {
  it('drops only failures caused by the harness-injected tracking script', () => {
    const result = filterHarnessOwnedTelemetry({
      entries: [
        {
          level: 'error',
          text: 'Failed to load resource',
          source: `${HARNESS_TRACKING_SCRIPT_URL}:0`,
          route: '/dashboard',
          viewport: 'desktop',
        },
        {
          level: 'error',
          text: 'Product crashed',
          source: 'http://localhost/app.js:10',
          route: '/dashboard',
          viewport: 'desktop',
        },
      ],
      pageErrors: [],
      failedRequests: [
        {
          url: HARNESS_TRACKING_SCRIPT_URL,
          failure: 'net::ERR_NAME_NOT_RESOLVED',
          resource_type: 'script',
          route: '/dashboard',
          viewport: 'desktop',
        },
        {
          url: 'https://api.example.invalid/data',
          failure: 'net::ERR_FAILED',
          resource_type: 'fetch',
          route: '/dashboard',
          viewport: 'desktop',
        },
      ],
      ownedScopes: [{ route: '/dashboard', viewport: 'desktop' }],
    });

    expect(result.entries).toEqual([
      expect.objectContaining({ text: 'Product crashed' }),
    ]);
    expect(result.failedRequests).toEqual([
      expect.objectContaining({ url: 'https://api.example.invalid/data' }),
    ]);
  });

  it('drops canonical tracking failures after the ownership marker is removed', () => {
    const result = filterHarnessOwnedTelemetry({
      entries: [{
        level: 'error',
        text: 'Failed to load resource: net::ERR_NAME_NOT_RESOLVED',
        source: `${HARNESS_TRACKING_SCRIPT_URL}:0`,
        route: '/pricing',
        viewport: 'desktop',
      }],
      pageErrors: [],
      failedRequests: [{
        url: HARNESS_TRACKING_SCRIPT_URL,
        failure: 'net::ERR_NAME_NOT_RESOLVED',
        resource_type: 'script',
        route: '/pricing',
        viewport: 'desktop',
      }],
      ownedScopes: [],
    });

    expect(result.entries).toEqual([]);
    expect(result.failedRequests).toEqual([]);
  });

  it('preserves failures from lookalike tracking URLs', () => {
    const lookalikeUrl = `${HARNESS_TRACKING_SCRIPT_URL}.attacker.invalid`;
    const result = filterHarnessOwnedTelemetry({
      entries: [{
        level: 'error',
        text: 'Failed to load resource',
        source: `${lookalikeUrl}:0`,
      }],
      pageErrors: [],
      failedRequests: [{
        url: lookalikeUrl,
        failure: 'net::ERR_NAME_NOT_RESOLVED',
        resource_type: 'script',
      }],
    });

    expect(result.entries).toHaveLength(1);
    expect(result.failedRequests).toHaveLength(1);
  });

  it('merges Next.js prefetch response and abort events for one request', () => {
    const requests = [
      {
        url: 'http://127.0.0.1:3000/privacy?_rsc=first',
        status: 404,
        resource_type: 'fetch',
        route: '/contact',
        viewport: 'desktop',
      },
      {
        url: 'http://127.0.0.1:3000/privacy?_rsc=second',
        failure: 'net::ERR_ABORTED',
        resource_type: 'fetch',
        route: '/contact',
        viewport: 'desktop',
      },
    ];
    const result = dedupeFailedRequests(requests);

    expect(result).toEqual([
      expect.objectContaining({
        status: 404,
        failure: 'net::ERR_ABORTED',
      }),
    ]);
    expect(dedupeFailedRequests([...requests].reverse())).toEqual(result);
  });

  it.each([
    ['404 then 503', [404, 503]],
    ['503 then 404', [503, 404]],
  ])('keeps the most severe status for %s', (_label, statuses) => {
    const result = dedupeFailedRequests(statuses.map((status, index) => ({
      url: `http://127.0.0.1:3000/privacy?_rsc=${index}`,
      status,
      resource_type: 'fetch',
      route: '/contact',
      viewport: 'desktop',
    })));

    expect(result).toEqual([
      expect.objectContaining({
        url: 'http://127.0.0.1:3000/privacy',
        status: 503,
      }),
    ]);
  });
});
