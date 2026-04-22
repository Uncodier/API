import type { UncodieClient } from './client';

export interface SendEmailInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface SendEmailResult {
  delivered: boolean;
  id?: string;
  error?: string;
}

export function createEmailModule(client: UncodieClient) {
  return {
    send(input: SendEmailInput): Promise<SendEmailResult> {
      if (!input.to) throw new Error('[uncodie.email] `to` is required.');
      if (!input.subject) throw new Error('[uncodie.email] `subject` is required.');
      if (!input.html && !input.text) throw new Error('[uncodie.email] either `html` or `text` is required.');
      return client.post<SendEmailResult>('email/send', input);
    },
  };
}
