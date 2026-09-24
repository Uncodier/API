import { describe, expect, it } from '@jest/globals';
import { runJudge } from '../archetype-runner';
import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';

const criterion =
  'The site layout renders without broken internal links for the primary navigation and footer routes implemented in this cycle.';

function item(acceptance = criterion): BacklogItem {
  return {
    id: 'navigation',
    title: 'Consistent navigation',
    kind: 'polish',
    phase_id: 'build',
    status: 'in_progress',
    scope_level: 'full',
    acceptance: [acceptance],
    touches: ['src/app/layout.tsx'],
    attempts: 0,
    tier: 'core',
  };
}

function evidence(): EvidenceRecord {
  const targets = ['/', '/servicios', '/nosotros', '/contacto'];
  return {
    schema_version: 1,
    item_id: 'navigation',
    captured_at: '2026-09-21T18:45:25.277Z',
    critic_passes: 2,
    build: { command: 'npm run build', exit_code: 0, duration_ms: 1 },
    changed_files: ['src/app/layout.tsx'],
    observations: targets.map((target) => ({
      kind: 'page',
      disposition: 'pass' as const,
      source: 'contract',
      target,
      method: 'GET' as const,
      http_status: 200,
      detail: 'HTTP 200',
    })),
    feature_coverage: {
      ok: true,
      evaluable: true,
      declared_touches: ['src/app/layout.tsx'],
      present_touches: ['src/app/layout.tsx'],
      missing_touches: [],
      acceptance_route_anchors: targets,
      artifact_proofs: [{
        path: 'src/app/layout.tsx',
        exists: true,
        outcome: 'pass',
        bytes: 500,
        content_excerpt: '<header><nav>links</nav></header><footer>links</footer>',
      }],
    },
    interaction: {
      ok: true,
      evaluable: true,
      audited_files: ['src/app/layout.tsx'],
      links: [
        {
          file: 'src/app/layout.tsx',
          line: 3,
          element: 'Link',
          target: '/',
          region: 'header',
          route_exists: true,
        },
        {
          file: 'src/app/layout.tsx',
          line: 4,
          element: 'Link',
          target: '/servicios',
          region: 'header',
          route_exists: true,
        },
        {
          file: 'src/app/layout.tsx',
          line: 8,
          element: 'Link',
          target: '/nosotros',
          region: 'footer',
          route_exists: true,
        },
        {
          file: 'src/app/layout.tsx',
          line: 9,
          element: 'Link',
          target: '/contacto',
          region: 'footer',
          route_exists: true,
        },
      ],
      unresolved_links: [],
      findings: [],
    },
  };
}

describe('internal-link acceptance evidence', () => {
  it('approves complete navigation and footer link proof', () => {
    expect(runJudge({ item: item(), evidence: evidence(), flow: 'app' }))
      .toMatchObject({
        verdict: 'approved',
        unmatched_acceptance: [],
      });
  });

  it('does not use link integrity to approve unrelated compound obligations', () => {
    expect(runJudge({
      item: item(
        'Footer links resolve, icons render, and legal text uses the required styling.',
      ),
      evidence: evidence(),
      flow: 'app',
    })).toMatchObject({
      verdict: 'rejected',
      failure_kind: 'contract_error',
    });
  });

  it('accepts a header brand wrapped by a link to the dashboard', () => {
    const branded = evidence();
    branded.observations?.push({
      kind: 'page',
      disposition: 'pass',
      source: 'contract',
      target: '/dashboard',
      method: 'GET',
      http_status: 200,
      detail: 'HTTP 200',
    });
    branded.interaction!.links?.push({
      file: 'src/components/ui/header.tsx',
      line: 8,
      element: 'Link',
      target: '/dashboard',
      region: 'header',
      route_exists: true,
      content_excerpt: '<Logo /> <span>Visualgv</span>',
    });

    expect(runJudge({
      item: item(
        'The dashboard header logo or title wraps a Next.js Link that navigates to /dashboard.',
      ),
      evidence: branded,
      flow: 'app',
    })).toMatchObject({
      verdict: 'approved',
      unmatched_acceptance: [],
    });
  });

  it('keeps the criterion unproven when one route was not probed', () => {
    const incomplete = evidence();
    incomplete.observations = incomplete.observations?.filter(
      (observation) => observation.target !== '/contacto',
    );

    expect(runJudge({ item: item(), evidence: incomplete, flow: 'app' }))
      .toMatchObject({
        verdict: 'rejected',
        failure_kind: 'evidence_gap',
      });
  });

  it('classifies a confirmed broken navigation route as a product defect', () => {
    const broken = evidence();
    broken.observations = broken.observations?.map((observation) =>
      observation.target === '/contacto'
        ? {
            ...observation,
            disposition: 'hard_fail' as const,
            http_status: 404,
            detail: 'HTTP 404',
          }
        : observation,
    );

    expect(runJudge({ item: item(), evidence: broken, flow: 'app' }))
      .toMatchObject({
        verdict: 'rejected',
        failure_kind: 'product_defect',
      });
  });

  it('rejects an expected route that is absent from the link inventory', () => {
    const missingLink = evidence();
    missingLink.interaction!.links = missingLink.interaction!.links?.filter(
      (link) => link.target !== '/contacto',
    );

    expect(runJudge({
      item: item(
        'Navigation and footer links to "/", /servicios, /nosotros, and /contacto resolve.',
      ),
      evidence: missingLink,
      flow: 'app',
    }))
      .toMatchObject({
        verdict: 'rejected',
        failure_kind: 'product_defect',
      });
  });

  it('accepts mapped navigation when static configuration proves all targets', () => {
    const mapped = evidence();
    mapped.interaction!.links = (
      mapped.interaction!.links || []
    ).map((link) => ({
      ...link,
      region: 'other' as const,
      source_binding: 'src/config/navigation.ts#navigation:href',
    }));
    mapped.interaction!.unresolved_links = [
      {
        file: 'src/app/layout.tsx',
        line: 3,
        element: 'Link',
        region: 'header',
        source_binding: 'src/config/navigation.ts#navigation:href',
      },
      {
        file: 'src/app/layout.tsx',
        line: 8,
        element: 'Link',
        region: 'footer',
        source_binding: 'src/config/navigation.ts#navigation:href',
      },
    ];

    expect(runJudge({ item: item(), evidence: mapped, flow: 'app' }))
      .toMatchObject({
        verdict: 'approved',
        unmatched_acceptance: [],
      });
  });

  it('does not use unrelated link configuration for mapped navigation', () => {
    const unrelated = evidence();
    unrelated.interaction!.links = (
      unrelated.interaction!.links || []
    ).map((link) => ({
      ...link,
      region: 'other' as const,
      source_binding: 'src/config/unused.ts#unusedLinks:href',
    }));
    unrelated.interaction!.unresolved_links = [{
      file: 'src/app/layout.tsx',
      line: 3,
      element: 'Link',
      region: 'header',
      source_binding: 'src/config/navigation.ts#navigation:href',
    }, {
      file: 'src/app/layout.tsx',
      line: 8,
      element: 'Link',
      region: 'footer',
      source_binding: 'src/config/navigation.ts#navigation:href',
    }];

    expect(runJudge({ item: item(), evidence: unrelated, flow: 'app' }))
      .toMatchObject({
        verdict: 'rejected',
        failure_kind: 'evidence_gap',
      });
  });

  it('requires link evidence for localized navigation criteria', () => {
    const localized =
      'La navegación principal y footer tienen enlaces hacia /, /servicios, /nosotros y /contacto.';
    const routeOnly = evidence();
    routeOnly.interaction = {
      ok: true,
      evaluable: true,
      audited_files: ['src/app/layout.tsx'],
      links: [],
      unresolved_links: [],
      findings: [],
    };

    expect(runJudge({
      item: item(localized),
      evidence: routeOnly,
      flow: 'app',
    })).toMatchObject({
      verdict: 'rejected',
      failure_kind: 'evidence_gap',
    });
  });

  it('does not accept an empty or incomplete interaction audit', () => {
    const empty = evidence();
    empty.interaction = {
      ok: true,
      evaluable: true,
      audited_files: ['src/app/layout.tsx'],
      links: [],
      unresolved_links: [],
      findings: [],
    };

    expect(runJudge({ item: item(), evidence: empty, flow: 'app' }))
      .toMatchObject({
        verdict: 'rejected',
        failure_kind: 'evidence_gap',
      });
  });

  it('scopes a generic navigation criterion to navigation links only', () => {
    const scoped = evidence();
    scoped.observations = scoped.observations?.map((observation) =>
      observation.target === '/contacto'
        ? {
            ...observation,
            disposition: 'hard_fail' as const,
            http_status: 404,
            detail: 'HTTP 404',
          }
        : observation,
    );
    scoped.interaction!.links = scoped.interaction!.links?.map((link) =>
      link.target === '/contacto'
        ? { ...link, route_exists: false }
        : link,
    );

    expect(runJudge({
      item: item(
        'Primary navigation internal links resolve without broken links.',
      ),
      evidence: scoped,
      flow: 'app',
    })).toMatchObject({
      verdict: 'approved',
      unmatched_acceptance: [],
    });
  });

  it('rejects a broken link inside a generic navigation criterion', () => {
    const brokenNavigation = evidence();
    brokenNavigation.interaction!.links =
      brokenNavigation.interaction!.links?.map((link) =>
        link.target === '/servicios'
          ? { ...link, route_exists: false }
          : link,
      );

    expect(runJudge({
      item: item(
        'Primary navigation internal links resolve without broken links.',
      ),
      evidence: brokenNavigation,
      flow: 'app',
    })).toMatchObject({
      verdict: 'rejected',
      failure_kind: 'product_defect',
    });
  });
});
