import {
  buildRuntimeTargetPlan,
  evaluateRuntimeProbe,
  expectedStatusesFromAcceptance,
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

  it('executes required non-GET APIs without inventing payloads', () => {
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

    expect(plan.apis).toEqual([
      expect.objectContaining({
        path: '/api/assets',
        method: 'POST',
        required: true,
      }),
    ]);
    expect(plan.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'PATCH /api/jobs',
        disposition: 'advisory',
      }),
    ]));
    const result = evaluateRuntimeProbe(probe({
      apis: [{
        path: '/api/assets',
        method: 'POST',
        http_status: 400,
      }],
    }), plan);
    expect(result.hardFailure).toBe(true);
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
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'POST /api/assets',
        method: 'POST',
        http_status: 201,
        expected_statuses: [201],
      }),
    ]));
  });

  it('parses template routes and multiple acceptance statuses', () => {
    expect(expectedStatusesFromAcceptance({
      acceptance: [
        'PATCH /api/assets/[id]/approve responds with status 200 or 204.',
      ],
      method: 'PATCH',
      path: '/api/assets/1/approve',
    })).toEqual([200, 204]);
  });

  it('uses backlog acceptance over unrelated permissive statuses', () => {
    const acceptance = [
      'PATCH /api/assets/:id/approve returns 200 and updates asset status.',
    ];
    expect(expectedStatusesFromAcceptance({
      acceptance,
      method: 'PATCH',
      path: '/api/assets/1/approve',
    })).toEqual([200]);
    const plan = buildRuntimeTargetPlan({
      acceptance,
      validationTargets: [{
        kind: 'api',
        path: '/api/assets/1/approve',
        method: 'PATCH',
        payload: { status: 'approved' },
        expected_statuses: [200, 500],
      }],
    });

    expect(plan.apis[0]).toEqual(expect.objectContaining({
      expected_statuses: [200],
    }));
    const result = evaluateRuntimeProbe(probe({
      apis: [{
        path: '/api/assets/1/approve',
        method: 'PATCH',
        payload_source: 'scenario',
        http_status: 500,
      }],
    }), plan);
    expect(result.hardFailure).toBe(true);
    expect(result.apis[0]).toEqual(expect.objectContaining({
      validation_disposition: 'hard_fail',
    }));
  });

  it('keeps unauthenticated statuses while requiring authenticated evidence', () => {
    const plan = buildRuntimeTargetPlan({
      acceptance: [
        'PATCH /api/assets/:id/approve returns 200 and updates asset status.',
      ],
      validationTargets: [{
        kind: 'api',
        path: '/api/assets/1/approve',
        method: 'PATCH',
        payload: { status: 'approved' },
        expected_statuses: [200, 401],
      }],
    });

    expect(plan.apis[0]).toEqual(expect.objectContaining({
      expected_statuses: [200, 401],
    }));
    expect(plan.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'PATCH /api/assets/1/approve',
        disposition: 'advisory',
        expected_statuses: [200],
      }),
    ]));
    const result = evaluateRuntimeProbe(probe({
      apis: [{
        path: '/api/assets/1/approve',
        method: 'PATCH',
        payload_source: 'scenario',
        http_status: 401,
      }],
    }), plan);
    expect(result.hardFailure).toBe(false);
    expect(result.apis[0]).toEqual(expect.objectContaining({
      validation_disposition: 'pass',
    }));
  });

  it('keeps a declared protected API boundary advisory for an unauthenticated probe', () => {
    const plan = buildRuntimeTargetPlan({
      acceptance: [
        'POST /api/assets/upload returns 200 and stores the asset.',
      ],
      validationTargets: [{
        kind: 'api',
        path: '/api/assets/upload',
        method: 'POST',
        payload: { name: 'asset.png' },
        expected_statuses: [200],
        auth_required: true,
      }],
    });

    const result = evaluateRuntimeProbe(probe({
      apis: [{
        path: '/api/assets/upload',
        method: 'POST',
        payload_source: 'scenario',
        http_status: 401,
      }],
    }), plan);

    expect(result.hardFailure).toBe(false);
    expect(result.apis[0]).toEqual(expect.objectContaining({
      validation_required: true,
      validation_disposition: 'advisory',
    }));
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'POST /api/assets/upload',
        disposition: 'advisory',
        detail: expect.stringContaining('authentication boundary'),
      }),
    ]));
  });

  it('hard-fails a public API that unexpectedly returns an authentication status', () => {
    const plan = buildRuntimeTargetPlan({
      acceptance: ['GET /api/catalog returns 200 for public requests.'],
      validationTargets: [{
        kind: 'api',
        path: '/api/catalog',
        method: 'GET',
        expected_statuses: [200],
      }],
    });

    const result = evaluateRuntimeProbe(probe({
      apis: [{
        path: '/api/catalog',
        method: 'GET',
        http_status: 403,
      }],
    }), plan);

    expect(result.hardFailure).toBe(true);
    expect(result.apis[0]).toEqual(expect.objectContaining({
      validation_required: true,
      validation_disposition: 'hard_fail',
    }));
  });

  it('infers an authentication boundary from the matching API contract', () => {
    const plan = buildRuntimeTargetPlan({
      acceptance: [
        'Authenticated users can GET /api/account and receive status 200.',
      ],
      validationTargets: [{
        kind: 'api',
        path: '/api/account',
        method: 'GET',
        expected_statuses: [200],
      }],
    });

    const result = evaluateRuntimeProbe(probe({
      apis: [{
        path: '/api/account',
        method: 'GET',
        http_status: 401,
      }],
    }), plan);

    expect(plan.apis[0]).toEqual(expect.objectContaining({
      auth_required: true,
    }));
    expect(result.hardFailure).toBe(false);
    expect(result.apis[0]).toEqual(expect.objectContaining({
      validation_disposition: 'advisory',
    }));
  });

  it('derives safe GET targets directly from backlog acceptance', () => {
    const plan = buildRuntimeTargetPlan({
      acceptance: [
        'GET /api/campaigns returns 200 and lists campaigns created by the user.',
      ],
    });

    expect(plan.apis).toEqual([
      expect.objectContaining({
        path: '/api/campaigns',
        method: 'GET',
        required: true,
        expected_statuses: [200],
        auth_required: true,
      }),
    ]);
  });

  it('records a typed gap instead of calling an undeclared non-GET target', () => {
    const plan = buildRuntimeTargetPlan({
      acceptance: [
        'POST /api/campaigns returns 200 and creates a campaign.',
      ],
    });

    expect(plan.apis).toEqual([]);
    expect(plan.observations).toContainEqual(expect.objectContaining({
      target: 'POST /api/campaigns',
      disposition: 'unknown',
      detail: expect.stringContaining('payload fixture'),
    }));
  });
});
