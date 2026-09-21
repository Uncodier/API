import { describe, expect, it, jest } from '@jest/globals';
import { computeFeatureCoverage } from '../feature-coverage';

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));

describe('feature coverage', () => {
  it('checks the HTTP method declared for each API route', async () => {
    const runCommand = jest.fn(async (input: { args?: string[] }) => {
      const command = input.args?.join(' ') || '';
      const output = command.includes('[ -e')
        ? command.includes('src/app/api/assets/route.ts')
          ? '__OK__\n'
          : '__MISS__\n'
        : 'export async function POST() { return new Response(null); }\n';
      return {
        exitCode: 0,
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
    const runCommand = jest.fn(async (input: { args?: string[] }) => {
      const command = input.args?.join(' ') || '';
      let output = '__MISS__\n';
      if (command.includes('[ -e')) {
        output = command.includes('src/app/api/users/route.ts') ||
          command.includes('src/app/api/orders/route.ts')
          ? '__OK__\n'
          : '__MISS__\n';
      } else if (command.includes('src/app/api/users/route.ts')) {
        output = 'export async function GET() { return Response.json([]); }\n';
      } else if (command.includes('src/app/api/orders/route.ts')) {
        output = 'export async function POST() { return Response.json({}); }\n';
      }
      return {
        exitCode: 0,
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
    const runCommand = jest.fn(async (input: { args?: string[] }) => {
      const command = input.args?.join(' ') || '';
      const output = command.includes('[ -e') &&
        command.includes('src/app/api/current/route.ts')
        ? '__OK__\n'
        : 'export async function GET() { return Response.json({}); }\n';
      return {
        exitCode: 0,
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

  it('resolves colon parameters to App Router dynamic segments', async () => {
    const runCommand = jest.fn(async (input: { args?: string[] }) => {
      const command = input.args?.join(' ') || '';
      const output = command.includes('[ -e')
        ? command.includes('src/app/api/assets/[id]/approve/route.ts')
          ? '__OK__\n'
          : '__MISS__\n'
        : 'export async function PATCH() { return new Response(null); }\n';
      return {
        exitCode: 0,
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
});
