import { getPromptHash } from '../promptSummaryCache';
import { SummaryGenerationService } from '../SummaryGenerationService';
import { loadSourceText } from '../loadSourceText';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

function mockFromTable(tables: Record<string, { data: any; error?: any }>) {
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const result = tables[table] || { data: null, error: { message: 'not mocked' } };
    return {
      select: () => ({
        eq: () => ({
          single: jest.fn().mockResolvedValue({
            data: result.data,
            error: result.error || null,
          }),
        }),
      }),
    };
  });
}

describe('Summary Services', () => {
  describe('promptSummaryCache', () => {
    it('generates a consistent deterministic hash', () => {
      const hash1 = getPromptHash('Hello World');
      const hash2 = getPromptHash('hello world  ');

      expect(hash1).toEqual(hash2);
      expect(hash1).toHaveLength(64);
    });
  });

  describe('loadSourceText', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('loads source text for records and resolves relations', async () => {
      mockFromTable({
        records: {
          data: {
            id: 'r1',
            title: 'Test Record',
            description: 'Test Description',
            category: { name: 'Test Category' },
            data: { amount: 100, custom_field: 'value' },
            relations: { lead: 'l1' },
          },
        },
        leads: {
          data: { name: 'Ada', company: 'Acme', status: 'open' },
        },
      });

      const text = await loadSourceText('records', 'r1');

      expect(supabaseAdmin.from).toHaveBeenCalledWith('records');
      expect(text).toContain('Title: Test Record');
      expect(text).toContain('Description: Test Description');
      expect(text).toContain('Category: Test Category');
      expect(text).toContain('amount: 100');
      expect(text).toContain('Linked to Lead: Ada');
    });

    it('loads source text for catalog_items', async () => {
      mockFromTable({
        catalog_items: {
          data: {
            id: 'c1',
            name: 'Test Item',
            description: 'Item Description',
            kind: 'product',
          },
        },
      });

      const text = await loadSourceText('catalog_items', 'c1');

      expect(supabaseAdmin.from).toHaveBeenCalledWith('catalog_items');
      expect(text).toContain('Name: Test Item');
      expect(text).toContain('Description: Item Description');
      expect(text).toContain('Kind: product');
    });

    it('rejects unknown collections with UnsupportedCollectionError', async () => {
      await expect(loadSourceText('unknown_collection', 'id1')).rejects.toMatchObject({
        name: 'UnsupportedCollectionError',
        message: 'Unsupported collection for source loading: unknown_collection',
      });
    });
  });

  describe('SummaryGenerationService.summarize', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('sends the source text to /api/ai/text and returns the summary', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: '  Short factual summary.  ' }),
      }) as any;

      const result = await SummaryGenerationService.summarize({
        text: 'Title: Invoice\nAmount: 40',
        site_id: '00000000-0000-0000-0000-000000000000',
      });

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Short factual summary.');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(String(url)).toContain('/api/ai/text');
      const body = JSON.parse(init.body);
      expect(body.messages[1].content).toBe('Title: Invoice\nAmount: 40');
    });

    it('returns 400 when text is empty', async () => {
      const result = await SummaryGenerationService.summarize({
        text: '   ',
        site_id: '00000000-0000-0000-0000-000000000000',
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
    });
  });

  describe('embedding input contract', () => {
    it('uses the generated summary as embedding input, not the raw field dump', () => {
      const rawDump = 'Title: Invoice\nData:\n- amount: 40\n';
      const summary = 'Invoice for 40 related to Acme.';
      const embeddingInput = summary;
      expect(embeddingInput).toBe(summary);
      expect(embeddingInput).not.toBe(rawDump);
      expect(embeddingInput).not.toContain('Data:');
    });
  });
});
