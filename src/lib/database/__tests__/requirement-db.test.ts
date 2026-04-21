/**
 * Focused unit tests for the metadata-merge helper used by updateRequirement.
 *
 * We intentionally do not exercise the full CRUD path here because mocking the
 * @supabase/supabase-js client under ts-jest + useESM is brittle; the database
 * layer is covered by integration tests elsewhere. What matters most for the
 * requirement-id-in-branch plan is that partial `metadata.git` updates do not
 * wipe unrelated `metadata.*` subtrees, which this helper guarantees.
 */

import { mergeMetadataShallow } from '../requirement-db';

describe('mergeMetadataShallow', () => {
  test('returns a new object (does not mutate base)', () => {
    const base = { a: 1, nested: { x: 1 } };
    const incoming = { b: 2 };
    const out = mergeMetadataShallow(base, incoming);
    expect(out).not.toBe(base);
    expect(base).toEqual({ a: 1, nested: { x: 1 } });
    expect(out).toEqual({ a: 1, nested: { x: 1 }, b: 2 });
  });

  test('handles null/undefined base and incoming', () => {
    expect(mergeMetadataShallow(null, null)).toEqual({});
    expect(mergeMetadataShallow(undefined, undefined)).toEqual({});
    expect(mergeMetadataShallow({ a: 1 }, null)).toEqual({ a: 1 });
    expect(mergeMetadataShallow(null, { a: 1 })).toEqual({ a: 1 });
  });

  test('top-level scalar keys from incoming override base', () => {
    const out = mergeMetadataShallow({ a: 1, b: 'x' }, { b: 'y', c: true });
    expect(out).toEqual({ a: 1, b: 'y', c: true });
  });

  test('merges nested object keys one level (git partial update)', () => {
    const base = {
      git: { kind: 'applications', org: 'makinary', repo: 'apps', default_branch: 'main' },
      unrelated: 'keep-me',
    };
    const incoming = { git: { repo: 'sites' } };
    const out = mergeMetadataShallow(base, incoming);
    expect(out).toEqual({
      git: {
        kind: 'applications',
        org: 'makinary',
        repo: 'sites',
        default_branch: 'main',
      },
      unrelated: 'keep-me',
    });
  });

  test('replaces arrays wholesale rather than merging entries', () => {
    const base = { tags: ['a', 'b'] };
    const incoming = { tags: ['c'] };
    expect(mergeMetadataShallow(base, incoming)).toEqual({ tags: ['c'] });
  });

  test('replaces nested object with scalar when incoming is scalar', () => {
    const base = { git: { org: 'makinary' } };
    const incoming = { git: null };
    expect(mergeMetadataShallow(base, incoming)).toEqual({ git: null });
  });

  test('adds new top-level keys without touching existing ones', () => {
    const base = { git: { repo: 'apps' } };
    const incoming = { preview: { branch: 'feature/x' } };
    expect(mergeMetadataShallow(base, incoming)).toEqual({
      git: { repo: 'apps' },
      preview: { branch: 'feature/x' },
    });
  });
});
