import {
  buildToolActionKey,
  detectActionLoop,
} from '../loop-detectors';

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
