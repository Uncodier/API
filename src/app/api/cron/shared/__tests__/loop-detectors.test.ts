import {
  buildToolActionKey,
  detectActionLoop,
  detectAdminLoop,
} from '../loop-detectors';
import { isAdminOnlyDiff } from '../archetype-evidence';

describe('action loop detector', () => {
  it('canonicalizes arguments and ignores reasoning noise', () => {
    expect(buildToolActionKey('sandbox_read_file', {
      thought_process: 'first thought',
      path: '/vercel/sandbox/src/app/layout.tsx',
    })).toBe(buildToolActionKey('sandbox_read_file', {
      path: '/vercel/sandbox/src/app/layout.tsx',
      thought_process: 'different thought',
    }));
  });

  it('identifies the exact repeated tool action', () => {
    const repeated = buildToolActionKey('sandbox_read_file', {
      path: '/vercel/sandbox/src/app/layout.tsx',
    });
    const verdict = detectActionLoop([
      { name: 'sandbox_read_file', command: repeated },
      { name: 'sandbox_read_file', command: repeated },
      { name: 'sandbox_read_file', command: repeated },
      {
        name: 'sandbox_read_file',
        command: buildToolActionKey('sandbox_read_file', {
          path: '/vercel/sandbox/src/app/page.tsx',
        }),
      },
    ]);

    expect(verdict).toMatchObject({
      triggered: true,
      kind: 'action',
      blockedAction: repeated,
    });
  });
});

describe('admin loop detector', () => {
  it('does not count test-only commits as product progress', () => {
    const verdict = detectAdminLoop([
      { files: ['src/components/__tests__/contact.test.tsx'] },
      { files: ['.qa/scenarios/contact.json', 'qa_results.json'] },
    ]);

    expect(verdict).toMatchObject({
      triggered: true,
      kind: 'admin',
    });
  });

  it('accepts an implementation change as product progress', () => {
    const verdict = detectAdminLoop([
      { files: ['src/components/__tests__/contact.test.tsx'] },
      { files: ['src/components/contact-form.tsx'] },
    ]);

    expect(verdict.triggered).toBe(false);
  });

  it('classifies test-only evidence as an admin-only diff', () => {
    expect(isAdminOnlyDiff([
      'src/app/api/contact/__tests__/route.test.ts',
      'qa_results.json',
    ])).toBe(true);
    expect(isAdminOnlyDiff([
      'src/app/api/contact/route.ts',
      'src/app/api/contact/__tests__/route.test.ts',
    ])).toBe(false);
  });
});
