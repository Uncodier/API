import {
  analyzeAcceptanceEntry,
  routesFromAcceptance,
} from '../requirement-acceptance';
import {
  analyzeAcceptanceRoutePath,
  routeTemplateMatches,
} from '../acceptance-route-path';

describe('acceptance route extraction', () => {
  it('extracts standalone application routes only', () => {
    expect(routesFromAcceptance([
      'POST /api/assets returns 201 and /dashboard/assets renders.',
      'Use components/ui and inspect hydration/runtime.',
      'Edit /src/app/dashboard/page.tsx.',
    ])).toEqual(['/api/assets', '/dashboard/assets']);
  });

  it('extracts every route in a criterion, including the root route', () => {
    const criterion =
      'GET /, GET /services, GET /about, and GET /contact return 200.';

    expect(routesFromAcceptance([criterion])).toEqual([
      '/',
      '/services',
      '/about',
      '/contact',
    ]);
    expect(
      analyzeAcceptanceEntry(criterion).anchors
        .filter((anchor) => anchor.kind === 'route')
        .map((anchor) => anchor.value),
    ).toEqual(['/', '/services', '/about', '/contact']);
  });

  it('does not interpret a prose separator as the root route', () => {
    expect(routesFromAcceptance([
      'Users can choose login / signup from the landing page.',
    ])).toEqual([]);
  });

  it('does not interpret a self-closing JSX tag as a route', () => {
    expect(routesFromAcceptance([
      'Render <input type="file" capture="environment" /> for evidence.',
    ])).toEqual([]);
  });

  it('rejects markup-like and malformed route candidates', () => {
    expect(routesFromAcceptance([
      'Render <Component /> and keep /valid/path available.',
      'Do not probe /broken//path or /bad>target.',
    ])).toEqual(['/valid/path']);
  });

  it('associates each route with its own HTTP method and status', () => {
    const routeAnchors = analyzeAcceptanceEntry(
      'GET /users returns 200 and POST /orders returns 201.',
    ).anchors.filter((anchor) => anchor.kind === 'route');

    expect(routeAnchors).toEqual([
      { kind: 'route', value: '/users', method: 'GET', status: '200' },
      { kind: 'route', value: '/orders', method: 'POST', status: '201' },
    ]);
  });

  it('associates trailing status codes by route when using respectively', () => {
    const routeAnchors = analyzeAcceptanceEntry(
      'GET /users and POST /orders return 200 and 201 respectively.',
    ).anchors.filter((anchor) => anchor.kind === 'route');

    expect(routeAnchors).toEqual([
      { kind: 'route', value: '/users', method: 'GET', status: '200' },
      { kind: 'route', value: '/orders', method: 'POST', status: '201' },
    ]);
  });

  it('preserves separate contracts for repeated route paths', () => {
    const routeAnchors = analyzeAcceptanceEntry(
      'GET /users returns 200 and POST /users returns 201.',
    ).anchors.filter((anchor) => anchor.kind === 'route');

    expect(routeAnchors).toEqual([
      { kind: 'route', value: '/users', method: 'GET', status: '200' },
      { kind: 'route', value: '/users', method: 'POST', status: '201' },
    ]);
  });
});

describe('acceptance command extraction', () => {
  it('distinguishes product prose from an executable build check', () => {
    expect(analyzeAcceptanceEntry('Build a dashboard').anchors).toEqual([]);
    expect(analyzeAcceptanceEntry('The Next.js build succeeds.').anchors)
      .toContainEqual({ kind: 'command', value: 'build' });
  });

  it('does not interpret a lowercase prose verb as an HTTP method', () => {
    expect(analyzeAcceptanceEntry('Users get /reports after login').anchors)
      .not.toContainEqual({ kind: 'http_verb', value: 'GET' });
    expect(
      analyzeAcceptanceEntry('Users get /reports after login').anchors
        .filter((anchor) => anchor.kind === 'route'),
    ).toEqual([
      { kind: 'route', value: '/reports', method: undefined, status: undefined },
    ]);
  });

  it('preserves a targeted test command instead of reducing it to test', () => {
    expect(
      analyzeAcceptanceEntry('Run npm test -- critical.test.ts').anchors,
    ).toContainEqual({
      kind: 'command',
      value: 'npm test -- critical.test.ts',
    });
  });
});

describe('acceptance route templates', () => {
  it('matches Next.js catch-all route segments', () => {
    expect(routeTemplateMatches(
      '/docs/[...slug]',
      '/docs/guides/getting-started',
    )).toBe(true);
    expect(routeTemplateMatches('/docs/[...slug]', '/docs')).toBe(false);
    expect(routeTemplateMatches('/docs/[[...slug]]', '/docs')).toBe(true);
  });

  it('rejects traversal and non-terminal catch-all segments', () => {
    expect(analyzeAcceptanceRoutePath('/docs/../admin').valid).toBe(false);
    expect(analyzeAcceptanceRoutePath('/docs/[...slug]/edit').valid)
      .toBe(false);
    expect(routeTemplateMatches(
      '/docs/[...slug]/edit',
      '/docs/guide/edit',
    )).toBe(false);
  });
});
