export const TEMPLATE_REJECTED_ERROR_TYPE = 'TEMPLATE_REJECTED';

export const TERMINAL_WHATSAPP_APPROVAL_STATUSES = ['rejected', 'paused', 'disabled'] as const;

export type TerminalWhatsAppApprovalStatus = (typeof TERMINAL_WHATSAPP_APPROVAL_STATUSES)[number];

export function isTerminalWhatsAppApprovalStatus(
  status?: string | null,
): status is TerminalWhatsAppApprovalStatus {
  if (!status) return false;
  return (TERMINAL_WHATSAPP_APPROVAL_STATUSES as readonly string[]).includes(status.toLowerCase());
}

/** Templates that may be reused for a new send (not rejected/paused/disabled). */
export function isReusableWhatsAppTemplateStatus(status?: string | null): boolean {
  return !isTerminalWhatsAppApprovalStatus(status);
}

/** Drop rejected/paused/disabled rows so findExisting cannot reuse a dead SID. */
export function pickReusableWhatsAppTemplates<T extends { status?: string | null }>(
  templates: T[],
): T[] {
  return templates.filter((row) => isReusableWhatsAppTemplateStatus(row.status));
}

export function templateRejectedError(status?: string | null): {
  success: false;
  error: string;
  errorType: typeof TEMPLATE_REJECTED_ERROR_TYPE;
} {
  const label = status || 'rejected';
  return {
    success: false,
    error: `WhatsApp template approval is terminal (${label}). Do not retry this template.`,
    errorType: TEMPLATE_REJECTED_ERROR_TYPE,
  };
}
