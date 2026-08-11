import { supabaseAdmin } from '@/lib/database/supabase-client';
import { sendGridService } from '@/lib/services/sendgrid-service';
import { resolveEmailLocale } from '@/lib/i18n/email-locale';
import { platformT } from '@/lib/i18n/email-messages/platform';
import { EmailSendService } from '@/lib/services/email/EmailSendService';

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
      const locale = await resolveEmailLocale({ siteId, userId: site.user_id });

      // 3. Construct the HTML email
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.uncodie.com';
      const billingUrl = `${baseUrl}/billing`;
      const title = platformT(locale, 'billing.insufficient_credits.title');
      const body = platformT(locale, 'billing.insufficient_credits.body', {
        required,
        available,
      });
      const subject = platformT(locale, 'billing.insufficient_credits.subject', { siteName });
      const hello = platformT(locale, 'common.hello', { name: ownerName });
      
      const emailHtml = `
      <!DOCTYPE html>
      <html lang="${locale}">
      <head>
        <meta charset="utf-8">
        <style>
        :root { color-scheme: light dark; }

    .email-header {
      background-color: #1e1e2d !important;
      background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
    }
    .email-card {
      background-color: #fafafa !important;
      background-image: linear-gradient(#fafafa, #fafafa) !important;
    }
    .email-panel {
      background-color: #f0f0f5 !important;
      background-image: linear-gradient(#f0f0f5, #f0f0f5) !important;
      border: 1px solid #e4e4e7 !important;
    }
    .email-code-box {
      background-color: #f4ffe5 !important;
      background-image: linear-gradient(#f4ffe5, #f4ffe5) !important;
      border: 1px solid #c6f08a !important;
    }

    /* Chips: brand lime + black text (same accent as app primary-button) */
    .email-badge {
      display: inline-block !important;
      background-color: #90ff17 !important;
      background-image: linear-gradient(#90ff17, #90ff17) !important;
      box-shadow: inset 0 0 0 999px #90ff17 !important;
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important;
      border: 0 !important;
    }
    .email-label {
      color: #3f6212 !important;
      -webkit-text-fill-color: #3f6212 !important;
      font-weight: 600 !important;
    }

    .email-link { color: #000000 !important; -webkit-text-fill-color: #000000 !important; }

    .email-cta-td {
      background-color: #000000 !important;
      background-image: linear-gradient(#000000, #000000) !important;
      box-shadow: inset 0 0 0 999px #000000 !important;
    }
    .email-cta {
      background-color: #000000 !important;
      background-image: linear-gradient(#000000, #000000) !important;
      box-shadow: inset 0 0 0 999px #000000 !important;
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
      border: 0 !important;
    }
    .email-cta-label {
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
    }

    @media (prefers-color-scheme: light) {
      .email-header-title { color: #f0f0f5 !important; -webkit-text-fill-color: #f0f0f5 !important; }
      .email-header-sub { color: #a1a1aa !important; -webkit-text-fill-color: #a1a1aa !important; }
      .email-heading { color: #1e1e2d !important; -webkit-text-fill-color: #1e1e2d !important; }
      .email-text { color: #334155 !important; -webkit-text-fill-color: #334155 !important; }
      .email-muted { color: #64748b !important; -webkit-text-fill-color: #64748b !important; }
      .email-subtle { color: #64748b !important; -webkit-text-fill-color: #64748b !important; }
      .email-panel,
      .email-panel .email-text,
      .email-panel div,
      .email-panel strong,
      .email-panel p {
        color: #1e1e2d !important;
        -webkit-text-fill-color: #1e1e2d !important;
      }
      .email-code-label { color: #3f6212 !important; -webkit-text-fill-color: #3f6212 !important; }
      .email-code-value { color: #1e1e2d !important; -webkit-text-fill-color: #1e1e2d !important; }
      .email-label { color: #3f6212 !important; -webkit-text-fill-color: #3f6212 !important; }
      .email-link { color: #000000 !important; -webkit-text-fill-color: #000000 !important; }
    }

    @media (prefers-color-scheme: dark) {
      .email-header {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
      }
      .email-header-title,
      .email-header h1,
      .email-header p,
      .email-header span,
      .email-header div {
        color: #f0f0f5 !important;
        -webkit-text-fill-color: #f0f0f5 !important;
      }
      .email-header-sub {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }

      .email-card {
        background-color: #15151b !important;
        background-image: linear-gradient(#15151b, #15151b) !important;
        color: #e2e8f0 !important;
      }

      .email-heading,
      .email-text,
      .email-card h1:not(.email-header-title),
      .email-card h2,
      .email-card h3,
      .email-card h4,
      .email-card p,
      .email-card li,
      .email-card td,
      .email-card th,
      .email-card strong,
      .email-card label,
      .email-card div:not(.email-badge):not(.email-cta):not(.email-header):not(.email-cta-td) {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }

      .email-muted,
      .email-subtle {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }

      .email-panel {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #2d2d3d !important;
      }
      .email-panel,
      .email-panel .email-text,
      .email-panel .email-muted,
      .email-panel .email-label,
      .email-panel div:not(.email-badge),
      .email-panel p,
      .email-panel strong,
      .email-panel span:not(.email-badge):not(.email-cta-label) {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }
      .email-panel a.email-link {
        color: #ffffff !important;
        -webkit-text-fill-color: #ffffff !important;
      }

      .email-code-box {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #3f6212 !important;
      }
      .email-code-label {
        color: #bef264 !important;
        -webkit-text-fill-color: #bef264 !important;
      }
      .email-code-value {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }

      .email-link {
        color: #ffffff !important;
        -webkit-text-fill-color: #ffffff !important;
      }

      /* Lime badge stays brand accent in dark (black text on lime) */
      .email-badge,
      .email-card .email-badge,
      .email-panel .email-badge {
        background-color: #90ff17 !important;
        background-image: linear-gradient(#90ff17, #90ff17) !important;
        box-shadow: inset 0 0 0 999px #90ff17 !important;
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
      }
      .email-label {
        color: #bef264 !important;
        -webkit-text-fill-color: #bef264 !important;
      }

      .email-cta-td {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
      }
      .email-cta {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
        border: 0 !important;
      }
      .email-cta-label,
      .email-cta span {
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
      }
    }
      .email-header-title,
      .email-header h1,
      .email-header p,
      .email-header span,
      .email-header div {
        color: #f0f0f5 !important;
        -webkit-text-fill-color: #f0f0f5 !important;
      }
      .email-header-sub {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }

      .email-card {
        background-color: #15151b !important;
        background-image: linear-gradient(#15151b, #15151b) !important;
        color: #e2e8f0 !important;
      }

      .email-heading,
      .email-text,
      .email-card h1:not(.email-header-title),
      .email-card h2,
      .email-card h3,
      .email-card h4,
      .email-card p,
      .email-card li,
      .email-card td,
      .email-card th,
      .email-card strong,
      .email-card label,
      .email-card div:not(.email-badge):not(.email-cta):not(.email-header):not(.email-cta-td) {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }

      .email-muted,
      .email-subtle {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }

      .email-panel {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #2d2d3d !important;
      }
      .email-panel,
      .email-panel .email-text,
      .email-panel div:not(.email-badge),
      .email-panel p,
      .email-panel strong,
      .email-panel span:not(.email-badge):not(.email-cta-label) {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }

      .email-code-box {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #2d2d3d !important;
      }
      .email-code-label {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }
      .email-code-value {
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
      }

      .email-link {
        color: #ffffff !important;
        -webkit-text-fill-color: #ffffff !important;
      }

      /* Badges stay saturated accent (do not get washed out by card text rules) */
      .email-badge,
      .email-card .email-badge,
      .email-panel .email-badge {
        background-color: #90ff17 !important;
        background-image: linear-gradient(#90ff17, #90ff17) !important;
        box-shadow: inset 0 0 0 999px #90ff17 !important;
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
      }
      .email-label {
        color: #a1a1aa !important;
        -webkit-text-fill-color: #a1a1aa !important;
      }

      .email-cta-td {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
      }
      .email-cta {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
        border: 0 !important;
      }
      .email-cta-label,
      .email-cta span {
        color: #000000 !important;
        -webkit-text-fill-color: #000000 !important;
      }
    }
      .email-header-title { color: #f0f0f5 !important; }
      .email-header-sub { color: #a1a1aa !important; }

      .email-card {
        background-color: #15151b !important;
        background-image: linear-gradient(#15151b, #15151b) !important;
        color: #e2e8f0 !important;
      }

      /* Readable copy when Mail inverts the card */
      .email-heading,
      .email-text,
      .email-card h1:not(.email-header-title),
      .email-card h2,
      .email-card h3,
      .email-card h4,
      .email-card p,
      .email-card li,
      .email-card td,
      .email-card th,
      .email-card strong,
      .email-card label,
      .email-card span:not(.email-cta-label):not(.email-header-sub) {
        color: #e2e8f0 !important;
      }

      .email-muted,
      .email-subtle,
      .email-card .email-muted,
      .email-card .email-subtle {
        color: #a1a1aa !important;
      }

      .email-panel {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #2d2d3d !important;
        color: #e2e8f0 !important;
      }
      .email-panel,
      .email-panel div,
      .email-panel p,
      .email-panel strong,
      .email-panel span:not(.email-cta-label) {
        color: #e2e8f0 !important;
      }

      .email-badge {
        background-color: #2d2d3d !important;
        background-image: linear-gradient(#2d2d3d, #2d2d3d) !important;
        color: #a1a1aa !important;
      }

      .email-link { color: #ffffff !important; }

      .email-cta-td {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
      }
      .email-cta {
        background-color: #ffffff !important;
        background-image: linear-gradient(#ffffff, #ffffff) !important;
        box-shadow: inset 0 0 0 999px #ffffff !important;
        color: #000000 !important;
        border: 0 !important;
      }
      .email-cta-label,
      .email-cta span {
        color: #000000 !important;
      }

      .email-code-box {
        background-color: #1e1e2d !important;
        background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
        border: 1px solid #2d2d3d !important;
      }
      .email-code-label { color: #a1a1aa !important; }
      .email-code-value { color: #e2e8f0 !important; }

      /* Keep header children light even if nested rules race */
      .email-header,
      .email-header h1,
      .email-header p,
      .email-header span,
      .email-header div {
        color: #f0f0f5 !important;
      }
      .email-header .email-header-sub { color: #a1a1aa !important; }
    }
          .email-header-title { color: #e2e8f0 !important; }
          .email-header-sub { color: #a1a1aa !important; }
          .email-panel {
            background-color: #1e1e2d !important;
            background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
            border-color: #2d2d3d !important;
          }
          .email-card {
            background-color: #15151b !important;
            background-image: linear-gradient(#15151b, #15151b) !important;
          }
          .email-link { color: #ffffff !important; }
          .email-cta-td {
            background-color: #ffffff !important;
            background-image: linear-gradient(#ffffff, #ffffff) !important;
            box-shadow: inset 0 0 0 999px #ffffff !important;
          }
          .email-cta {
            background-color: #ffffff !important;
            background-image: linear-gradient(#ffffff, #ffffff) !important;
            box-shadow: inset 0 0 0 999px #ffffff !important;
            color: #000000 !important;
            border: 0 !important;
          }
          .email-cta-label { color: #000000 !important; }
        }
          .email-cta-label { color: #000000 !important; }
        }
        }
        }

          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #333; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 15px; margin-bottom: 20px; }
          .content { background-color: #ffffff; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .button { display: inline-block; background-color: #000000; font-weight: 600; color: #ffffff !important; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin-top: 20px; }
          .stats { background-color: #f3f4f6; padding: 15px; border-radius: 6px; margin: 15px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin: 0; color: #991b1b;">${EmailSendService.escapeHtml(title)}</h2>
          </div>
          <div class="content">
            <p>${EmailSendService.escapeHtml(hello)}</p>
            <p>${EmailSendService.escapeHtml(body)}</p>
            <p><strong>${EmailSendService.escapeHtml(siteName)}</strong></p>
            <div class="stats">
              <p style="margin: 5px 0;"><strong>${required}</strong> / ${available}</p>
            </div>
            <div style="text-align: center;">
              <a href="${EmailSendService.escapeAttr(billingUrl)}" class="button">Billing</a>
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
        subject,
        html: emailHtml,
        categories: ['billing', 'system-notification', 'insufficient-credits'],
        customArgs: { siteId, notificationType: 'insufficient_credits', locale }
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
        message: body,
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
