export interface ChannelOutcome {
  workflowId: string;
  state: 'accepted' | 'draft' | 'suppressed' | 'unknown' | 'failed';
  stage: 'admission' | 'generation' | 'delivery';
  reason: string;
  messageId?: string;
  conversationId?: string;
  sendWorkflowId?: string;
}

/** Fixed reason codes and server-generated IDs only; never log the content/contact. */
export class ChannelMessageReconciliationError extends Error {
  constructor(readonly report: ChannelOutcome) {
    super(`Channel reconciliation: ${JSON.stringify(report)}`);
  }
}
