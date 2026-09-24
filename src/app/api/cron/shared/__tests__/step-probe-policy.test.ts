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
    expect(result.observations).toContainEqual(expect.objectContaining({
      target: '/checkout',
      target_resolution: expect.objectContaining({
        strategy: 'step_validation_target',
        required: true,
      }),
    }));
  });

  it('records an invalid declared target instead of probing it', () => {
    const plan = buildRuntimeTargetPlan({
      validationTargets: [{
        kind: 'page',
        path: '/>',
        expected_statuses: [200],
      }],
    });

    expect(plan.pages).toEqual([]);
    expect(plan.observations).toContainEqual(expect.objectContaining({
      kind: 'contract',
      disposition: 'unknown',
      detail: expect.stringContaining('Invalid validation target'),
      target_resolution: expect.objectContaining({
        status: 'invalid',
        required: false,
      }),
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

  it('keeps targets inferred from legacy prose advisory', () => {
    const plan = buildRuntimeTargetPlan({
      acceptance: [
        'GET /api/campaigns returns 200 and lists campaigns created by the user.',
      ],
    });

    expect(plan.apis).toEqual([
      expect.objectContaining({
        path: '/api/campaigns',
        method: 'GET',
        required: false,
        source: 'contract_inferred',
        expected_statuses: [200],
        auth_required: true,
      }),
    ]);
  });

  it('hardens targets from a declared structured contract', () => {
    const acceptance = [
      'GET /api/campaigns returns 200 for authenticated users.',
    ];
    const plan = buildRuntimeTargetPlan({
      acceptance,
      acceptanceContract: {
        schema_version: 2,
        source: 'declared',
        criteria: [{
          id: 'campaign-list',
          text: acceptance[0],
          all_of: [{
            kind: 'http_response',
            path: '/api/campaigns',
            method: 'GET',
            expected_status: '200',
            auth: 'required',
          }],
        }],
      },
    });

    expect(plan.apis).toEqual([
      expect.objectContaining({
        path: '/api/campaigns',
        method: 'GET',
        required: true,
        source: 'contract',
        criterion_id: 'campaign-list',
      }),
    ]);
  });

  it('expands wildcard contract statuses before runtime evaluation', () => {
    const acceptance = ['GET /api/missing returns 4xx.'];
    const plan = buildRuntimeTargetPlan({
      acceptance,
      acceptanceContract: {
        schema_version: 2,
        source: 'declared',
        criteria: [{
          id: 'missing-api',
          text: acceptance[0],
          all_of: [{
            kind: 'http_response',
            path: '/api/missing',
            method: 'GET',
            expected_status: '4xx',
            auth: 'unspecified',
          }],
        }],
      },
    });
    const result = evaluateRuntimeProbe(probe({
      apis: [{
        path: '/api/missing',
        method: 'GET',
        http_status: 404,
      }],
    }), plan);

    expect(plan.apis[0].expected_statuses).toEqual(
      expect.arrayContaining([400, 404, 499]),
    );
    expect(result.hardFailure).toBe(false);
  });

  it('binds a Next.js route template to a concrete validation target', () => {
    const acceptance = ['GET /api/assets/[id] returns 200.'];
    const plan = buildRuntimeTargetPlan({
      acceptance,
      acceptanceContract: {
        schema_version: 2,
        source: 'declared',
        criteria: [{
          id: 'asset-detail',
          text: acceptance[0],
          all_of: [{
            kind: 'http_response',
            path: '/api/assets/[id]',
            method: 'GET',
            expected_status: '200',
            auth: 'unspecified',
          }],
        }],
      },
      validationTargets: [{
        kind: 'api',
        path: '/api/assets/123',
        method: 'GET',
      }],
      restrictContractTargetsToValidation: true,
    });

    expect(plan.apis).toEqual([
      expect.objectContaining({
        path: '/api/assets/123',
        criterion_id: 'asset-detail',
        expected_statuses: [200],
      }),
    ]);
    expect(plan.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        target_resolution: expect.objectContaining({
          status: 'template_unresolved',
        }),
      }),
    ]));
  });

  it('excludes future contract routes from a restricted step plan', () => {
    const acceptance = [
      'GET /api/current returns 200.',
      'GET /api/future returns 200.',
    ];
    const plan = buildRuntimeTargetPlan({
      acceptance,
      acceptanceContract: {
        schema_version: 2,
        source: 'declared',
        criteria: acceptance.map((text, index) => ({
          id: `route-${index}`,
          text,
          all_of: [{
            kind: 'http_response' as const,
            path: index === 0 ? '/api/current' : '/api/future',
            method: 'GET' as const,
            expected_status: '200',
            auth: 'unspecified' as const,
          }],
        })),
      },
      validationTargets: [{
        kind: 'api',
        path: '/api/current',
        method: 'GET',
      }],
      restrictContractTargetsToValidation: true,
    });

    expect(plan.apis.map((target) => target.path)).toEqual(['/api/current']);
  });

  it('records malformed legacy targets as contract gaps without probing', () => {
    const acceptance = ['Render the evidence input.'];
    const plan = buildRuntimeTargetPlan({
      acceptance,
      acceptanceContract: {
        schema_version: 1,
        criteria: [{
          id: 'criterion-1',
          text: acceptance[0],
          all_of: [{
            kind: 'page_response',
            path: '/>',
          }],
        }],
      },
    });

    expect(plan.pages).toEqual([]);
    expect(plan.observations).toContainEqual(expect.objectContaining({
      kind: 'contract',
      target: '/>',
      disposition: 'unknown',
      target_resolution: expect.objectContaining({
        status: 'invalid',
        required: false,
      }),
    }));
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
