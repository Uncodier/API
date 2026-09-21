import {
  resolveLinkImportBindings,
  runInteractionAudit,
} from '../step-interaction-runner';

describe('interaction audit sandbox runner', () => {
  it('source-qualifies aliased navigation imports', () => {
    expect(resolveLinkImportBindings(
      'src/components/Nav.tsx',
      "import { navigation as links } from '@/config/navigation';",
      new Set([
        'src/components/Nav.tsx',
        'src/config/navigation.ts',
      ]),
    )).toEqual({
      links: 'src/config/navigation.ts#navigation',
    });
  });

  it('uses the persisted baseline and reports only changed interaction lines', async () => {
    const sha = 'a'.repeat(40);
    const stdout = [
      'src/app/page.tsx',
      'src/components/Header.tsx',
      '',
      '__UNTRACKED__',
      '',
      '__DIFF__',
      'diff --git a/src/components/Header.tsx b/src/components/Header.tsx',
      '+++ b/src/components/Header.tsx',
      '@@ -1,0 +1,1 @@',
      '+export const Header = () => <a href="/pricing">Pricing</a>;',
    ].join('\n');
    const sandbox = {
      runCommand: jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: jest.fn().mockResolvedValue(stdout),
      }),
      fs: {
        readFile: jest.fn(async (path: string) =>
          path.endsWith('src/app/page.tsx')
            ? 'export default function Home() { return <main />; }'
            : 'export const Header = () => <a href="/pricing">Pricing</a>;',
        ),
      },
    };

    const result = await runInteractionAudit(sandbox as any, { baselineSha: sha });

    expect(sandbox.runCommand.mock.calls[0][1][1]).toContain(`"${sha}"..HEAD`);
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toEqual(expect.objectContaining({
      target: '/pricing',
      introduced_by_step: true,
    }));
    expect(result.evaluable).toBe(true);
    expect(result.audited_files).toEqual([
      'src/app/page.tsx',
      'src/components/Header.tsx',
    ]);
    expect(result.links).toEqual([
      expect.objectContaining({
        file: 'src/components/Header.tsx',
        target: '/pricing',
        route_exists: false,
      }),
    ]);
  });
});
