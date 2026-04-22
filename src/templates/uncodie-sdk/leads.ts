import type { UncodieClient } from './client';

export interface LeadSummary {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  status: string;
  tags: string[];
  created_at: string;
}

export interface CreateLeadInput {
  email: string;
  name?: string;
  phone?: string;
  status?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export function createLeadsModule(client: UncodieClient) {
  return {
    list(limit: number = 50): Promise<{ leads: LeadSummary[]; count: number }> {
      return client.get(`leads?limit=${Math.min(200, Math.max(1, limit))}`);
    },
    create(input: CreateLeadInput): Promise<{ id: string; email: string }> {
      if (!input.email) throw new Error('[uncodie.leads] `email` is required.');
      return client.post('leads', input);
    },
  };
}
