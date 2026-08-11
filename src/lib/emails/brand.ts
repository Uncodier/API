/**
 * Makinari email brand tokens (from market-fit).
 *
 * App accents:
 * - CTAs / selected chips: black ↔ white by theme
 * - Accent / badges / alerts: lime #90ff17 (hover #ffdc24)
 * - Surfaces: neutral grays (#f0f0f5, #1e1e2d, #2d2d3d) — not purple
 */

export const EMAIL_BRAND = {
  black: '#000000',
  white: '#ffffff',

  /** Brand accent (tailwind primary-button) */
  accent: '#90ff17',
  accentHover: '#ffdc24',
  accentText: '#000000',
  accentSoft: '#f4ffe5',
  accentBorder: '#c6f08a',
  accentMuted: '#3f6212',

  headerBg: '#1e1e2d',
  headerText: '#f0f0f5',
  headerMuted: '#a1a1aa',
  bodyBg: '#f5f5f7',
  cardBg: '#fafafa',
  text: '#334155',
  muted: '#64748b',
  subtle: '#94a3b8',
  surface: '#f0f0f5',
  surfaceBorder: '#e4e4e7',
  surfaceText: '#1e1e2d',

  /** Soft panel (light) / dark panel — app grays, not violet */
  panelBg: '#f0f0f5',
  panelBorder: '#e4e4e7',

  /** Chips: lime + black (readable in light + dark Mail) */
  badgeBg: '#90ff17',
  badgeText: '#000000',

  darkSurface: '#1e1e2d',
  darkSurfaceBorder: '#2d2d3d',
  darkSurfaceText: '#e2e8f0',
  link: '#000000',
  linkDark: '#ffffff',

  // Back-compat aliases (point to gray/lime, not purple)
  purple: '#90ff17',
  purpleSoft: '#f0f0f5',
  purpleBorder: '#e4e4e7',
  purpleText: '#3f6212',
} as const;

/**
 * Light text colors live ONLY inside prefers-color-scheme: light so they cannot
 * override dark-mode rules (Apple Mail was keeping dark labels on dark cards).
 */
export const EMAIL_BRAND_STYLE = `
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
`;

export function emailBrandHeadTags(): string {
  return `
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <style type="text/css">${EMAIL_BRAND_STYLE}</style>`;
}

export const EMAIL_CTA_STYLE_SNIPPET = EMAIL_BRAND_STYLE;

/**
 * Status / role / priority chip only (not for freeform meta like job title).
 * Brand lime + black text — matches app primary-button accent.
 */
export function emailBadge(labelHtml: string): string {
  return `<span class="email-badge" style="display:inline-block;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;background-color:${EMAIL_BRAND.badgeBg};background-image:linear-gradient(${EMAIL_BRAND.badgeBg},${EMAIL_BRAND.badgeBg});box-shadow:inset 0 0 0 999px ${EMAIL_BRAND.badgeBg};color:${EMAIL_BRAND.badgeText};-webkit-text-fill-color:${EMAIL_BRAND.badgeText};">${labelHtml}</span>`;
}

export interface EmailCtaOptions {
  padding?: string;
  fontSize?: string;
  borderRadius?: string;
  fullWidth?: boolean;
}

export function emailCtaButton(href: string, label: string, options: EmailCtaOptions = {}): string {
  const padding = options.padding || '14px 28px';
  const fontSize = options.fontSize || '16px';
  const borderRadius = options.borderRadius || '8px';
  const widthAttr = options.fullWidth ? ' width="100%"' : '';

  return `
      <div style="margin:32px 0;text-align:center;">
        <table${widthAttr} border="0" cellspacing="0" cellpadding="0" role="presentation" style="${options.fullWidth ? 'width:100%;' : 'margin:0 auto;'}">
          <tr>
            <td align="center" bgcolor="${EMAIL_BRAND.black}" class="email-cta-td"
                style="border-radius:${borderRadius};background-color:${EMAIL_BRAND.black};background-image:linear-gradient(${EMAIL_BRAND.black},${EMAIL_BRAND.black});">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${href}" style="height:48px;v-text-anchor:middle;width:200px;" arcsize="17%" stroke="f" fillcolor="${EMAIL_BRAND.black}">
                <w:anchorlock/>
                <center style="color:${EMAIL_BRAND.white};font-family:sans-serif;font-size:${fontSize};font-weight:600;">
                  ${label}
                </center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a href="${href}" target="_blank" class="email-cta"
                 style="display:inline-block;padding:${padding};font-size:${fontSize};font-weight:600;line-height:1.2;color:${EMAIL_BRAND.white};text-decoration:none;border:0;border-radius:${borderRadius};background-color:${EMAIL_BRAND.black};background-image:linear-gradient(${EMAIL_BRAND.black},${EMAIL_BRAND.black});box-shadow:inset 0 0 0 999px ${EMAIL_BRAND.black};-webkit-text-size-adjust:none;">
                <span class="email-cta-label" style="color:${EMAIL_BRAND.white};font-weight:600;">${label}</span>
              </a>
              <!--<![endif]-->
            </td>
          </tr>
        </table>
      </div>`;
}

export function emailCodeBlock(labelHtml: string, codeHtml: string): string {
  return `
      <div class="email-code-box" style="margin:28px 0;padding:20px;background-color:${EMAIL_BRAND.accentSoft};background-image:linear-gradient(${EMAIL_BRAND.accentSoft},${EMAIL_BRAND.accentSoft});border:1px solid ${EMAIL_BRAND.accentBorder};border-radius:12px;text-align:center;">
        <p class="email-code-label" style="margin:0 0 8px;color:${EMAIL_BRAND.accentMuted};font-size:14px;">${labelHtml}</p>
        <p class="email-code-value" style="margin:0;font-size:32px;letter-spacing:0.35em;font-weight:700;color:${EMAIL_BRAND.surfaceText};font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">
          ${codeHtml}
        </p>
      </div>`;
}

export function emailCtaInlineStyle(extra = ''): string {
  return `class="email-cta" style="display:inline-block;padding:14px 28px;background-color:${EMAIL_BRAND.black};background-image:linear-gradient(${EMAIL_BRAND.black},${EMAIL_BRAND.black});box-shadow:inset 0 0 0 999px ${EMAIL_BRAND.black};color:${EMAIL_BRAND.white};border:0;text-decoration:none;font-weight:600;border-radius:8px;${extra}"`;
}
