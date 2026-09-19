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
});
