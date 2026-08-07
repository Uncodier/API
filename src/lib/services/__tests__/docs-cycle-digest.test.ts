import {
  processDocsDigest,
  summarizeJson,
  summarizeText,
  summarizeMarkdown,
  formatDigestForPrompt,
  RawDocFile,
} from '../docs-cycle-digest';

describe('docs-cycle-digest', () => {
  describe('summarizeText', () => {
    it('returns full content if under budget', () => {
      const content = 'Hello world';
      expect(summarizeText(content, 100)).toBe(content);
    });

    it('summarizes content with head and tail if over budget', () => {
      const content = 'A'.repeat(500);
      const summarized = summarizeText(content, 100);
      expect(summarized).toContain('bytes omitted');
      expect(Buffer.byteLength(summarized, 'utf-8')).toBeLessThanOrEqual(160);
    });
  });

  describe('summarizeMarkdown', () => {
    it('keeps headings when summarizing', () => {
      const content = `# Title\n\n${'para '.repeat(400)}\n\n## Section\n\n${'more '.repeat(400)}`;
      const summarized = summarizeMarkdown(content, 800);
      expect(summarized).toContain('# Title');
      expect(summarized).toContain('## Section');
      expect(summarized).toContain('Headings');
      expect(summarized).toContain('omitted');
    });
  });

  describe('summarizeJson', () => {
    it('keeps top-level scalar values and flattens nested scalars', () => {
      const jsonStr = JSON.stringify({
        price: 20,
        currency: 'USD',
        details: { nested: true, qty: 3 },
        items: [1, 2, 3],
        longDesc: 'A'.repeat(200),
      });

      const summarized = summarizeJson(jsonStr, 1000);
      const parsed = JSON.parse(summarized);

      expect(parsed.price).toBe(20);
      expect(parsed.currency).toBe('USD');
      expect(parsed.details).toEqual({ nested: true, qty: 3 });
      expect(parsed.items).toEqual([1, 2, 3]);
      expect(parsed.longDesc.length).toBeLessThan(120);
    });

    it('falls back to text summarization for invalid JSON', () => {
      const content = `{ invalid json ${'A'.repeat(500)}`;
      const summarized = summarizeJson(content, 100);
      expect(summarized).toContain('bytes omitted');
    });
  });

  describe('processDocsDigest', () => {
    it('processes files without summarization if under budget', () => {
      const files: RawDocFile[] = [
        { path: 'docs/a.md', content: 'File A', mtime: 2 },
        { path: 'docs/b.md', content: 'File B', mtime: 1 },
      ];

      const results = processDocsDigest(files, {
        maxTotalBytes: 1000,
        maxFileBytes: 100,
        maxFiles: 10,
      });

      expect(results).toHaveLength(2);
      expect(results[0].path).toBe('docs/a.md');
      expect(results[0].summarized).toBe(false);
    });

    it('summarizes individual files over maxFileBytes', () => {
      const files: RawDocFile[] = [
        { path: 'docs/large.md', content: `# H\n${'A'.repeat(400)}`, mtime: 1 },
      ];

      const results = processDocsDigest(files, {
        maxTotalBytes: 1000,
        maxFileBytes: 150,
        maxFiles: 10,
      });

      expect(results).toHaveLength(1);
      expect(results[0].summarized).toBe(true);
      expect(results[0].content).toContain('omitted');
    });

    it('caps the number of files based on maxFiles', () => {
      const files: RawDocFile[] = Array.from({ length: 15 }, (_, i) => ({
        path: `docs/f${i}.md`,
        content: 'Small content',
        mtime: i,
      }));

      const results = processDocsDigest(files, { maxFiles: 10 });
      expect(results).toHaveLength(10);
      expect(results[0].path).toBe('docs/f14.md');
    });

    it('stops adding files if total bytes budget is exhausted', () => {
      const files: RawDocFile[] = [
        { path: 'docs/1.md', content: 'A'.repeat(800), mtime: 3 },
        { path: 'docs/2.md', content: 'B'.repeat(800), mtime: 2 },
        { path: 'docs/3.md', content: 'C'.repeat(800), mtime: 1 },
      ];

      const results = processDocsDigest(files, { maxTotalBytes: 1000, maxFileBytes: 1000 });
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('docs/1.md');
    });
  });

  describe('formatDigestForPrompt', () => {
    it('formats empty and non-empty digests', () => {
      expect(formatDigestForPrompt([])).toContain('No docs found');
      const text = formatDigestForPrompt([
        {
          path: 'docs/quote.json',
          content: '{"price":20}',
          bytes: 12,
          bytes_original: 12,
          summarized: false,
        },
      ]);
      expect(text).toContain('docs/quote.json');
      expect(text).toContain('"price":20');
    });
  });
});
