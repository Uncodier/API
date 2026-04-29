import { supabaseAdmin } from '@/lib/database/supabase-client';

export class InsufficientCreditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientCreditsError';
  }
}

export class CreditService {
  /**
   * Pre-check if site has enough credits before execution.
   */
  static async validateCredits(siteId: string, requiredCredits: number): Promise<boolean> {
    if (!siteId) return false;

    const { data: billing, error } = await supabaseAdmin
      .from('billing')
      .select('credits_available')
      .eq('site_id', siteId)
      .single();

    if (error || !billing) {
      console.error(`[CreditService] Error fetching billing info for site ${siteId}:`, error);
      return false;
    }

    return billing.credits_available >= requiredCredits;
  }

  /**
   * Deduct credits using the secure RPC. Throws InsufficientCreditsError if it fails.
   */
  static async deductCredits(
    siteId: string,
    amount: number,
    transactionType: string,
    description: string,
    metadata: Record<string, any> = {}
  ): Promise<{ success: boolean; remaining?: number; error?: string }> {
    if (!siteId || amount <= 0) {
      return { success: false, error: 'Invalid siteId or amount' };
    }

    const { data, error } = await supabaseAdmin.rpc('deduct_credits', {
      p_site_id: siteId,
      p_amount: amount,
      p_type: transactionType,
      p_description: description,
      p_metadata: metadata
    });

    if (error) {
      console.error(`[CreditService] RPC Error during deduction:`, error);
      return { success: false, error: error.message };
    }

    if (!data.success) {
      if (data.error === 'Insufficient credits') {
        throw new InsufficientCreditsError(`Not enough credits. Available: ${data.available}, Required: ${data.required}`);
      }
      return { success: false, error: data.error };
    }

    return { success: true, remaining: data.remaining };
  }

  /**
   * Helper constants for pricing
   */
  static PRICING = {
    ENRICHMENT_BASIC: 0.1,
    ENRICHMENT_PHONE: 0.25,
    PERSON_ROLE_SEARCH: 0.1,
    PLACES_SEARCH: 0.1,
    TAVILY_SEARCH: 0.1,
    ASSISTANT_INPUT_TOKEN_MILLION: 1.0, // 1 credit per million input tokens
    ASSISTANT_OUTPUT_TOKEN_MILLION: 20.0, // 20 credits per million output tokens
    SANDBOX_HOUR: 0.5, // 0.5 credits per hour of sandbox usage
    IMAGE_GENERATION: 0.1,
    VIDEO_GENERATION_MINUTE: 20.0,
    AUDIO_GENERATION_MINUTE: 2.0,
    AUDIO_TRANSCRIPTION: 0.1,
    FRAME_EXTRACTION: 0.1,
  };
}
