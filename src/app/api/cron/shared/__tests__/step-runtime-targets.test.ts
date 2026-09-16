import { inferTargetRoutesFromDiff } from '../step-runtime-targets';
import { inferAffectedPageFilesFromContents } from '../step-visual-route-dependencies';

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));

function commandResult(output: string) {
  return {
    exitCode: 0,
    stdout: jest.fn().mockResolvedValue(output),
    stderr: jest.fn().mockResolvedValue(''),
  };
}

describe('runtime target inference', () => {
  it('walks reverse imports from a changed component to its page', () => {
    const contents = new Map([
      [
        'src/app/dashboard/page.tsx',
        "import { Panel } from '@/components/dashboard/panel';",
      ],
      [
        'src/components/dashboard/panel.tsx',
        "import { Value } from './value';",
      ],
      [
        'src/components/dashboard/value.tsx',
        'export function Value() { return <strong>42</strong>; }',
      ],
    ]);

    expect(
      inferAffectedPageFilesFromContents(
        ['src/components/dashboard/value.tsx'],
        contents,
      ),
    ).toEqual(['src/app/dashboard/page.tsx']);
  });

  it('maps components imported by a layout to descendant pages', () => {
    const contents = new Map([
      [
        'src/app/dashboard/layout.tsx',
        "import { Shell } from '@/components/shell';",
      ],
      [
        'src/app/dashboard/settings/page.tsx',
        'export default function Page() { return <main>Settings</main>; }',
      ],
      [
        'src/components/shell.tsx',
        'export function Shell() { return <nav />; }',
      ],
    ]);

    expect(
      inferAffectedPageFilesFromContents(
        ['src/components/shell.tsx'],
        contents,
      ),
    ).toEqual(['src/app/dashboard/settings/page.tsx']);
  });

  it('maps a directly changed layout to all descendant pages', () => {
    const contents = new Map([
      ['src/app/dashboard/layout.tsx', 'export default function Layout() {}'],
      ['src/app/dashboard/page.tsx', 'export default function Page() {}'],
      [
        'src/app/dashboard/settings/page.tsx',
        'export default function Settings() {}',
      ],
      ['src/app/other/page.tsx', 'export default function Other() {}'],
    ]);

    expect(
      inferAffectedPageFilesFromContents(
        ['src/app/dashboard/layout.tsx'],
        contents,
      ),
    ).toEqual([
      'src/app/dashboard/page.tsx',
      'src/app/dashboard/settings/page.tsx',
    ]);
  });

  it('walks imports from changed hooks under src/hooks', () => {
    const contents = new Map([
      [
        'src/app/dashboard/page.tsx',
        "import { useDashboard } from '@/hooks/use-dashboard';",
      ],
      ['src/hooks/use-dashboard.ts', 'export const useDashboard = () => null;'],
    ]);

    expect(
      inferAffectedPageFilesFromContents(
        ['src/hooks/use-dashboard.ts'],
        contents,
      ),
    ).toEqual(['src/app/dashboard/page.tsx']);
  });

  it('uses the step baseline and follows component imports to affected pages', async () => {
    const baseline = 'a'.repeat(40);
    const files = [
      'src/app/dashboard/page.tsx',
      'src/components/dashboard/panel.tsx',
      'src/components/dashboard/value.tsx',
    ];
    const contents: Record<string, string> = {
      'src/app/dashboard/page.tsx':
        "import { Panel } from '@/components/dashboard/panel'; export default function Page() { return <Panel />; }",
      'src/components/dashboard/panel.tsx':
        "import { Value } from './value'; export function Panel() { return <Value />; }",
      'src/components/dashboard/value.tsx':
        'export function Value() { return <strong>42</strong>; }',
    };
    const sandbox = {
      runCommand: jest.fn().mockImplementation((command: string, args: string[]) => {
        const script = args.join(' ');
        if (command === 'git') return commandResult(files.join('\n'));
        if (script.includes('BASELINE=')) {
          expect(script).toContain(baseline);
          return commandResult('src/components/dashboard/value.tsx\n');
        }
        return commandResult('src/components/dashboard/value.tsx\n');
      }),
      fs: {
        readFile: jest.fn().mockImplementation((absolutePath: string) => {
          const relative = absolutePath.replace('/vercel/sandbox/', '');
          return Promise.resolve(contents[relative]);
        }),
      },
    } as any;

    const result = await inferTargetRoutesFromDiff(sandbox, {
      baselineSha: baseline,
    });

    expect(result.recentChangedFiles).toEqual([
      'src/components/dashboard/value.tsx',
    ]);
    expect(result.recentPageRoutes).toEqual(['/dashboard']);
  });
});
