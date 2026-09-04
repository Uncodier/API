import { loadSourceText } from '@/lib/services/summary/loadSourceText';

export interface SummarizeParams {
  text: string;
  site_id: string;
}

export interface SummarizeSourceParams {
  collection: string;
  id: string;
  site_id: string;
}

export interface SummaryResult {
  success: boolean;
  summary?: string;
  error?: string;
  status?: number;
}

const SYSTEM_PROMPT = `You are a factual summarization assistant.
Analyze the following information and provide a concise, factual summary in 1 to 3 sentences.
The summary MUST be in the same language as the original text.
Do not include conversational filler, greetings, or opinions. Just the summary.`;

async function callTextAPI(params: {
  text: string;
  site_id: string;
}): Promise<string> {
  const apiUrl = `${process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:3000'}/api/ai/text`;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.SERVICE_API_KEY || '',
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: params.text },
      ],
      temperature: 0.3,
      maxTokens: 150,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Text API request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = typeof data?.content === 'string' ? data.content.trim() : '';
  if (!content) {
    throw new Error('No summary returned from AI service');
  }
  return content;
}

export class SummaryGenerationService {
  /**
   * Generates a 1-3 sentence factual summary of the given text.
   * Calls POST /api/ai/text with a service API key (same pattern as image generation).
   */
  static async summarize(params: SummarizeParams): Promise<SummaryResult> {
    try {
      const text = typeof params.text === 'string' ? params.text.trim() : '';
      if (!text) {
        return { success: false, error: 'text is required', status: 400 };
      }

      const summary = await callTextAPI({ text, site_id: params.site_id });
      return { success: true, summary };
    } catch (error: any) {
      console.error('[SummaryGenerationService] summarize error:', error);
      return {
        success: false,
        error: error.message || 'Failed to generate summary',
      };
    }
  }

  static async loadSourceText(collection: string, id: string): Promise<string> {
    return loadSourceText(collection, id);
  }

  /**
   * Load compact source text for a collection entity, then summarize it.
   */
  static async summarizeSource(params: SummarizeSourceParams): Promise<SummaryResult> {
    try {
      const text = await loadSourceText(params.collection, params.id);
      return await this.summarize({ text, site_id: params.site_id });
    } catch (error: any) {
      console.error('[SummaryGenerationService] summarizeSource error:', error);
      const status = error?.name === 'UnsupportedCollectionError' ? 400 : 500;
      return {
        success: false,
        error: error.message || 'Failed to summarize source',
        status,
      };
    }
  }
}
