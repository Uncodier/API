/**
 * Makinari email brand tokens (market-fit).
 *
 * Design rules (minimize client contrast bugs):
 * - color-scheme: light only — Apple/Gmail dark mode was leaving light text on light boxes
 * - Few surfaces: header dark, card light, one optional panel gray
 * - Body text always near-black on light surfaces (inline + CSS)
 * - CTAs: solid black; badges: lime + black
 */

export const EMAIL_BRAND = {
  black: '#000000',
  white: '#ffffff',

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
  cardBg: '#ffffff',
  text: '#111111',
  muted: '#52525b',
  subtle: '#71717a',
  surface: '#f0f0f5',
  surfaceBorder: '#e4e4e7',
  surfaceText: '#111111',

  panelBg: '#f0f0f5',
  panelBorder: '#e4e4e7',

  badgeBg: '#90ff17',
  badgeText: '#000000',

  darkSurface: '#1e1e2d',
  darkSurfaceBorder: '#2d2d3d',
  darkSurfaceText: '#e2e8f0',
  link: '#000000',
  linkDark: '#000000',

  // Back-compat aliases
  purple: '#90ff17',
  purpleSoft: '#f0f0f5',
  purpleBorder: '#e4e4e7',
  purpleText: '#3f6212',
} as const;

/**
 * Light-only stylesheet. Avoids prefers-color-scheme dark overrides that
 * paint #e2e8f0 text onto nested light boxes Mail leaves un-inverted.
 */
export const EMAIL_BRAND_STYLE = `
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
`;

export function emailBrandHeadTags(): string {
  return `
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
  <style type="text/css">${EMAIL_BRAND_STYLE}</style>`;
}

export const EMAIL_CTA_STYLE_SNIPPET = EMAIL_BRAND_STYLE;

/**
 * Status / role / priority chip only (not for freeform meta like job title).
 */
export function emailBadge(labelHtml: string): string {
  return `<span class="email-badge" style="display:inline-block;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;background-color:${EMAIL_BRAND.badgeBg};background-image:linear-gradient(${EMAIL_BRAND.badgeBg},${EMAIL_BRAND.badgeBg});box-shadow:inset 0 0 0 999px ${EMAIL_BRAND.badgeBg};color:${EMAIL_BRAND.badgeText};-webkit-text-fill-color:${EMAIL_BRAND.badgeText};">${labelHtml}</span>`;
}

/** Simple gray content panel — always dark text on light gray. */
export function emailPanelOpen(extraStyle = ''): string {
  return `<div class="email-panel" style="background-color:${EMAIL_BRAND.panelBg};background-image:linear-gradient(${EMAIL_BRAND.panelBg},${EMAIL_BRAND.panelBg});padding:20px 24px;border-radius:8px;border:1px solid ${EMAIL_BRAND.panelBorder};color:${EMAIL_BRAND.text};${extraStyle}">`;
}

export function emailPanelClose(): string {
  return `</div>`;
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
