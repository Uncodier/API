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
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
<style type="text/css">
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
            <h2 class="email-heading" style="margin: 0 0 16px; font-size: 20px; color: #1e293b; font-weight: 600;">Hello ${data.assigneeName}</h2>
            <p class="email-text" style="margin: 0; font-size: 16px; color: #475569; line-height: 1.7;">You have been assigned a new lead from ${data.siteName}. Please review the information below and take the necessary next steps.</p>
          </div>
          <div style="margin-bottom: 32px; text-align: center;">
            <div class="email-badge" style="display: inline-block; background-color: ${priorityColor.bg}; color: ${priorityColor.color}; border: 1px solid ${priorityColor.border}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">${data.priority} Priority</div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Lead Information</h3>
            <div style="background-color: #f8fafc; padding: 24px; border-radius: 8px; border-left: 4px solid #90ff17;">
              <div style="display: grid; gap: 12px;">
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Name:</span>
                  <span class="email-text" style="color: #1e293b; font-size: 15px;">${data.leadName}</span>
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
                  <span class="email-text" style="color: #1e293b; font-size: 15px;">${data.leadPosition}</span>
                </div>
                ` : ''}
                ${data.leadCompany ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Company:</span>
                  <span class="email-text" style="color: #1e293b; font-size: 15px;">${data.leadCompany}</span>
                </div>
                ` : ''}
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Status:</span>
                  <span class="email-text" style="color: #1e293b; font-size: 15px; text-transform: capitalize;">${data.leadStatus}</span>
                </div>
                ${data.leadOrigin ? `
                <div>
                  <span style="display: inline-block; font-weight: 600; color: #000000; font-weight: 600; min-width: 80px;">Origin:</span>
                  <span class="email-text" style="color: #1e293b; font-size: 15px;">${formatLeadOrigin(data.leadOrigin)}</span>
                </div>
                ` : ''}
              </div>
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Brief</h3>
            <div style="background-color: #eff6ff; padding: 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              <div class="email-text" style="color: #1e293b; font-size: 16px; line-height: 1.7;">${data.brief}</div>
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Next Steps</h3>
            <div style="background-color: #f0fdf4; padding: 24px; border-radius: 8px; border: 1px solid #bbf7d0;">
              <ul style="margin: 0; padding: 0 0 0 20px; color: #1e293b; font-size: 15px; line-height: 1.7;">${data.nextSteps.map(step => `<li style="margin-bottom: 8px;">${step}</li>`).join('')}</ul>
            </div>
          </div>
          ${data.dueDate ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Due Date</h3>
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
          <p class="email-muted" style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">This lead assignment was automatically generated by ${getCompanyName()}.<br>Please contact your manager if you have any questions about this assignment.</p>
        </div>
      </div>
      <div style="text-align: center; margin: 24px 0;">
        <p class="email-subtle" style="margin: 0; color: #94a3b8; font-size: 12px;">Powered by <strong style="color: #000000;">${getBrandingText()}</strong></p>
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
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Assignment Details</h3>
            <div style="background-color: #eff6ff; padding: 20px 24px; border-radius: 8px; border: 1px solid #bfdbfe;">
              <div style="margin-bottom: 12px;">
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 80px;">Lead:</span>
                <span class="email-text" style="color: #1e293b; font-size: 15px;">${data.leadName}</span>
                ${data.leadEmail ? `<span style=\"color: #64748b; font-size: 14px; margin-left: 8px;\">(${data.leadEmail})</span>` : ''}
              </div>
              <div>
                <span class="email-label" style="display: inline-block; font-weight: 600; color: #1e40af; min-width: 80px;">Assigned to:</span>
                <span class="email-text" style="color: #1e293b; font-size: 15px;">${data.assigneeName}</span>
                <span class="email-muted" style="color: #64748b; font-size: 14px; margin-left: 8px;">(${data.assigneeEmail})</span>
              </div>
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Brief</h3>
            <div style="background-color: #f1f5f9; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
              <div class="email-text" style="color: #1e293b; font-size: 16px; line-height: 1.7;">${data.brief}</div>
            </div>
          </div>
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Next Steps</h3>
            <div style="background-color: #f0fdf4; padding: 24px; border-radius: 8px; border: 1px solid #bbf7d0;">
              <ul style="margin: 0; padding: 0 0 0 20px; color: #1e293b; font-size: 15px; line-height: 1.7;">${data.nextSteps.map(step => `<li style=\"margin-bottom: 8px;\">${step}</li>`).join('')}</ul>
            </div>
          </div>
          ${data.dueDate ? `
          <div style="margin-bottom: 32px;">
            <h3 class="email-heading" style="margin: 0 0 16px; font-size: 18px; color: #1e293b; font-weight: 600;">Due Date</h3>
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
          <p class="email-muted" style="margin: 0; color: #64748b; font-size: 14px; text-align: center; line-height: 1.5;">This notification was automatically generated by ${getCompanyName()}.<br>Manage your notification preferences in your account settings.</p>
        </div>
      </div>
      <div style="text-align: center; margin: 24px 0;">
        <p class="email-subtle" style="margin: 0; color: #94a3b8; font-size: 12px;">Powered by <strong style="color: #000000;">${getBrandingText()}</strong></p>
      </div>
    </body>
    </html>
  `;
}


