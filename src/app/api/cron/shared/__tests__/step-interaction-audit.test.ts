import {
  auditInteractionSource,
  collectActionClassNames,
  parseAddedLines,
  parseChangedTargets,
  routeFromAppFile,
  routePattern,
  type InteractionSignal,
} from '../step-interaction-audit';
import { applyInteractionBacklogPolicy } from '../step-interaction-backlog';

const mockGetBacklogItem = jest.fn();
const mockListBacklog = jest.fn();
const mockLogAssumption = jest.fn();
const mockUpsertBacklogItem = jest.fn();
const mockIsItemTerminal = jest.fn();

jest.mock('@/lib/services/requirement-backlog', () => ({
  getBacklogItem: mockGetBacklogItem,
  isItemTerminal: mockIsItemTerminal,
  listBacklog: mockListBacklog,
  logAssumption: mockLogAssumption,
  upsertBacklogItem: mockUpsertBacklogItem,
}));

const file = 'src/components/Header.tsx';
const allLinesAdded = new Map<string, Set<number> | '*'>([[file, '*']]);
const routes = [/^\/$/, /^\/dashboard$/, /^\/users\/[^/]+$/];

function audit(content: string, addedLines = allLinesAdded) {
  return auditInteractionSource({
    file,
    content,
    routePatterns: routes,
    publicFiles: new Set(['/logo.svg']),
    addedLines,
  });
}

describe('interaction audit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsItemTerminal.mockReturnValue(false);
  });

  it('reports internal links whose page route does not exist', () => {
    const findings = audit(`export const Header = () => <Link href="/pricing">Pricing</Link>;`);

    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'broken_link',
        target: '/pricing',
        confidence: 'high',
        introduced_by_step: true,
        disposition: 'create_backlog',
      }),
    ]);
  });

  it('accepts known, dynamic, and public destinations', () => {
    const findings = audit(`
      export const Header = () => <>
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/users/42">User</Link>
        <img src="/logo.svg" />
      </>;
    `);

    expect(findings).toHaveLength(0);
  });

  it('normalizes route groups and matches dynamic app routes', () => {
    expect(routeFromAppFile('src/app/(account)/users/[id]/page.tsx')).toBe('/users/[id]');
    expect(routeFromAppFile('src/app/@modal/(.)photo/[id]/page.tsx')).toBe('/photo/[id]');
    expect(routeFromAppFile('src/app/_private/page.tsx')).toBeNull();
    expect(routeFromAppFile('src/app/api/export/route.ts')).toBe('/api/export');
    expect(routePattern('/users/[id]').test('/users/42')).toBe(true);
    expect(routePattern('/docs/[...slug]').test('/docs/guides/start')).toBe(true);
    expect(routePattern('/docs/[[...slug]]').test('/docs')).toBe(true);
    expect(routePattern('/dashboard').test('/dashboards')).toBe(false);
  });

  it('reports semantic controls with no action', () => {
    const findings = audit(`export const Hero = () => <button className="btn">Start</button>;`);

    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'inert_control',
        element: 'button',
        confidence: 'high',
        disposition: 'repair',
      }),
    ]);
  });

  it('reports placeholder links as inert controls', () => {
    const findings = audit(`export const Header = () => <a href="#">Plans</a>;`);

    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'inert_control',
        element: 'a',
        confidence: 'high',
        reason: 'Link uses an empty or placeholder destination',
      }),
    ]);
  });

  it('does not report form submissions or composed links', () => {
    const findings = audit(`
      export const Form = () => <>
        <form onSubmit={save}><button>Save</button></form>
        <Button asChild><Link href="/dashboard">Open</Link></Button>
      </>;
    `);

    expect(findings).toHaveLength(0);
  });

  it('accepts reset controls and controls nested in actionable parents', () => {
    const findings = audit(`
      export const Controls = () => <>
        <form><button type="reset">Reset</button></form>
        <a href="/dashboard"><span className="btn">Dashboard</span></a>
      </>;
    `);

    expect(findings).toHaveLength(0);
  });

  it('does not block compositional triggers or buttons receiving spread props', () => {
    const findings = audit(`
      export const Controls = (props) => <>
        <DialogTrigger><Button>Open</Button></DialogTrigger>
        <button {...props}>Configurable</button>
      </>;
    `);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      label: 'Configurable',
      confidence: 'medium',
      disposition: 'warning',
    }));
  });

  it('reports explicit button classes as high-confidence defects', () => {
    const findings = audit(`export const Card = () => <div className="btn cursor-pointer">Open</div>;`);

    expect(findings[0]).toEqual(expect.objectContaining({
      kind: 'inert_control',
      confidence: 'high',
      disposition: 'repair',
    }));
  });

  it('learns action-bearing classes and flags inert reuse with high confidence', () => {
    const learned = collectActionClassNames(
      'src/components/Actions.tsx',
      `export const Action = () => <div className="primary-control" onClick={open}>Open</div>;`,
    );
    const findings = auditInteractionSource({
      file,
      content: `export const Card = () => <div className="primary-control">Open</div>;`,
      routePatterns: routes,
      publicFiles: new Set(),
      addedLines: allLinesAdded,
      interactiveClassNames: learned,
    });

    expect(findings[0]).toEqual(expect.objectContaining({
      kind: 'inert_control',
      confidence: 'high',
      disposition: 'repair',
    }));
  });

  it('checks hard-coded href values stored in navigation configuration', () => {
    const findings = audit(`export const nav = [{ label: 'Plans', href: '/pricing' }];`);

    expect(findings[0]).toEqual(expect.objectContaining({
      kind: 'broken_link',
      element: 'href configuration',
      target: '/pricing',
      confidence: 'medium',
    }));
  });

  it('does not treat string replacement as router navigation', () => {
    const findings = audit(
      `export const slug = value.replace('/draft', '/pricing');`,
    );

    expect(findings).toHaveLength(0);
  });

  it('attributes a multiline JSX defect when an attribute line changed', () => {
    const content = [
      'export const Header = () => (',
      '  <Link',
      '    className="primary"',
      '    href="/pricing"',
      '  >Pricing</Link>',
      ');',
    ].join('\n');
    const findings = audit(
      content,
      new Map([[file, new Set([4])]]),
    );

    expect(findings[0]).toEqual(expect.objectContaining({
      target: '/pricing',
      introduced_by_step: true,
    }));
  });

  it('does not classify unchanged findings as introduced by the step', () => {
    const findings = audit(
      `export const Header = () => <a href="/missing">Missing</a>;`,
      new Map([[file, new Set([10])]]),
    );

    expect(findings[0].introduced_by_step).toBe(false);
  });

  it('parses added hunk lines and treats untracked files as entirely new', () => {
    const parsed = parseAddedLines(
      [
        'diff --git a/src/components/Header.tsx b/src/components/Header.tsx',
        '+++ b/src/components/Header.tsx',
        '@@ -3,0 +4,2 @@',
        '+one',
        '+two',
      ].join('\n'),
      ['src/components/New.tsx'],
    );

    expect(parsed.get('src/components/Header.tsx')).toEqual(new Set([4, 5]));
    expect(parsed.get('src/components/New.tsx')).toBe('*');
  });

  it('marks the deletion anchor so removed handlers remain attributable', () => {
    const parsed = parseAddedLines(
      [
        'diff --git a/src/components/Header.tsx b/src/components/Header.tsx',
        '+++ b/src/components/Header.tsx',
        '@@ -4,1 +4,0 @@',
        '-    onClick={open}',
      ].join('\n'),
      [],
    );

    expect(parsed.get('src/components/Header.tsx')).toEqual(new Set([4]));
  });

  it('attributes links broken by a deleted destination to the current step', () => {
    const changedTargets = parseChangedTargets([
      'diff --git a/src/app/pricing/page.tsx b/src/app/pricing/page.tsx',
      'deleted file mode 100644',
      '--- a/src/app/pricing/page.tsx',
      '+++ /dev/null',
    ].join('\n'));
    const findings = auditInteractionSource({
      file,
      content: `export const Header = () => <Link href="/pricing">Pricing</Link>;`,
      routePatterns: routes,
      publicFiles: new Set(),
      addedLines: new Map(),
      changedTargets,
    });

    expect(changedTargets).toContain('/pricing');
    expect(findings[0].introduced_by_step).toBe(true);
  });

  it('allows one repair cycle before creating and deferring a missing-page item', async () => {
    const finding = audit(`export const Header = () => <Link href="/pricing">Pricing</Link>;`)[0];
    const signal: InteractionSignal = {
      ok: false,
      findings: [finding],
      blocking_count: 1,
      deferred_count: 0,
      warning_count: 0,
      summary: '1 blocking',
    };
    mockListBacklog.mockResolvedValue({
      backlog: { current_phase_id: 'implementation', items: [] },
    });
    mockGetBacklogItem.mockResolvedValue({
      item: { id: 'current', assumptions: [] },
    });
    mockLogAssumption.mockResolvedValue({});

    const first = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal,
    });

    expect(first.ok).toBe(false);
    expect(mockLogAssumption).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'current',
      assumption: expect.stringMatching(/^\[interaction-audit:/),
    }));
    expect(mockUpsertBacklogItem).not.toHaveBeenCalled();

    const marker = mockLogAssumption.mock.calls[0][0].assumption;
    mockGetBacklogItem.mockResolvedValue({
      item: { id: 'current', assumptions: [marker] },
    });
    mockUpsertBacklogItem.mockResolvedValue({ id: 'new-page-item' });

    const second = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal,
    });

    expect(mockUpsertBacklogItem).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        title: 'Implement missing /pricing screen',
        kind: 'page',
        status: 'pending',
      }),
    }));
    expect(second).toEqual(expect.objectContaining({
      ok: true,
      blocking_count: 0,
      deferred_count: 1,
    }));
    expect(second.findings[0]).toEqual(expect.objectContaining({
      disposition: 'deferred',
      backlog_item_id: 'new-page-item',
    }));
  });

  it('does not consume the repair cycle twice for duplicate links to one route', async () => {
    const first = audit(`export const A = () => <Link href="/pricing">A</Link>;`)[0];
    const second = { ...first, file: 'src/components/Footer.tsx', line: 2 };
    mockListBacklog.mockResolvedValue({
      backlog: { current_phase_id: 'implementation', items: [] },
    });
    mockGetBacklogItem.mockResolvedValue({ item: { id: 'current', assumptions: [] } });
    mockLogAssumption.mockResolvedValue({});

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: {
        ok: false,
        findings: [first, second],
        blocking_count: 2,
        deferred_count: 0,
        warning_count: 0,
        summary: '2 blocking',
      },
    });

    expect(result.ok).toBe(false);
    expect(mockLogAssumption).toHaveBeenCalledTimes(1);
    expect(mockUpsertBacklogItem).not.toHaveBeenCalled();
  });

  it('does not defer to a terminal backlog item that used to own the route', async () => {
    const finding = audit(
      `export const Header = () => <Link href="/pricing">Pricing</Link>;`,
    )[0];
    mockIsItemTerminal.mockReturnValue(true);
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [{
          id: 'old-item',
          status: 'needs_review',
          touches: ['src/app/pricing/page.tsx'],
        }],
      },
    });
    mockGetBacklogItem.mockResolvedValue({
      item: {
        id: 'current',
        assumptions: [`[interaction-audit:${finding.fingerprint}]`],
      },
    });
    mockUpsertBacklogItem.mockResolvedValue({ id: 'replacement-item' });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: {
        ok: false,
        findings: [finding],
        blocking_count: 1,
        deferred_count: 0,
        warning_count: 0,
        summary: '1 blocking',
      },
    });

    expect(mockUpsertBacklogItem).toHaveBeenCalled();
    expect(result.findings[0].backlog_item_id).toBe('replacement-item');
  });

  it('keeps a missing route blocking when the current item owns that route', async () => {
    const finding = audit(
      `export const Header = () => <Link href="/pricing">Pricing</Link>;`,
    )[0];
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [{
          id: 'current',
          status: 'in_progress',
          touches: ['src/app/pricing/page.tsx'],
        }],
      },
    });
    mockGetBacklogItem.mockResolvedValue({
      item: {
        id: 'current',
        assumptions: [`[interaction-audit:${finding.fingerprint}]`],
      },
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: {
        ok: false,
        findings: [finding],
        blocking_count: 1,
        deferred_count: 0,
        warning_count: 0,
        summary: '1 blocking',
      },
    });

    expect(result.ok).toBe(false);
    expect(mockUpsertBacklogItem).not.toHaveBeenCalled();
    expect(result.findings[0].disposition).toBe('create_backlog');
  });
});
