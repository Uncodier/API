import {
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
        },
        {
          level: 'error',
          text: 'Product crashed',
          source: 'http://localhost/app.js:10',
        },
      ],
      pageErrors: [],
      failedRequests: [
        {
          url: HARNESS_TRACKING_SCRIPT_URL,
          failure: 'net::ERR_NAME_NOT_RESOLVED',
          resource_type: 'script',
        },
        {
          url: 'https://api.example.invalid/data',
          failure: 'net::ERR_FAILED',
          resource_type: 'fetch',
        },
      ],
    });

    expect(result.entries).toEqual([
      expect.objectContaining({ text: 'Product crashed' }),
    ]);
    expect(result.failedRequests).toEqual([
      expect.objectContaining({ url: 'https://api.example.invalid/data' }),
    ]);
  });
});
