import {
  buildHarnessTrackingScriptTag,
  buildLegacyTrackingScriptTag,
  HARNESS_TRACKING_ATTRIBUTE,
  rollbackHarnessTrackingScript,
  transformHarnessTrackingScript,
} from '../tracking-script-contract';
import ts from 'typescript';

describe('tracking script contract', () => {
  it('marks new harness injections while retaining the exact legacy signature', () => {
    const current = buildHarnessTrackingScriptTag('site-1');
    const legacy = buildLegacyTrackingScriptTag('site-1');

    expect(current).toContain(HARNESS_TRACKING_ATTRIBUTE);
    expect(current).toContain('data-site-id="site-1"');
    expect(legacy).not.toContain(HARNESS_TRACKING_ATTRIBUTE);
  });

  it('injects valid quoted JSX without shell interpolation', () => {
    const source = [
      'export default function Layout({ children }) {',
      '  return (',
      '    <html>',
      '      <body>{children}</body>',
      '    </html>',
      '  );',
      '}',
    ].join('\n');

    const result = transformHarnessTrackingScript(source, 'site-1');

    expect(result.reason).toBe('inserted');
    expect(result.source).toContain(
      '<script src="https://files.uncodie.com/tracking.min.js" data-site-id="site-1" data-uncodie-harness="tracking"></script>',
    );
    expect(result.source).not.toContain('src=https://');
    const parsed = ts.createSourceFile(
      'layout.tsx',
      result.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    expect((parsed as any).parseDiagnostics).toEqual([]);
  });

  it('ignores closing-body text inside strings and comments', () => {
    const source = [
      'const fake = "</body>"; // </body>',
      'export default function Layout() {',
      '  return <html><body>Content</body></html>;',
      '}',
    ].join('\n');

    const result = transformHarnessTrackingScript(source, 'site-1');

    expect(result.source.indexOf('tracking.min.js')).toBeGreaterThan(
      result.source.indexOf('Content'),
    );
    expect(result.source.indexOf('tracking.min.js')).toBeLessThan(
      result.source.lastIndexOf('</body>'),
    );
  });

  it('does not treat a tracking URL in a comment as an existing script', () => {
    const source = [
      '// https://files.uncodie.com/tracking.min.js',
      'export default function Layout() {',
      '  return <html><body>Content</body></html>;',
      '}',
    ].join('\n');

    expect(transformHarnessTrackingScript(source, 'site-1').reason).toBe(
      'inserted',
    );
  });

  it('does not treat a custom Body component as the HTML body element', () => {
    const source = [
      'function Body({ children }) { return <section>{children}</section>; }',
      'export default function Layout() {',
      '  return <html><Body>Content</Body></html>;',
      '}',
    ].join('\n');

    expect(() => transformHarnessTrackingScript(source, 'site-1')).toThrow(
      'Root layout has no JSX <body> element',
    );
  });

  it('repairs the malformed tag produced by the legacy sed command', () => {
    const source = [
      '<html>',
      '  <body>content',
      '    <script src=https://files.uncodie.com/tracking.min.js data-site-id=site-1 data-uncodie-harness=tracking></script>',
      '  </body>',
      '</html>',
    ].join('\n');

    const result = transformHarnessTrackingScript(source, 'site-1');

    expect(result.reason).toBe('repaired');
    expect(result.source).toContain('src="https://files.uncodie.com/tracking.min.js"');
    expect(result.source).not.toContain('src=https://');
  });

  it('removes a repaired harness tag instead of restoring malformed JSX', () => {
    const originalSource =
      '<html><body><script src=https://files.uncodie.com/tracking.min.js data-site-id=site-1></script></body></html>';
    const transformed = transformHarnessTrackingScript(
      originalSource,
      'site-1',
    );

    const rolledBack = rollbackHarnessTrackingScript(transformed.source, {
      path: '/vercel/sandbox/src/app/layout.tsx',
      originalSource,
      transformedSource: transformed.source,
      reason: transformed.reason,
      siteId: 'site-1',
    });

    expect(rolledBack).not.toContain('tracking.min.js');
    expect(rolledBack).not.toContain('src=https://');
  });

  it('does not claim an unmarked product-authored script', () => {
    const source =
      '<html><body><script src="https://files.uncodie.com/tracking.min.js" async></script></body></html>';

    expect(transformHarnessTrackingScript(source, 'site-1')).toEqual({
      changed: false,
      source,
      reason: 'unowned_existing',
    });
  });

  it('rolls back only the harness tag when the agent edited the layout later', () => {
    const originalSource =
      '<html><body><main>Original</main></body></html>';
    const transformed = transformHarnessTrackingScript(
      originalSource,
      'site-1',
    );
    const editedAfterInjection = transformed.source.replace(
      'Original',
      'Agent edit',
    );

    const rolledBack = rollbackHarnessTrackingScript(editedAfterInjection, {
      path: '/vercel/sandbox/src/app/layout.tsx',
      originalSource,
      transformedSource: transformed.source,
      reason: transformed.reason,
      siteId: 'site-1',
    });

    expect(rolledBack).toContain('Agent edit');
    expect(rolledBack).not.toContain('tracking.min.js');
  });

  it('recognizes and removes a formatter-expanded harness tag', () => {
    const originalSource = '<html><body>Content</body></html>';
    const transformed = transformHarnessTrackingScript(
      originalSource,
      'site-1',
    );
    const formatted = transformed.source.replace(
      buildHarnessTrackingScriptTag('site-1'),
      [
        '<script',
        '  src="https://files.uncodie.com/tracking.min.js"',
        '  data-site-id="site-1"',
        '  data-uncodie-harness="tracking"',
        '></script>',
      ].join('\n'),
    );

    const rolledBack = rollbackHarnessTrackingScript(formatted, {
      path: '/vercel/sandbox/src/app/layout.tsx',
      originalSource,
      transformedSource: transformed.source,
      reason: transformed.reason,
      siteId: 'site-1',
    });

    expect(rolledBack).toContain('Content');
    expect(rolledBack).not.toContain('tracking.min.js');
  });

  it('recognizes an already-marked formatter-expanded harness tag', () => {
    const source = [
      '<html><body>Content',
      '<script',
      '  src="https://files.uncodie.com/tracking.min.js"',
      '  data-site-id="site-1"',
      '  data-uncodie-harness="tracking"',
      '></script>',
      '</body></html>',
    ].join('\n');

    expect(transformHarnessTrackingScript(source, 'site-1').reason).toBe(
      'already_marked',
    );
  });
});
