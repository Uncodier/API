// Email templates and helpers for Lead Assignment notifications

export function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Makinari, your AI Sales Team';
}

export function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Makinari';
}

export function formatLeadOrigin(origin?: string): string | undefined {
  if (!origin) return undefined;
  const lower = origin.toLowerCase();
  const originMap: Record<string, string> = {
    lead_generation_workflow: 'Lead Generation Workflow',
    website_chat: 'Website Chat',
    direct_inquiry: 'Direct Inquiry',
    partner_referral: 'Partner Referral',
    enterprise_inquiry: 'Enterprise Inquiry',
    demo_request: 'Demo Request',
    pricing_request: 'Pricing Request',
    email: 'Email',
    whatsapp: 'WhatsApp',
    website: 'Website',
    chat: 'Chat'
  };

  if (originMap[lower]) return originMap[lower];

  // Fallback: replace underscores with spaces and title case words
  return origin
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function generateAssigneeNotificationHtml(data: {
  assigneeName: string;
  leadName: string;
  leadEmail?: string;
  leadPhone?: string;
  leadPosition?: string;
  leadCompany?: string;
  leadStatus: string;
  leadOrigin?: string;
  brief: string;
  nextSteps: string[];
  priority: string;
  dueDate?: string;
  additionalContext?: string;
  siteName: string;
  siteUrl?: string;
  leadUrl?: string;
  logoUrl?: string;
  replyEmail?: string;
  locale?: string;
}): string {
  const priorityColors = {
    low: { bg: '#f0f9ff', color: '#0369a1', border: '#7dd3fc' },
    normal: { bg: '#f8fafc', color: '#475569', border: '#cbd5e1' },
    high: { bg: '#fef3c7', color: '#d97706', border: '#fde047' },
    urgent: { bg: '#fee2e2', color: '#dc2626', border: '#fca5a5' }
  } as const;

  const priorityColor = priorityColors[data.priority as keyof typeof priorityColors];

  return `
    <!DOCTYPE html>
    <html lang="${data.locale || 'en'}">
    <head>
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
<style type="text/css">
        :root { color-scheme: light only; }

    .email-header {
      background-color: #1e1e2d !important;
      background-image: linear-gradient(#1e1e2d, #1e1e2d) !important;
    }
    .email-header-title,
    .email-header h1 {
      color: #f0f0f5 !important;
      -webkit-text-fill-color: #f0f0f5 !important;
    }
    .email-header-sub,
    .email-header p {
      color: #a1a1aa !important;
      -webkit-text-fill-color: #a1a1aa !important;
    }

    .email-card {
      background-color: #ffffff !important;
      background-image: linear-gradient(#ffffff, #ffffff) !important;
      color: #111111 !important;
    }

    .email-heading {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }
    .email-text {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }
    .email-muted,
    .email-subtle {
      color: #52525b !important;
      -webkit-text-fill-color: #52525b !important;
    }

    .email-panel {
      background-color: #f0f0f5 !important;
      background-image: linear-gradient(#f0f0f5, #f0f0f5) !important;
      border: 1px solid #e4e4e7 !important;
      color: #111111 !important;
    }
    .email-panel,
    .email-panel .email-text,
    .email-panel .email-heading,
    .email-panel div,
    .email-panel p,
    .email-panel span:not(.email-badge):not(.email-cta-label),
    .email-panel strong {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }

    .email-code-box {
      background-color: #f4ffe5 !important;
      background-image: linear-gradient(#f4ffe5, #f4ffe5) !important;
      border: 1px solid #c6f08a !important;
    }
    .email-code-label {
      color: #3f6212 !important;
      -webkit-text-fill-color: #3f6212 !important;
    }
    .email-code-value {
      color: #111111 !important;
      -webkit-text-fill-color: #111111 !important;
    }

    .email-label {
      color: #3f6212 !important;
      -webkit-text-fill-color: #3f6212 !important;
      font-weight: 600 !important;
    }

    .email-badge {
      display: inline-block !important;
      background-color: #90ff17 !important;
      background-image: linear-gradient(#90ff17, #90ff17) !important;
      box-shadow: inset 0 0 0 999px #90ff17 !important;
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important;
      border: 0 !important;
    }

    .email-link {
      color: #000000 !important;
      -webkit-text-fill-color: #000000 !important;
    }

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
    .email-cta-label,
    .email-cta span {
      color: #ffffff !important;
      -webkit-text-fill-color: #ffffff !important;
    }
        
</style>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Lead Assignment - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        <div class="email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #f0f0f5; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #f0f0f5; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 16px; height: 16px; background-color: #90ff17; font-weight: 600; border-radius: 50%;"></div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">New Lead Assignment</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">You have a new lead to work with</p>
        </div>
        <div style="padding: 40px;">
          <div style="margin-bottom: 32px;">
            <h2 class="email-heading" style="margin: 0 0 16px; font-size: 20px; color: #111111; font-weight: 600;">Hello ${data.assigneeName}</h2>
            <p class="email-text" style="margin: 0; font-size: 16px; color: #111111; line-height: 1.7;">You have been assigned a new lead from ${data.siteName}. Please review the information below and take the necessary next steps.</p>
          </div>
          <div style="margin-bottom: 32px; text-align: center;">
            <div class="email-badge" style="display: inline-block; background-color: ${priorityColor.bg}; color: ${priorityColor.color}; border: 1px solid ${priorityColor.border}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">${data.priority} Priority</div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Lead Information</h3>
            <div class="email-panel" style="background-color: #f0f0f5; padding: 24px; border-radius: 8px; border-left: 4px solid #90ff17;">
              <div style="display: grid; gap: 12px;">
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Name:</span>
                  <span class="email-text" style="color: #111111; font-size: 15px;">${data.leadName}</span>
                </div>
                ${data.leadEmail ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Email:</span>
                  <a href="mailto:${data.leadEmail}" style="color: #000000; font-weight: 600; text-decoration: none; font-size: 15px;">${data.leadEmail}</a>
                </div>
                ` : ''}
                ${data.leadPhone ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Phone:</span>
                  <a href="tel:${data.leadPhone}" style="color: #000000; font-weight: 600; text-decoration: none; font-size: 15px;">${data.leadPhone}</a>
                </div>
                ` : ''}
                ${data.leadPosition ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Position:</span>
                  <span class="email-text" style="color: #111111; font-size: 15px;">${data.leadPosition}</span>
                </div>
                ` : ''}
                ${data.leadCompany ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Company:</span>
                  <span class="email-text" style="color: #111111; font-size: 15px;">${data.leadCompany}</span>
                </div>
                ` : ''}
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Status:</span>
                  <span class="email-text" style="color: #111111; font-size: 15px; text-transform: capitalize;">${data.leadStatus}</span>
                </div>
                ${data.leadOrigin ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Origin:</span>
                  <span class="email-text" style="color: #111111; font-size: 15px;">${formatLeadOrigin(data.leadOrigin)}</span>
                </div>
                ` : ''}
              </div>
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Brief</h3>
            <div class="email-panel" style="background-color: #f0f0f5; padding: 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
              <div class="email-text" style="color: #111111; font-size: 16px; line-height: 1.7;">${data.brief}</div>
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Next Steps</h3>
            <div style="background-color: #f0fdf4; padding: 24px; border-radius: 8px; border: 1px solid #bbf7d0;">
              <ul style="margin: 0; padding: 0 0 0 20px; color: #111111; font-size: 15px; line-height: 1.7;">${data.nextSteps.map(step => `<li style="margin-bottom: 8px;">${step}</li>`).join('')}</ul>
            </div>
          </div>
          ${data.dueDate ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Due Date</h3>
            <div style="background-color: #fef3c7; padding: 20px 24px; border-radius: 8px; border: 1px solid #fde047;">
              <div style="color: #92400e; font-size: 16px; font-weight: 600;">📅 ${new Date(data.dueDate).toLocaleDateString((data as any).locale === 'es' ? 'es-ES' : (data as any).locale === 'fr' ? 'fr-FR' : (data as any).locale === 'de' ? 'de-DE' : (data as any).locale === 'ja' ? 'ja-JP' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
            </div>
          </div>
          ` : ''}
          <div style="text-align: center; margin: 40px 0 32px;">
            ${data.leadUrl ? `
            <a href="${data.leadUrl}" class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; margin: 0 6px 12px; vertical-align: top;">View Lead Details →</a>
            ` : ''}
            ${data.replyEmail ? `
            <a href="mailto:${data.replyEmail}" style="display: inline-block; background: #ffffff; color: #000000; border: 2px solid #000000; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; transition: background-color 0.2s, color 0.2s; margin: 0 6px 12px; vertical-align: top;">Reply →</a>
            ` : ''}
            ${data.siteUrl ? `
            <a href="${data.siteUrl}" style="display: inline-block; background: #ffffff; color: #000000; border: 2px solid #000000; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; transition: background-color 0.2s, color 0.2s; margin: 0 6px 12px; vertical-align: top;">Visit Site →</a>
            ` : ''}
          </div>
        </div>
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; text-align: center; line-height: 1.5;">This lead assignment was automatically generated by ${getCompanyName()}.<br>Please contact your manager if you have any questions about this assignment.</p>
        </div>
      </div>
      <div style="text-align: center; margin: 24px 0;">
        <p class="email-subtle" style="margin: 0; color: #71717a; font-size: 12px;">Powered by <strong style="color: #000000;">${getBrandingText()}</strong></p>
      </div>
    </body>
    </html>
  `;
}

export function generateTeamNotificationHtml(data: {
  leadName: string;
  leadEmail?: string;
  assigneeName: string;
  assigneeEmail: string;
  brief: string;
  nextSteps: string[];
  priority: string;
  siteName: string;
  dueDate?: string;
  leadUrl?: string;
  logoUrl?: string;
  locale?: string;
}): string {
  const priorityColors = {
    low: { bg: '#f0f9ff', color: '#0369a1', border: '#7dd3fc' },
    normal: { bg: '#f8fafc', color: '#475569', border: '#cbd5e1' },
    high: { bg: '#fef3c7', color: '#d97706', border: '#fde047' },
    urgent: { bg: '#fee2e2', color: '#dc2626', border: '#fca5a5' }
  } as const;

  const priorityColor = priorityColors[data.priority as keyof typeof priorityColors];

  return `
    <!DOCTYPE html>
    <html lang="${data.locale || 'en'}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Lead Assignment Notification - ${data.siteName}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      <div class="email-card" style="max-width: 600px; margin: 40px auto; background-color: #fafafa; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden;">
        <div class="email-header" style="background: #1e1e2d; padding: 32px 40px; text-align: center;">
          ${data.logoUrl ? `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 16px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <img src="${data.logoUrl}" alt="${data.siteName} Logo" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background-color: #f0f0f5; display: block;" />
          </div>
          ` : `
          <div style="display: inline-block; background-color: rgba(255, 255, 255, 0.1); border-radius: 50%; padding: 24px; margin-bottom: 16px; width: 96px; height: 96px; box-sizing: border-box;">
            <div style="width: 48px; height: 48px; background-color: #f0f0f5; border-radius: 50%; position: relative; margin: 0 auto;">
              <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 16px; height: 16px; background-color: #90ff17; font-weight: 600; border-radius: 50%;"></div>
            </div>
          </div>
          `}
          <h1 style="margin: 0; color: #f0f0f5; font-size: 24px; font-weight: 600; letter-spacing: -0.025em;">Lead Assignment</h1>
          <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 16px; font-weight: 400;">Team notification</p>
        </div>
        <div style="padding: 40px;">
          <div style="margin-bottom: 32px; text-align: center;">
            <div class="email-badge" style="display: inline-block; background-color: ${priorityColor.bg}; color: ${priorityColor.color}; border: 1px solid ${priorityColor.border}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">${data.priority} Priority</div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Assignment Details</h3>
            <div class="email-panel" style="background-color: #f0f0f5; padding: 20px 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
              <div style="margin-bottom: 12px;">
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 80px;">Lead:</span>
                <span class="email-text" style="color: #111111; font-size: 15px;">${data.leadName}</span>
                ${data.leadEmail ? `<span style=\"color: #52525b; font-size: 14px; margin-left: 8px;\">(${data.leadEmail})</span>` : ''}
              </div>
              <div>
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #3f6212; min-width: 80px;">Assigned to:</span>
                <span class="email-text" style="color: #111111; font-size: 15px;">${data.assigneeName}</span>
                <span class="email-muted" style="color: #52525b; font-size: 14px; margin-left: 8px;">(${data.assigneeEmail})</span>
              </div>
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Brief</h3>
            <div class="email-panel" style="background-color: #f0f0f5; padding: 24px; border-radius: 8px; border: 1px solid #e4e4e7;">
              <div class="email-text" style="color: #111111; font-size: 16px; line-height: 1.7;">${data.brief}</div>
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Next Steps</h3>
            <div style="background-color: #f0fdf4; padding: 24px; border-radius: 8px; border: 1px solid #bbf7d0;">
              <ul style="margin: 0; padding: 0 0 0 20px; color: #111111; font-size: 15px; line-height: 1.7;">${data.nextSteps.map(step => `<li style=\"margin-bottom: 8px;\">${step}</li>`).join('')}</ul>
            </div>
          </div>
          ${data.dueDate ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #111111; font-weight: 600;">Due Date</h3>
            <div style="background-color: #fef3c7; padding: 20px 24px; border-radius: 8px; border: 1px solid #fde047;">
              <div style="color: #92400e; font-size: 16px; font-weight: 600;">📅 ${new Date(data.dueDate).toLocaleDateString((data as any).locale === 'es' ? 'es-ES' : (data as any).locale === 'fr' ? 'fr-FR' : (data as any).locale === 'de' ? 'de-DE' : (data as any).locale === 'ja' ? 'ja-JP' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
            </div>
          </div>
          ` : ''}
          ${data.leadUrl ? `
          <div style="text-align: center; margin: 40px 0 32px;">
            <a href="${data.leadUrl}" class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display: inline-block; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.025em; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); transition: transform 0.2s, box-shadow 0.2s; margin: 0 6px 12px; vertical-align: top;">View Lead Details →</a>
          </div>
          ` : ''}
        </div>
        <div style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0;">
          <p class="email-muted" style="margin: 0; color: #52525b; font-size: 14px; text-align: center; line-height: 1.5;">This notification was automatically generated by ${getCompanyName()}.<br>Manage your notification preferences in your account settings.</p>
        </div>
      </div>
      <div style="text-align: center; margin: 24px 0;">
        <p class="email-subtle" style="margin: 0; color: #71717a; font-size: 12px;">Powered by <strong style="color: #000000;">${getBrandingText()}</strong></p>
      </div>
    </body>
    </html>
  `;
}


