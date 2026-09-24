import { describe, expect, it, jest } from '@jest/globals';
import { computeFeatureCoverage } from '../feature-coverage';
import {
  findPageFile,
  readArtifactProof,
} from '../feature-coverage-probes';

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));

describe('feature coverage', () => {
  it('checks the HTTP method declared for each API route', async () => {
    const runCommand = jest.fn(async (input: {
      cmd?: string;
      args?: string[];
    }) => {
      const command = input.args?.join(' ') || '';
      const exists =
        input.cmd === 'stat' &&
        command.includes('src/app/api/assets/route.ts');
      const output = input.cmd === 'cat'
        ? 'export async function POST() { return new Response(null); }\n'
        : '128\n';
      return {
        exitCode: input.cmd === 'stat' && !exists ? 1 : 0,
        stdout: jest.fn(async () => Buffer.from(output)),
      };
    });

    const coverage = await computeFeatureCoverage({
      sandbox: { runCommand } as any,
      item: {
        id: 'api-1',
        title: 'Create an asset',
        kind: 'api',
        phase_id: 'build',
        status: 'in_progress',
        scope_level: 'full',
        attempts: 0,
        tier: 'core',
        acceptance: ['POST /api/assets returns 201'],
      },
    });

    expect(coverage.kind_requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requirement: 'POST /api/assets exports_POST',
        satisfied: true,
      }),
    ]));
    expect(coverage.kind_requirements).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ requirement: expect.stringContaining('GET') }),
    ]));
  });

  it('does not assign every method to every route in a grouped criterion', async () => {
    const runCommand = jest.fn(async (input: {
      cmd?: string;
      args?: string[];
    }) => {
      const command = input.args?.join(' ') || '';
      const exists =
        command.includes('src/app/api/users/route.ts') ||
        command.includes('src/app/api/orders/route.ts');
      let output = '128\n';
      if (input.cmd === 'cat' && command.includes('src/app/api/users/route.ts')) {
        output = 'export async function GET() { return Response.json([]); }\n';
      } else if (
        input.cmd === 'cat' &&
        command.includes('src/app/api/orders/route.ts')
      ) {
        output = 'export async function POST() { return Response.json({}); }\n';
      }
      return {
        exitCode: input.cmd === 'stat' && !exists ? 1 : 0,
        stdout: jest.fn(async () => Buffer.from(output)),
      };
    });

    const coverage = await computeFeatureCoverage({
      sandbox: { runCommand } as any,
      item: {
        id: 'api-grouped',
        title: 'List users and create orders',
        kind: 'api',
        phase_id: 'build',
        status: 'in_progress',
        scope_level: 'full',
        attempts: 0,
        tier: 'core',
        acceptance: [
          'GET /api/users and POST /api/orders return 200 and 201 respectively.',
        ],
      },
    });

    expect(coverage.kind_requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requirement: 'GET /api/users exports_GET',
        satisfied: true,
      }),
      expect.objectContaining({
        requirement: 'POST /api/orders exports_POST',
        satisfied: true,
      }),
    ]));
    expect(coverage.kind_requirements).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ requirement: 'POST /api/users exports_POST' }),
      expect.objectContaining({ requirement: 'GET /api/orders exports_GET' }),
    ]));
  });

  it('does not enforce item-wide touches during a step-scoped adjudication', async () => {
    const runCommand = jest.fn(async (input: {
      cmd?: string;
      args?: string[];
    }) => {
      const command = input.args?.join(' ') || '';
      const exists = command.includes('src/app/api/current/route.ts');
      const output = input.cmd === 'cat'
        ? 'export async function GET() { return Response.json({}); }\n'
        : '128\n';
      return {
        exitCode: input.cmd === 'stat' && !exists ? 1 : 0,
        stdout: jest.fn(async () => Buffer.from(output)),
      };
    });

    const coverage = await computeFeatureCoverage({
      sandbox: { runCommand } as any,
      contractScoped: true,
      item: {
        id: 'multi-step-api',
        title: 'Multi-step API',
        kind: 'crud',
        phase_id: 'build',
        status: 'in_progress',
        scope_level: 'full',
        attempts: 0,
        tier: 'core',
        acceptance: ['GET /api/current returns 200'],
        touches: ['src/app/api/future/route.ts'],
      },
    });

    expect(coverage.expected_api_routes).toEqual(['/api/current']);
    expect(coverage.declared_touches).toEqual([]);
    expect(coverage.kind_requirements).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  it('captures a non-empty artifact proof and normalizes legacy app paths', async () => {
    const runCommand = jest.fn(async (input: {
      cmd?: string;
      args?: string[];
    }) => {
      const output =
        input.cmd === 'stat'
          ? '128\n'
          : input.cmd === 'head'
            ? 'export default function Page() { return <main />; }\n'
            : '__MISS__\n';
      return {
        exitCode: input.cmd === 'stat' || input.cmd === 'head' ? 0 : 1,
        stdout: jest.fn(async () => Buffer.from(output)),
      };
    });

    const coverage = await computeFeatureCoverage({
      sandbox: { runCommand } as any,
      item: {
        id: 'doc-1',
        title: 'Document the page',
        kind: 'doc',
        phase_id: 'report',
        status: 'in_progress',
        scope_level: 'full',
        attempts: 0,
        tier: 'ornamental',
        acceptance: ['Creates app/page.tsx'],
        touches: ['/app/page.tsx'],
      },
    });

    expect(coverage.present_touches).toEqual(['src/app/page.tsx']);
    expect(coverage.artifact_proofs).toEqual([
      expect.objectContaining({
        path: 'src/app/page.tsx',
        exists: true,
        bytes: 128,
      }),
    ]);
  });

  it('uses acceptance file anchors as artifact evidence without duplicate probes', async () => {
    const runCommand = jest.fn(async (input: { cmd?: string }) => ({
      exitCode: 0,
      stdout: jest.fn(async () => Buffer.from(
        input.cmd === 'stat'
          ? '256\n'
          : '# Technical design\n\nArchitecture details.\n',
      )),
    }));

    const coverage = await computeFeatureCoverage({
      sandbox: { runCommand } as any,
      item: {
        id: 'doc-acceptance-anchor',
        title: 'Write technical design',
        kind: 'doc',
        phase_id: 'report',
        status: 'in_progress',
        scope_level: 'full',
        attempts: 0,
        tier: 'core',
        acceptance: [
          'Creates docs/architecture/technical_design.md with the system design.',
        ],
      },
    });

    expect(coverage.declared_touches).toEqual([
      'docs/architecture/technical_design.md',
    ]);
    expect(coverage.artifact_proofs).toHaveLength(1);
    expect(coverage.present_touches).toEqual([
      'docs/architecture/technical_design.md',
    ]);
  });

  it('supports safe recursive and non-recursive touch globs', async () => {
    const runCommand = jest.fn(async (input: { cmd?: string; args?: string[] }) => ({
      exitCode: input.cmd === 'find' ? 0 : 1,
      stdout: jest.fn(async () => Buffer.from([
        '/vercel/sandbox/supabase/migrations/001_core.sql',
        '/vercel/sandbox/src/app/api/assets/route.ts',
        '/vercel/sandbox/src/app/api/assets/upload/route.ts',
      ].join('\n'))),
    }));

    const coverage = await computeFeatureCoverage({
      sandbox: { runCommand } as any,
      item: {
        id: 'glob-touches',
        title: 'Validate repository files',
        kind: 'content',
        phase_id: 'build',
        status: 'in_progress',
        scope_level: 'full',
        attempts: 0,
        tier: 'core',
        acceptance: ['Updates the required repository files.'],
        touches: [
          'supabase/migrations/*',
          'src/app/api/**/*.ts',
        ],
      },
    });

    expect(coverage.missing_touches).toEqual([]);
    expect(coverage.present_touches).toEqual([
      'supabase/migrations/*',
      'src/app/api/**/*.ts',
    ]);
    expect(coverage.artifact_proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'supabase/migrations/*',
        exists: true,
      }),
      expect.objectContaining({
        path: 'src/app/api/**/*.ts',
        exists: true,
      }),
    ]));
    const findCalls = runCommand.mock.calls
      .map(([input]) => input)
      .filter((input) => input.cmd === 'find');
    expect(findCalls.map((input) => input.args?.[0])).toEqual([
      '/vercel/sandbox/supabase/migrations',
      '/vercel/sandbox/src/app/api',
    ]);
    for (const input of findCalls) {
      expect(input.args).toEqual(expect.arrayContaining([
        'node_modules',
        '.next',
        '.git',
        '-prune',
      ]));
    }
  });

  it.each([
    {
      kind: 'page' as const,
      acceptance: ['Renders the mobile-first camera upload view.'],
    },
    {
      kind: 'api' as const,
      acceptance: ['Stores uploaded assets using the configured provider.'],
    },
  ])('does not invent a missing structural target for an underspecified $kind contract', async ({
    kind,
    acceptance,
  }) => {
    const runCommand = jest.fn();
    const coverage = await computeFeatureCoverage({
      sandbox: { runCommand } as any,
      item: {
        id: `underspecified-${kind}`,
        title: 'Under-specified contract',
        kind,
        phase_id: 'build',
        status: 'in_progress',
        scope_level: 'full',
        attempts: 0,
        tier: 'core',
        acceptance,
      },
    });

    expect(coverage.kind_requirements).toEqual([
      expect.objectContaining({
        satisfied: false,
        outcome: 'not_evaluable',
      }),
    ]);
    expect(coverage.evaluable).toBe(false);
    expect(coverage.ok).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'page' as const,
      changedFile: 'src/app/camera/page.tsx',
      requirement: 'at_least_one_page_file',
    },
    {
      kind: 'api' as const,
      changedFile: 'src/app/api/assets/upload/route.ts',
      requirement: 'at_least_one_route_file',
    },
  ])('uses a concrete changed artifact for an underspecified $kind contract', async ({
    kind,
    changedFile,
    requirement,
  }) => {
    const runCommand = jest.fn(async (input: { cmd?: string }) => ({
      exitCode: 0,
      stdout: jest.fn(async () => Buffer.from(
        input.cmd === 'stat' ? '128\n' : 'export default function Handler() {}',
      )),
    }));
    const coverage = await computeFeatureCoverage({
      sandbox: { runCommand } as any,
      changedFiles: [changedFile],
      item: {
        id: `changed-${kind}`,
        title: 'Under-specified contract with changed artifact',
        kind,
        phase_id: 'build',
        status: 'in_progress',
        scope_level: 'full',
        attempts: 0,
        tier: 'core',
        acceptance: ['Implements the requested behavior.'],
      },
    });

    expect(coverage.kind_requirements).toEqual([
      expect.objectContaining({
        requirement,
        satisfied: true,
        outcome: 'pass',
        detail: changedFile,
      }),
    ]);
    expect(coverage.evaluable).toBe(true);
    expect(coverage.ok).toBe(true);
  });

  it('resolves colon parameters to App Router dynamic segments', async () => {
    const runCommand = jest.fn(async (input: {
      cmd?: string;
      args?: string[];
    }) => {
      const command = input.args?.join(' ') || '';
      const exists =
        command.includes('src/app/api/assets/[id]/approve/route.ts');
      const output = input.cmd === 'cat'
        ? 'export async function PATCH() { return new Response(null); }\n'
        : '128\n';
      return {
        exitCode: input.cmd === 'stat' && !exists ? 1 : 0,
        stdout: jest.fn(async () => Buffer.from(output)),
      };
    });

    const coverage = await computeFeatureCoverage({
      sandbox: { runCommand } as any,
      item: {
        id: 'api-dynamic',
        title: 'Approve asset',
        kind: 'api',
        phase_id: 'build',
        status: 'in_progress',
        scope_level: 'full',
        attempts: 0,
        tier: 'core',
        acceptance: [
          'PATCH /api/assets/:id/approve returns 200 and updates status.',
        ],
      },
    });

    expect(coverage.expected_api_routes).toEqual([
      '/api/assets/:id/approve',
    ]);
    expect(coverage.present_api_files).toEqual([
      'src/app/api/assets/[id]/approve/route.ts',
    ]);
    expect(coverage.kind_requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requirement: 'PATCH /api/assets/:id/approve exports_PATCH',
        satisfied: true,
      }),
    ]));
  });

  it('keeps probe transport failures distinct from confirmed missing files', async () => {
    const coverage = await computeFeatureCoverage({
      sandbox: {
        runCommand: jest.fn().mockRejectedValue(
          new Error('sandbox transport unavailable'),
        ),
      } as any,
      item: {
        id: 'page-unknown',
        title: 'Dashboard',
        kind: 'page',
        phase_id: 'build',
        status: 'in_progress',
        scope_level: 'full',
        attempts: 0,
        tier: 'core',
        acceptance: ['GET /dashboard returns 200'],
      },
    });

    expect(coverage.evaluable).toBe(false);
    expect(coverage.missing_touches).toEqual([]);
    expect(coverage.not_evaluable_page_routes).toEqual(['/dashboard']);
    expect(coverage.kind_requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requirement: 'at_least_one_page_file',
        outcome: 'not_evaluable',
      }),
    ]));
  });

  it('rejects artifact traversal without reading outside the workspace', async () => {
    const runCommand = jest.fn();
    const proof = await readArtifactProof(
      { runCommand } as any,
      '../../etc/passwd',
    );

    expect(proof).toEqual(expect.objectContaining({
      exists: false,
      outcome: 'not_evaluable',
      error: expect.stringContaining('parent'),
    }));
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('never sends route-derived paths through a shell', async () => {
    const runCommand = jest.fn(async (_input: {
      cmd?: string;
      args?: string[];
    }) => ({
      exitCode: 1,
      stdout: jest.fn(async () => Buffer.from('')),
    }));

    await findPageFile(
      { runCommand } as any,
      '/reports/$(touch${IFS}/tmp/pwned)',
    );

    expect(runCommand).toHaveBeenCalled();
    expect(runCommand.mock.calls.every(([input]) => input.cmd === 'stat'))
      .toBe(true);
    expect(runCommand.mock.calls[0][0].args).toContain(
      '/vercel/sandbox/src/app/reports/$(touch${IFS}/tmp/pwned)/page.tsx',
    );
  });
});
