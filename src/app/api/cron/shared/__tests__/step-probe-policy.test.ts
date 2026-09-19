import {
  buildRuntimeTargetPlan,
  evaluateRuntimeProbe,
} from '../step-probe-policy';

function probe(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    port: 3000,
    duration_ms: 10,
    server_log_tail: '',
    server_errors: [],
    pages: [],
    apis: [],
    server_log_path: '/tmp/server.log',
    ...overrides,
  } as any;
}

describe('runtime probe policy', () => {
  it('keeps prose and diff route failures advisory', () => {
    const plan = buildRuntimeTargetPlan({
      proseRoutes: ['/ui'],
      inferredPageRoutes: ['/dashboard'],
    });
    const result = evaluateRuntimeProbe(probe({
      pages: [
        { path: '/ui', http_status: 404 },
        { path: '/dashboard', http_status: 200 },
      ],
    }), plan);

    expect(result.hardFailure).toBe(false);
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: '/ui',
        source: 'prose',
        disposition: 'advisory',
      }),
    ]));
  });

  it('hard-fails an explicitly declared route with the wrong status', () => {
    const plan = buildRuntimeTargetPlan({
      validationTargets: [{
        kind: 'page',
        path: '/checkout',
        expected_statuses: [200],
      }],
    });
    const result = evaluateRuntimeProbe(probe({
      pages: [{ path: '/checkout', http_status: 404 }],
    }), plan);

    expect(result.hardFailure).toBe(true);
    expect(result.pages[0]).toEqual(expect.objectContaining({
      validation_required: true,
      validation_disposition: 'hard_fail',
    }));
  });

  it('does not invent payloads for non-GET APIs', () => {
    const plan = buildRuntimeTargetPlan({
      validationTargets: [{
        kind: 'api',
        path: '/api/assets',
        method: 'POST',
        expected_statuses: [201],
      }],
      inferredApiRoutes: [{
        path: '/api/jobs',
        method: 'PATCH',
      }],
    });

    expect(plan.apis).toEqual([]);
    expect(plan.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'POST /api/assets',
        disposition: 'unknown',
      }),
      expect.objectContaining({
        target: 'PATCH /api/jobs',
        disposition: 'advisory',
      }),
    ]));
  });

  it('validates an explicit method, payload, and status', () => {
    const plan = buildRuntimeTargetPlan({
      validationTargets: [{
        kind: 'api',
        path: '/api/assets',
        method: 'POST',
        payload: { name: 'logo.svg' },
        expected_statuses: [201],
      }],
    });
    const result = evaluateRuntimeProbe(probe({
      apis: [{
        path: '/api/assets',
        method: 'POST',
        payload_source: 'scenario',
        http_status: 201,
      }],
    }), plan);

    expect(plan.apis).toEqual([
      expect.objectContaining({
        method: 'POST',
        payload: { name: 'logo.svg' },
      }),
    ]);
    expect(result.hardFailure).toBe(false);
  });
});
