import {
  isTerminalWhatsAppApprovalStatus,
  isReusableWhatsAppTemplateStatus,
  pickReusableWhatsAppTemplates,
} from '../whatsappTemplateApproval';

describe('whatsappTemplateApproval', () => {
  it('treats rejected, paused and disabled as terminal', () => {
    expect(isTerminalWhatsAppApprovalStatus('rejected')).toBe(true);
    expect(isTerminalWhatsAppApprovalStatus('paused')).toBe(true);
    expect(isTerminalWhatsAppApprovalStatus('disabled')).toBe(true);
    expect(isTerminalWhatsAppApprovalStatus('REJECTED')).toBe(true);
  });

  it('treats pending, received and approved as non-terminal', () => {
    expect(isTerminalWhatsAppApprovalStatus('pending')).toBe(false);
    expect(isTerminalWhatsAppApprovalStatus('received')).toBe(false);
    expect(isTerminalWhatsAppApprovalStatus('approved')).toBe(false);
    expect(isTerminalWhatsAppApprovalStatus(null)).toBe(false);
    expect(isTerminalWhatsAppApprovalStatus(undefined)).toBe(false);
  });

  it('does not reuse terminal templates', () => {
    expect(isReusableWhatsAppTemplateStatus('rejected')).toBe(false);
    expect(isReusableWhatsAppTemplateStatus('active')).toBe(true);
    expect(isReusableWhatsAppTemplateStatus('approved')).toBe(true);
    expect(isReusableWhatsAppTemplateStatus(null)).toBe(true);
  });

  it('excludes rejected SIDs from findExisting candidates', () => {
    const reusable = pickReusableWhatsAppTemplates([
      { template_sid: 'HX-rejected', status: 'rejected' },
      { template_sid: 'HX-paused', status: 'paused' },
      { template_sid: 'HX-active', status: 'active' },
      { template_sid: 'HX-pending', status: 'pending' },
      { template_sid: 'HX-null', status: null },
    ]);
    expect(reusable.map((row) => row.template_sid)).toEqual([
      'HX-active',
      'HX-pending',
      'HX-null',
    ]);
  });
});
