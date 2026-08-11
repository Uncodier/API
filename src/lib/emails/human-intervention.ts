import { EmailSendService } from '@/lib/services/email/EmailSendService';
import type { EmailLocale } from '@/lib/i18n/email-locale';
import { DEFAULT_EMAIL_LOCALE } from '@/lib/i18n/email-locale';
import { platformT } from '@/lib/i18n/email-messages/platform';

export interface HumanInterventionEmailData {
  conversationId: string;
  message: string;
  priority: string;
  agentName?: string;
  summary?: string;
  contactName?: string;
  contactEmail?: string;
  conversationUrl: string;
  locale?: EmailLocale;
}

function getCompanyName(): string {
  return process.env.UNCODIE_COMPANY_NAME || 'Makinari';
}

function getBrandingText(): string {
  return process.env.UNCODIE_BRANDING_TEXT || 'Makinari, your AI Sales Team';
}

export function generateHumanInterventionEmailHtml(data: HumanInterventionEmailData): string {
  const locale = data.locale || DEFAULT_EMAIL_LOCALE;
  const title = platformT(locale, 'human_intervention.title');
  const agentText = data.agentName
    ? EmailSendService.escapeHtml(data.agentName)
    : 'System';

  const priorityConfig = {
    low: { color: '#10b981', bg: '#ecfdf5', label: 'Low' },
    normal: { color: '#3b82f6', bg: '#eff6ff', label: 'Normal' },
    high: { color: '#f59e0b', bg: '#fffbeb', label: 'High' },
    urgent: { color: '#ef4444', bg: '#fef2f2', label: 'Urgent' },
  };

  const priority = priorityConfig[data.priority as keyof typeof priorityConfig] || priorityConfig.normal;
  const hasContactInfo = data.contactName || data.contactEmail;

  return `
    <!DOCTYPE html>
    <html lang="${locale}">
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
      <title>${EmailSendService.escapeHtml(title)}</title>
    </head>
    <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;line-height:1.6;">
      <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.1);overflow:hidden;">
        <div style="background: #000000;padding:32px 40px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:600;">${EmailSendService.escapeHtml(title)}</h1>
        </div>
        <div style="padding:40px;">
          <div style="margin-bottom:24px;">
            <span class="email-badge" style="display:inline-block;background:${priority.bg};color:${priority.color};padding:8px 16px;border-radius:20px;font-size:14px;font-weight:600;">
              ${priority.label}
            </span>
          </div>
          <p class="email-text" style="margin:0 0 16px;font-size:16px;color:#1e293b;">${agentText}</p>
          <div style="background:#f8fafc;border-left: 4px solid #90ff17;padding:20px 24px;border-radius:0 8px 8px 0;margin:24px 0;">
            <p class="email-text" style="margin:0;font-size:16px;color:#475569;font-style:italic;">
              "${EmailSendService.escapeHtml(data.message)}"
            </p>
          </div>
          ${data.summary ? `<div style="margin-bottom:24px;">${EmailSendService.renderMessageWithLists(data.summary)}</div>` : ''}
          ${hasContactInfo ? `
            <div style="margin-bottom:24px;background:#eff6ff;padding:16px;border-radius:8px;">
              ${data.contactName ? `<div>${EmailSendService.escapeHtml(data.contactName)}</div>` : ''}
              ${data.contactEmail ? `<div>${EmailSendService.escapeHtml(data.contactEmail)}</div>` : ''}
            </div>
          ` : ''}
          <div style="text-align:center;margin:32px 0;">
            <a href="${EmailSendService.escapeAttr(data.conversationUrl)}"
               class="email-cta" style="background: #000000; background-color: #000000; background-image: linear-gradient(#000000, #000000); box-shadow: inset 0 0 0 999px #000000; color: #ffffff; border: 0; display:inline-block; padding:14px 28px; text-decoration:none; border-radius:8px; font-weight:600;">
              →
            </a>
          </div>
          <p class="email-muted" style="text-align:center;color:#64748b;font-size:12px;">
            ${EmailSendService.escapeHtml(data.conversationId)}
          </p>
        </div>
        <div class="email-muted" style="background:#f8fafc;padding:20px;text-align:center;color:#64748b;font-size:13px;">
          ${EmailSendService.escapeHtml(getCompanyName())} · ${EmailSendService.escapeHtml(getBrandingText())}
        </div>
      </div>
    </body>
    </html>
  `;
}
