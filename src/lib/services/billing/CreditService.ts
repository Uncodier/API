import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';

export class InsufficientCreditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientCreditsError';
  }
}

export class CreditService {
  /**
   * Automatically notifies the site owner via email when insufficient credits prevent an operation.
   * Enforces a 24-hour debounce per site to avoid spamming.
   */
  private static async notifyInsufficientCredits(siteId: string, required: number, available: number): Promise<void> {
    try {
      if (!siteId) return;

      // 1. Check for recent insufficient_credits notification for this site (last 24 hours)
      const twentyFourHoursAgo = new Date();
      twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

      const { data: recentNotification, error: notifError } = await supabaseAdmin
        .from('notifications')
        .select('id')
        .eq('site_id', siteId)
        .eq('type', 'error')
        .eq('title', 'Insufficient Credits')
        .gte('created_at', twentyFourHoursAgo.toISOString())
        .limit(1);

      if (notifError) {
        console.error(`[CreditService] Error checking recent notifications for site ${siteId}:`, notifError);
        return;
      }

      if (recentNotification && recentNotification.length > 0) {
        // We already sent a notification within the last 24h
        console.log(`[CreditService] Suppressing insufficient credits email for site ${siteId} (debounce active)`);
        return;
      }

      // 2. Fetch site owner information
      const { data: site, error: siteError } = await supabaseAdmin
        .from('sites')
        .select('name, user_id')
        .eq('id', siteId)
        .single();

      if (siteError || !site || !site.user_id) {
        console.error(`[CreditService] Error fetching site owner for site ${siteId}:`, siteError);
        return;
      }

      const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(site.user_id);
      
      if (userError || !userData?.user?.email) {
        console.error(`[CreditService] Error fetching user email for site ${siteId}:`, userError);
        return;
      }

      const ownerEmail = userData.user.email;
      const ownerName = userData.user.user_metadata?.name || userData.user.user_metadata?.full_name || 'Site Owner';
      const siteName = site.name || 'Your Site';

      // 3. Construct the HTML email
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
      const billingUrl = `${baseUrl}/billing`;
      
      const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #333; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 15px; margin-bottom: 20px; }
          .content { background-color: #ffffff; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .button { display: inline-block; background-color: #3b82f6; color: #ffffff !important; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin-top: 20px; }
          .stats { background-color: #f3f4f6; padding: 15px; border-radius: 6px; margin: 15px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0; color: #991b1b;">Action Blocked: Insufficient Credits</h2>
          </div>
          <div class="content">
            <p>Hello ${ownerName},</p>
            <p>An operation on your site <strong>${siteName}</strong> could not be completed because your account does not have enough credits.</p>
            
            <div class="stats">
              <p style="margin: 5px 0;"><strong>Required Credits:</strong> ${required}</p>
              <p style="margin: 5px 0;"><strong>Available Credits:</strong> ${available}</p>
            </div>
            
            <p>To ensure your automated processes continue to run smoothly, please add more credits to your account.</p>
            
            <div style="text-align: center;">
              <a href="${billingUrl}" class="button">Go to Billing</a>
            </div>
          </div>
        </div>
      </body>
      </html>
      `;

      // 4. Send the email
      console.log(`[CreditService] Sending insufficient credits email to ${ownerEmail} for site ${siteId}`);
      const emailResult = await sendGridService.sendEmail({
        to: ownerEmail,
        subject: `Action Blocked: Insufficient Credits for ${siteName}`,
        html: emailHtml,
        categories: ['billing', 'system-notification', 'insufficient-credits'],
        customArgs: { siteId, notificationType: 'insufficient_credits' }
      });

      if (!emailResult.success) {
        console.error(`[CreditService] Failed to send insufficient credits email:`, emailResult.error);
        return;
      }

      // 5. Log the notification to enforce the 24h cooldown
      const { error: insertError } = await supabaseAdmin.from('notifications').insert({
        site_id: siteId,
        user_id: site.user_id,
        title: 'Insufficient Credits',
        message: `An operation was blocked due to insufficient credits. Required: ${required}, Available: ${available}.`,
        type: 'error',
        severity: 3,
        action_url: '/billing',
        is_read: false
      });

      if (insertError) {
        console.error(`[CreditService] Failed to insert debounce notification for site ${siteId}:`, insertError);
      }

    } catch (error) {
      console.error(`[CreditService] Unhandled error in notifyInsufficientCredits:`, error);
    }
  }

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

    if (billing.credits_available < requiredCredits) {
      // Fire-and-forget the notification
      this.notifyInsufficientCredits(siteId, requiredCredits, billing.credits_available).catch(console.error);
      return false;
    }

    return true;
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
        // Fire-and-forget the notification
        this.notifyInsufficientCredits(siteId, data.required, data.available).catch(console.error);
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
    VIDEO_GENERATION_MINUTE: 24.0, // Veo 3.1 Standard: $0.40/sec = $24/min. (1 credit = $1)
    AUDIO_GENERATION_MINUTE: 2.0,
    AUDIO_TRANSCRIPTION: 0.1,
    FRAME_EXTRACTION: 0.1,
  };
}
