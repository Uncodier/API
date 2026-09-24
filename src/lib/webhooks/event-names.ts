export type WebhookMutationEvent = 'created' | 'updated' | 'deleted';

const TABLE_EVENT_NAMES: Readonly<Record<string, string>> = {
  content: 'content',
  conversations: 'conversation',
  deals: 'deal',
  leads: 'lead',
  messages: 'message',
  quotations: 'quotation',
  records: 'record',
  reservations: 'reservation',
  sales: 'sale',
  tasks: 'task',
};

export function isSupportedWebhookTable(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE_EVENT_NAMES, table);
}

export interface WebhookEventNames {
  canonical: string;
  aliases: string[];
}

export function buildWebhookEventNames(
  table: string,
  eventType: WebhookMutationEvent,
): WebhookEventNames {
  const resource = TABLE_EVENT_NAMES[table] || table;
  const canonical = `${resource}.${eventType}`;
  const legacyTableEvent = `${table}.${eventType}`;

  return {
    canonical,
    aliases: legacyTableEvent === canonical ? [] : [legacyTableEvent],
  };
}
