import { EmailProcessingService } from './EmailProcessingService';

export interface PartitionedEmails {
  leads: any[];
  alias: any[];
  agent: any[];
}

export class EmailRoutingService {
  /**
   * Deterministic partition of emails so a message belongs to only one activity.
   * Priority: leads -> alias -> agent.
   */
  static async partition(validEmails: any[], emailConfig: any, siteId: string): Promise<PartitionedEmails> {
    const separation = await EmailProcessingService.separateEmailsByDestination(validEmails, emailConfig, siteId);

    // Ensure exclusivity by using separation outputs in priority order
    const leads = [...separation.emailsFromAILeads];

    // Exclude any email present in leads from alias bucket
    const leadIds = new Set<string>(leads.map(e => (e?.id || e?.uid || e?.messageId || '').toString()));
    const alias = separation.emailsToAliases.filter(e => !leadIds.has((e?.id || e?.uid || e?.messageId || '').toString()));

    // Exclude emails already routed to leads or alias from agent bucket
    const aliasIds = new Set<string>(alias.map(e => (e?.id || e?.uid || e?.messageId || '').toString()));
    const agent = separation.emailsToAgent.filter(e => {
      const id = (e?.id || e?.uid || e?.messageId || '').toString();
      return !leadIds.has(id) && !aliasIds.has(id);
    });

    return { leads, alias, agent };
  }
}


